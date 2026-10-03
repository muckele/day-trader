import CryptoKit
import Foundation
import Testing
@testable import AcceptanceCore

private final class BootstrapTestClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock(); private var samples:[ClockSample]; private var last:ClockSample
    init(_ values:[ClockSample] = [ClockSample(wall:100,monotonic:10)]) {
        samples = values; last = values.last!
    }
    func sample() throws -> ClockSample { lock.withLock { if !samples.isEmpty { last = samples.removeFirst() }; return last } }
    func replace(_ values:[ClockSample]) { lock.withLock { samples=values; if let value=values.last { last=value } } }
    func wait(milliseconds:Int) async throws {}
}

private final class BootstrapProbeFake: BootstrapProbePort, @unchecked Sendable {
    private var values:[Data]; var requested = [[BootstrapProbeID]]()
    var onCapture:(@Sendable () throws -> Void)?
    init(_ values:[Data]) { self.values = values }
    func capture(ids:[BootstrapProbeID]) throws -> Data {
        requested.append(ids)
        try onCapture?()
        guard !values.isEmpty else { throw VMFailure.admissionUnavailable }
        return values.count == 1 ? values[0]:values.removeFirst()
    }
}

private final class BootstrapLifecycleFake: BootstrapLifecyclePort, BootstrapOwnedLifecycle, @unchecked Sendable {
    private var drift:(@Sendable () -> Void)?; var starts = 0, stops = 0, driftOnBegin = false
    var onBegin:(@Sendable () -> Void)?
    func begin(handoff:Data,onDrift:@escaping @Sendable () -> Void) throws -> any BootstrapOwnedLifecycle {
        starts += 1; drift = onDrift; onBegin?(); if driftOnBegin { onDrift() }; return self
    }
    var bounds:[Int] = [], onStop:(@Sendable () -> Void)?
    func stopOwned(deadline:Int) throws -> BootstrapStopOutcome {
        stops += 1; bounds.append(deadline); onStop?(); return .stopped
    }
    func triggerDrift() { drift?() }
}

private final class BootstrapRoleHandleFake: BootstrapActivationTransaction, @unchecked Sendable {
    var stops = 0
    var calls = 0, callback:(@Sendable () throws -> Void)?
    var afterEffect:(@Sendable () throws -> Void)?, uncertain = false
    var bounds:[Int] = [], onStop:(@Sendable () -> Void)?
    func activate(authorize:@escaping @Sendable () throws -> Void) throws {
        try callback?(); try authorize(); calls += 1; try afterEffect?()
    }
    func stopOwned(deadline:Int) throws -> BootstrapStopOutcome { stops += 1; bounds.append(deadline); onStop?(); return uncertain ? .uncertain:.stopped }
}

private final class BootstrapActivationFake: BootstrapActivationPort, @unchecked Sendable {
    let handle = BootstrapRoleHandleFake()
    var onCleanup:(@Sendable () -> Void)?, preparations = 0
    var cleanup:any BootstrapActivationTransaction { onCleanup?(); return handle }
    var onPrepare:(@Sendable () throws -> Void)?
    func prepareBrowser(proof:AdmissionProof) throws -> any BootstrapActivationTransaction {
        preparations += 1; try onPrepare?(); return handle
    }
}

private struct BootstrapRunFixture {
    let run:RunConfiguration
    init() throws {
        let applianceFixture = try ApplianceFixture()
        var applianceObject = applianceFixture.object
        var components = applianceObject["components"] as! [[String:Any]]
        for (index,id) in ["controller","guestBootstrap","guestProbes","proxy","rolePolicy","routePolicy","seccompPolicy","verifier"].enumerated() {
            if components.contains(where:{ $0["id"] as? String == id }) { continue }
            components.append(["id":id,"sha256":String(repeating:String(index + 1),count:64),
                               "sizeBytes":index + 1,"sourceId":"task10-independent-" + id,"version":"task10-v1"])
        }
        applianceObject["components"] = components.sorted { ($0["id"] as! String) < ($1["id"] as! String) }
        applianceObject["missingPayload"] = []; applianceObject["payloadState"] = "COMPLETE"
        let manifest = try ApplianceManifest.decode(try applianceFixture.wire(applianceObject))
        let appliance = try manifest.verifyArtifacts(locations:applianceFixture.locations,
                                                      expectedManifestDigest:manifest.digest)
        let fixture = try BrokerTests.fixture()
        let options = fixture["options"] as! [String:Any]
        let expected = options["expected"] as! [String:[String:Any]]
        let keys = options["publicKeys"] as! [String:String]
        var template = expected["RELEASE_RECEIPT"]!, payload = template["payload"] as! [String:Any]
        payload["issuedAt"] = 0; payload["expiresAt"] = 1
        payload["keyId"] = String(repeating:"0",count:64)
        payload["signature"] = String(repeating:"0",count:128); template["payload"] = payload
        func record(_ data:Data) -> Data { Data([UInt8(data.count >> 8),UInt8(data.count & 255)]) + data }
        var bytes = Data("ABR1".utf8)
        bytes += record(try JSONSerialization.data(withJSONObject:template))
        bytes += record(try BrokerTests.candidate(fixture)); bytes += BrokerTests.hex(keys["RELEASE_RECEIPT"]!)
        bytes += Data(repeating:0x11,count:16) + Data(repeating:7,count:32)
        bytes += BrokerTests.hex(appliance.manifest.digest) + Data(repeating:0xaa,count:32)
        for value in [100,0,300,190,10000,20,30,1] { var number = UInt64(value).bigEndian; bytes.append(withUnsafeBytes(of:&number) { Data($0) }) }
        var facts = [DescriptorFacts]()
        for descriptor in 0...35 {
            facts.append(DescriptorFacts(fd:Int32(descriptor),kind:descriptor < 3 ? .null:.pipe,
                direction:descriptor == 3 || descriptor % 2 == 0 ? 0:1,
                uid:501,device:1,inode:UInt64(descriptor),tty:false))
        }
        let broker = (3...35).map { descriptor in OwnedVMChannel(
            purpose:descriptor == 3 ? .bootstrap:.relay((descriptor-4)/2,descriptor % 2 == 0),
            facts:facts[descriptor],dispose:{}) }
        let console = [OwnedVMChannel.Purpose.serialInput,.serialOutput,.terminal].enumerated().map { index,purpose in
            OwnedVMChannel(purpose:purpose,facts:DescriptorFacts(fd:Int32(100+index),kind:.pipe,
                direction:index == 1 ? 1:0,uid:501,device:1,inode:UInt64(100+index),tty:false),dispose:{}) }
        run = RunConfiguration(appliance:appliance,bootstrap:try BootstrapConfiguration.decode(bytes),
            channels:VMChannelSet(brokerFacts:facts,broker:broker,console:console,uid:501),capability:Data(repeating:7,count:32))
    }
}

private func canonical(_ object:Any) throws -> Data {
    try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.withoutEscapingSlashes])
}

private func resign(_ payload:[String:Any], capability:Data) throws -> Data {
    let bytes = try canonical(payload)
    let mac = HMAC<SHA256>.authenticationCode(for:bytes,using:SymmetricKey(data:capability))
        .map { String(format:"%02x",$0) }.joined()
    return try canonical(["mac":mac,"payload":payload,"version":1])
}

private let pythonProgramPins:[String:String] = Dictionary(uniqueKeysWithValues:[
    "/opt/acceptance/guest/browser-worker.cjs","/opt/acceptance/guest/controller.cjs",
    "/opt/acceptance/guest/proxy.py","/opt/acceptance/guest/verifier.cjs",
    "/opt/acceptance/runtime/chromium/chrome","/opt/acceptance/runtime/node/bin/node",
    "/opt/acceptance/runtime/python/bin/python3",
].enumerated().map { ($0.element,String(repeating:String($0.offset + 1),count:64)) })

private final class MemberInspectorFake: @unchecked Sendable {
    let values:[BootstrapExecutableMember:String]
    let artifacts:[String:String]
    init(_ values:[BootstrapExecutableMember:String], artifacts:[String:String]) { self.values=values; self.artifacts=artifacts }
    func artifactSHA256(componentID:String) throws -> String { try #require(artifacts[componentID]) }
    func installedPath(componentID:String,memberPath:String) throws -> String {
        try #require(values.keys.first { $0.componentID == componentID && $0.memberPath == memberPath }?.path)
    }
    func sha256(componentID:String,memberPath:String) throws -> String {
        try #require(values.first(where:{ $0.key.componentID == componentID && $0.key.memberPath == memberPath })?.value)
    }
}

private func executableAuthority(_ run:RunConfiguration) throws -> BootstrapExecutableAuthority {
    try BootstrapExecutableAuthority.offlineLiteral(pins:pythonProgramPins)
}

// Deliberately unsupported literal mapping, independent of production tables.
// Even an inspector willing to assert it must not create qualified authority.
private func unapprovedExecutableAuthority(_ run:RunConfiguration) throws -> BootstrapExecutableAuthority {
    let members:[BootstrapExecutableMember] = [
        .init(path:"/opt/acceptance/guest/browser-worker.cjs",componentID:"guestProbes",memberPath:"browser-worker.cjs"),
        .init(path:"/opt/acceptance/guest/controller.cjs",componentID:"controller",memberPath:""),
        .init(path:"/opt/acceptance/guest/proxy.py",componentID:"proxy",memberPath:""),
        .init(path:"/opt/acceptance/guest/verifier.cjs",componentID:"verifier",memberPath:""),
        .init(path:"/opt/acceptance/runtime/chromium/chrome",componentID:"chromium",memberPath:"chrome"),
        .init(path:"/opt/acceptance/runtime/node/bin/node",componentID:"node",memberPath:"bin/node"),
        .init(path:"/opt/acceptance/runtime/python/bin/python3",componentID:"python",memberPath:"bin/python3"),
    ]
    let object = try JSONSerialization.jsonObject(with:run.appliance.manifest.canonicalBytes()) as! [String:Any]
    let artifacts = Dictionary(uniqueKeysWithValues:(object["components"] as! [[String:Any]]).map { ($0["id"] as! String,$0["sha256"] as! String) })
    let values = Dictionary(uniqueKeysWithValues:members.enumerated().map {
        ($0.element,$0.element.memberPath.isEmpty ? artifacts[$0.element.componentID]! : String(repeating:"abcdef0".map(String.init)[$0.offset],count:64))
    })
    do {
        let inventory=try InstalledExecutableInventory.requireNative(MemberInspectorFake(values,artifacts:artifacts))
        return try BootstrapExecutableAuthority.qualify(manifest:run.appliance.manifest,inventory:inventory)
    } catch { throw VMFailure.admissionUnavailable }
}

private func pythonFixture() throws -> [String:Any] {
    let path = try #require(ProcessInfo.processInfo.environment["TASK10_TOPOLOGY_INPUT"])
    let object = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path)))
    let envelope = try #require(object as? [String:Any])
    return try #require(envelope["payload"] as? [String:Any])
}

private func handoff(_ run:RunConfiguration, sequence:Int = 1,
                     wall:Int = 100, monotonic:Int = 10,
                     mutate:(([String:Any]) -> [String:Any])? = nil) throws -> Data {
    var payload = try pythonFixture()
    payload["runId"] = run.binding.runID; payload["manifestIdentity"] = run.appliance.manifest.digest
    payload["configIdentity"] = run.binding.configIdentity; payload["expiresAt"] = run.binding.expiresAt
    payload["sequence"] = sequence; payload["observedWall"] = wall; payload["observedMonotonic"] = monotonic
    var proxy = payload["proxy"] as! [String:Any]
    proxy["runId"] = run.binding.runID; proxy["manifestIdentity"] = run.appliance.manifest.digest
    proxy["configIdentity"] = run.binding.configIdentity; proxy["expiresAt"] = run.binding.expiresAt
    payload["proxy"] = proxy
    var roles = payload["roles"] as! [[String:Any]]
    let programPins = try executableAuthority(run).pins
    for index in roles.indices { roles[index]["runId"] = run.binding.runID
        var fds = roles[index]["fds"] as! [[String:Any]]
        for fdIndex in fds.indices { fds[fdIndex]["runId"] = run.binding.runID }
        roles[index]["fds"] = fds
        var programs = roles[index]["programs"] as! [[String:Any]]
        for programIndex in programs.indices {
            programs[programIndex]["sha256"] = programPins[programs[programIndex]["path"] as! String]!
        }
        roles[index]["programs"] = programs }
    payload["roles"] = roles
    return try resign(mutate?(payload) ?? payload,capability:run.capability)
}

@Suite(.serialized) struct BootstrapGateTests {
    private func runtimeRows() -> [[String:Any]] {
        ["CONTROLLER","BROWSER","VERIFIER","PROXY"].enumerated().map { index,role in
            var fds:[[String:Any]] = []
            for fd in 0...4 {
                let identity = index * 100 + fd + 1
                let kind = fd < 3 ? "NULL" : (fd == 3 ? "COMMAND" : "RESULT")
                let row:[String:Any] = ["fd":fd,"kind":kind,"device":"1","inode":String(identity),
                    "flags":fd == 3 || fd == 0 ? 0:1,"ownerId":String(format:"%032x",identity),"acquiredGeneration":1]
                fds.append(row)
            }
            if role == "PROXY" { fds.append(["fd":8,"kind":"PROXY_LISTENER","device":"9","inode":"900",
                "flags":2,"ownerId":String(repeating:"f",count:32),"acquiredGeneration":1]) }
            return ["role":role,"childId":String(format:"%032x",index + 50),"pipeId":String(format:"%032x",index + 60),
                "lifecycle":index == 0 || index == 3 ? "SERVICE":"WAITING","inheritedFDs":[0,1,2,3,4],"currentFDs":fds]
        }
    }
    @Test func v1_current_role_inventory_is_not_inherited_fd_list() throws {
        let rows = runtimeRows()
        #expect(throws:Never.self) { try BootstrapHandoff.validateRoleRuntimeV1(rows,originals:rows,generation:1) }
        var missing = rows; var proxy = missing[3]["currentFDs"] as! [[String:Any]]
        proxy.removeLast(); missing[3]["currentFDs"] = proxy
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(missing,originals:rows,generation:1) }
    }
    @Test func v1_service_lifecycle_unknown_runtime_fd_denied() throws {
        let rows = runtimeRows()
        var waiting = rows; waiting[3]["lifecycle"] = "WAITING"
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(waiting,originals:rows,generation:1) }
        var unknown = rows; var fds = unknown[3]["currentFDs"] as! [[String:Any]]
        fds.append(["fd":9,"kind":"RUNTIME_INTERNAL","device":"9","inode":"901","flags":0,
                    "ownerId":String(repeating:"e",count:32),"acquiredGeneration":1]); unknown[3]["currentFDs"] = fds
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(unknown,originals:unknown,generation:1) }
    }
    @Test func v1_runtime_original_identity_primitive_and_completeness_required() throws {
        let rows = runtimeRows()
        for key in ["childId","pipeId","lifecycle","extra"] {
            var changed = rows; changed[3][key] = "WAITING"
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:rows,generation:1) }
        }
        let mutations:[(String,Any)] = [("fd",true),("fd",4096),("fd",4),("kind","PROXY_LISTENER"),("device","01"),
            ("inode","18446744073709551616"),("flags",true),("flags",-1),("flags",NSNumber(value:1.5)),("ownerId",String(repeating:"0",count:32)),
            ("acquiredGeneration",0),("acquiredGeneration",2),("extra",0)]
        for (key,value) in mutations {
            var changed = rows, fds = rows[3]["currentFDs"] as! [[String:Any]]
            fds[0][key] = value; changed[3]["currentFDs"] = fds
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:rows,generation:1) }
            if key != "ownerId" {
                #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:changed,generation:1) }
            }
        }
        for variant in 0...3 {
            var changed = rows, fds = rows[3]["currentFDs"] as! [[String:Any]]
            switch variant {
            case 0: fds.append(fds.last!)
            case 1: fds.reverse()
            case 2: fds.remove(at:3)
            default: var listener = fds.last!; listener["fd"] = 9; listener["inode"] = "901"; listener["ownerId"] = String(repeating:"e",count:32); fds.append(listener)
            }
            changed[3]["currentFDs"] = fds
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:changed,generation:1) }
        }
        var inherited = rows; inherited[3]["inheritedFDs"] = [0,1,2,3,true]
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(inherited,originals:inherited,generation:1) }
    }
    @Test func v1_service_role_facts_preserve_legacy_waiting_and_confinement_checks() throws {
        let payload = try pythonFixture(), originals = runtimeRows(), runID = payload["runId"] as! String
        var roles = payload["roles"] as! [[String:Any]]
        roles[0]["waiting"] = false; roles[3]["waiting"] = false
        #expect(throws:Never.self) { try BootstrapHandoff.validateRolesV2(roles,runID:runID,programPins:pythonProgramPins,runtime:originals,originals:originals,generation:1) }
        for (key,value) in [("waiting",true as Any),("noNewPrivs",0),("seccomp",0),("uids",[0,0,0])] {
            var changed = roles; changed[3][key] = value
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRolesV2(changed,runID:runID,programPins:pythonProgramPins,runtime:originals,originals:originals,generation:1) }
        }
        let run = try BootstrapRunFixture().run
        let data = try handoff(run) { payload in
            var changed = payload, rows = payload["roles"] as! [[String:Any]]
            rows[0]["waiting"] = false; rows[3]["waiting"] = false; changed["roles"] = rows; return changed
        }
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([data]),lifecycle:BootstrapLifecycleFake(),executables:executableAuthority(run),clock:BootstrapTestClock())
        }
    }
    @Test func v1_runtime_proxy_caps_and_original_pipe_directions() throws {
        var rows = runtimeRows(), fds = Array((rows[3]["currentFDs"] as! [[String:Any]]).prefix(5))
        let kinds = ["PROXY_LISTENER","PROXY_STOP_SELECTOR"] + Array(repeating:"PROXY_ACCEPTED_STREAM",count:16)
            + Array(repeating:"PROXY_VSOCK_STREAM",count:16) + Array(repeating:"PROXY_CONNECT_SELECTOR",count:16)
        for (index,kind) in kinds.enumerated() {
            fds.append(["fd":index+5,"kind":kind,"device":"9","inode":String(1000+index),"flags":2,
                        "ownerId":String(format:"%032x",1000+index),"acquiredGeneration":1])
        }
        rows[3]["currentFDs"] = fds
        #expect(throws:Never.self) { try BootstrapHandoff.validateRoleRuntimeV1(rows,originals:rows,generation:1) }
        var extra = fds.last!; extra["fd"] = 55; extra["inode"] = "9999"; extra["ownerId"] = String(repeating:"a",count:32)
        var excess = rows; excess[3]["currentFDs"] = fds + [extra]
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(excess,originals:excess,generation:1) }
        for index in [3,4] {
            var changed = rows, modified = fds; modified[index]["flags"] = index == 3 ? 1:0; changed[3]["currentFDs"] = modified
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:changed,generation:1) }
        }
        var changed = rows, modified = fds; modified[4]["inode"] = modified[3]["inode"]; changed[3]["currentFDs"] = modified
        #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:changed,generation:1) }
    }
    @Test func local_n5_typed_capture_failure_remains_sticky_at_every_gate_entry() throws {
        let run = try BootstrapRunFixture().run
        let original = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run)]),lifecycle:BootstrapLifecycleFake(),
            executables:try executableAuthority(run),clock:BootstrapTestClock())
        let probe = BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)])
        let q = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),
            executables:try executableAuthority(run),clock:BootstrapTestClock())
        probe.onCapture = { throw BootstrapCleanupFailure(cleanup:original) }
        for operation in [{ _ = try q.requireBrowserAdmission() },
                          { _ = try q.currentProofWithoutActivation() },
                          { try q.activateBrowser(BootstrapActivationFake()) }] {
            do { try operation(); Issue.record("cleanup failure returned admission") }
            catch let error as BootstrapCleanupFailure { #expect(error.cleanup === q) }
        }
        #expect(q.cleanupUncertain)
        #expect(throws:BootstrapCleanupFailure.self) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),
                executables:try executableAuthority(run),clock:BootstrapTestClock())
        }
    }

    @Test func local_n3_pending_early_stop_is_compensated_after_preparation_settles() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake()
        let prepared=DispatchSemaphore(value:0), settle=DispatchSemaphore(value:0)
        let entered=DispatchSemaphore(value:0), release=DispatchSemaphore(value:0)
        let activated=DispatchSemaphore(value:0), cleaned=DispatchSemaphore(value:0)
        activation.onPrepare = { prepared.signal(); _ = settle.wait(timeout:.now() + .seconds(2)) }
        activation.handle.onStop = {
            if activation.handle.stops == 1 { entered.signal(); _ = release.wait(timeout:.now() + .seconds(2)) }
        }
        DispatchQueue.global().async {
            do { try q.activateBrowser(activation); Issue.record("late preparation was admitted") }
            catch let error as BootstrapCleanupFailure { #expect(error.cleanup === q) }
            catch { Issue.record("pending cleanup lost authority: \(error)") }
            activated.signal()
        }
        defer { settle.signal(); release.signal() }
        #expect(prepared.wait(timeout:.now() + .seconds(1)) == .success)
        DispatchQueue.global().async { lifecycle.triggerDrift(); cleaned.signal() }
        #expect(entered.wait(timeout:.now() + .seconds(1)) == .success)
        settle.signal(); #expect(activated.wait(timeout:.now() + .seconds(1)) == .success)
        #expect(q.cleanupUncertain)
        release.signal(); #expect(cleaned.wait(timeout:.now() + .seconds(1)) == .success)
        #expect(activation.handle.stops == 2); #expect(!q.cleanupUncertain)
    }

    @Test func local_n3_terminal_drift_before_registration_prevents_prepare() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake()
        activation.onCleanup = { lifecycle.triggerDrift() }
        #expect(throws:VMFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.preparations == 0); #expect(activation.handle.calls == 0)
        #expect(activation.handle.stops == 1); #expect(!q.cleanupUncertain)
    }

    @Test func local_n3_late_preparation_is_compensated_after_early_stop() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake()
        activation.onPrepare = { lifecycle.triggerDrift() }
        #expect(throws:VMFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.handle.stops == 2); #expect(!q.cleanupUncertain)
    }

    @Test func local_n5_pending_role_and_lifecycle_cleanup_stays_visible() throws {
        for stopRole in [true,false] {
            let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
            let q = try OfflineVMHost.bootstrapCheck(run:run,
                probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
                lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
            let activation = BootstrapActivationFake(); try q.activateBrowser(activation)
            let entered=DispatchSemaphore(value:0), release=DispatchSemaphore(value:0), done=DispatchSemaphore(value:0)
            let stop:@Sendable () -> Void = { entered.signal(); _ = release.wait(timeout:.now() + .seconds(2)) }
            if stopRole { activation.handle.onStop=stop } else { lifecycle.onStop=stop }
            DispatchQueue.global().async { lifecycle.triggerDrift(); done.signal() }
            defer { release.signal() }
            #expect(entered.wait(timeout:.now() + .seconds(1)) == .success)
            #expect(q.cleanupUncertain)
            lifecycle.triggerDrift(); #expect(q.cleanupUncertain)
            for operation in [{ _ = try q.currentProofWithoutActivation() },
                              { _ = try q.requireBrowserAdmission() },
                              { try q.activateBrowser(activation) }] {
                do { try operation(); Issue.record("pending cleanup returned admission") }
                catch let error as BootstrapCleanupFailure { #expect(error.cleanup === q) }
                catch { Issue.record("pending cleanup lost authority: \(error)") }
            }
            release.signal(); #expect(done.wait(timeout:.now() + .seconds(1)) == .success)
            #expect(!q.cleanupUncertain)
            #expect(activation.handle.stops == 1); #expect(lifecycle.stops == 1)
        }
    }

    @Test func round4_expiry_after_authorize_cannot_publish_success() throws {
        let run = try BootstrapRunFixture().run, clock = BootstrapTestClock()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake()
        activation.handle.afterEffect = { clock.replace([.init(wall:190,monotonic:10010)]) }
        #expect(throws:VMFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.handle.stops == 1)
    }

    @Test func round4_drift_during_prepare_retains_uncertain_owner() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake(); activation.handle.uncertain = true
        activation.onPrepare = { lifecycle.triggerDrift() }
        #expect(throws:BootstrapCleanupFailure.self) { try q.activateBrowser(activation) }
        #expect(q.cleanupUncertain); #expect(activation.handle.stops >= 1)
    }

    @Test func round4_prepare_throw_retains_original_cleanup_authority() throws {
        let run = try BootstrapRunFixture().run
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake(); activation.handle.uncertain = true
        activation.onPrepare = { throw VMFailure.admissionUnavailable }
        #expect(throws:BootstrapCleanupFailure.self) { try q.activateBrowser(activation) }
        #expect(q.cleanupUncertain); #expect(activation.handle.stops == 1)
    }

    @Test func round4_cleanup_duration_is_at_most_sixty_seconds() throws {
        let run = try BootstrapRunFixture().run, clock = BootstrapTestClock(), lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake(); try q.activateBrowser(activation)
        activation.handle.onStop = { clock.replace([.init(wall:100,monotonic:60010)]) }
        lifecycle.triggerDrift()
        #expect(activation.handle.bounds.allSatisfy { $0 > 0 && $0 <= 60000 })
        #expect(q.cleanupUncertain)
    }

    @Test func round4_late_activation_compensates_after_uncertain_early_stop() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake(); activation.handle.uncertain = true
        activation.handle.afterEffect = {
            lifecycle.triggerDrift()
            activation.handle.uncertain = false
        }
        #expect(throws:BootstrapCleanupFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.handle.stops == 2); #expect(q.cleanupUncertain)
        lifecycle.triggerDrift()
        #expect(activation.handle.stops == 2)
    }

    @Test func round4_all_owners_share_remaining_cleanup_budget() throws {
        let run = try BootstrapRunFixture().run, clock = BootstrapTestClock(), lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake(); try q.activateBrowser(activation)
        activation.handle.onStop = { clock.replace([.init(wall:100,monotonic:20010)]) }
        lifecycle.onStop = { clock.replace([.init(wall:100,monotonic:60010)]) }
        lifecycle.triggerDrift()
        #expect(activation.handle.bounds.count == 1)
        #expect(lifecycle.bounds.count == 1)
        #expect(lifecycle.bounds.allSatisfy { $0 > 0 && $0 <= 40000 })
        #expect(q.cleanupUncertain)
        lifecycle.triggerDrift(); #expect(lifecycle.bounds.count == 1)
    }

    @Test func round4_never_completing_stop_has_bounded_wait_and_retained_owner() throws {
        let run = try BootstrapRunFixture().run, clock = BootstrapTestClock(), lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake(); try q.activateBrowser(activation)
        let release=DispatchSemaphore(value:0), completed=DispatchSemaphore(value:0), stopped=DispatchSemaphore(value:0)
        activation.handle.onStop = {
            clock.replace([.init(wall:100,monotonic:60010)])
            _ = release.wait(timeout:.now() + .seconds(1)); stopped.signal()
        }
        DispatchQueue.global().async { lifecycle.triggerDrift(); completed.signal() }
        let outcome=completed.wait(timeout:.now() + .milliseconds(200))
        release.signal(); _ = stopped.wait(timeout:.now() + .seconds(1))
        #expect(outcome == .success); #expect(q.cleanupUncertain)
        #expect(activation.handle.stops == 1)
    }

    @Test func round4_unapproved_browser_worker_mapping_never_qualifies() throws {
        let run = try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) { _ = try unapprovedExecutableAuthority(run) }
    }

    @Test func python_producer_handoff_is_authenticated_and_fully_consumed() throws {
        let path = try #require(ProcessInfo.processInfo.environment["TASK10_TOPOLOGY_INPUT"])
        let data = try Data(contentsOf:URL(fileURLWithPath:path))
        let proof = try BootstrapHandoff.verify(data:data,expectedRunID:String(repeating:"1",count:32),
            manifestIdentity:String(repeating:"a",count:64),configIdentity:String(repeating:"b",count:64),
            expiresAt:190,capability:Data(repeating:7,count:32),
            executables:try BootstrapExecutableAuthority.offlineLiteral(pins:pythonProgramPins))
        #expect(proof.sequence == 1); #expect(proof.roleInventoryDigest.count == 64)
        #expect(proof.deviceInventoryDigest.count == 64)
    }

    @Test func shared_python_valid_mac_nested_primitive_vectors_reject() throws {
        let path = try #require(ProcessInfo.processInfo.environment["TASK10_TOPOLOGY_INPUT"])
        let vectors = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path + ".invalid.json"))) as! [String]
        #expect(vectors.count == 6)
        for vector in vectors {
            #expect(throws:VMFailure.admissionUnavailable) {
                _ = try BootstrapHandoff.verify(data:Data(vector.utf8),expectedRunID:String(repeating:"1",count:32),
                    manifestIdentity:String(repeating:"a",count:64),configIdentity:String(repeating:"b",count:64),
                    expiresAt:190,capability:Data(repeating:7,count:32),
                    executables:try BootstrapExecutableAuthority.offlineLiteral(pins:pythonProgramPins))
            }
        }
    }

    @Test func native_entry_remains_fail_closed_and_composition_selection_is_bounded() throws {
        let run = try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(run:run) }
        _ = try NativeBootstrapComposition.select(manifestPath:"/signed/manifest.json",releasePath:"/signed/release.json",platform:"linux",machine:"arm64")
        #expect(throws:VMFailure.admissionUnavailable) { _ = try NativeBootstrapComposition.select(manifestPath:"",releasePath:"x",platform:"linux",machine:"arm64") }
        let arguments = ["bootstrap-check","--manifest","/signed/m","--release","/signed/r"]
        #expect(try HostDispatch.parse(arguments) == .bootstrapCheck)
        let invocation = try #require(try HostDispatch.bootstrapInvocation(arguments))
        #expect(invocation == BootstrapInvocation(manifest:"/signed/m",release:"/signed/r"))
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(invocation:invocation) }
    }

    @Test func literal_wire_authority_does_not_claim_executable_provenance() throws {
        let run = try BootstrapRunFixture().run, authority = try executableAuthority(run)
        #expect(authority.manifestIdentity == nil)
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(run:run) }
    }

    @Test func fixed_probe_and_full_inventory_handoff_admit() throws {
        let run = try BootstrapRunFixture().run, probe = BootstrapProbeFake([try handoff(run)])
        let lifecycle = BootstrapLifecycleFake(), clock = BootstrapTestClock()
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:lifecycle,
                                                              executables:try executableAuthority(run),clock:clock)
        #expect(probe.requested == [BootstrapProbeID.allCases]); #expect(lifecycle.starts == 1)
        let proof = try qualification.currentProofWithoutActivation()
        #expect(proof.runID == run.binding.runID); #expect(proof.manifestIdentity == run.appliance.manifest.digest)
    }

    @Test func valid_mac_inventory_filter_fd_route_dns_listener_substitutions_reject() throws {
        let run = try BootstrapRunFixture().run
        let mutations:[([String:Any]) -> [String:Any]] = [
            { value in var x=value; var d=x["devices"] as! [String:Any]; d["routes"]=["default-v4"]; x["devices"]=d; return x },
            { value in var x=value; var d=x["devices"] as! [String:Any]; d["dnsServers"]=["127.0.0.53"]; x["devices"]=d; return x },
            { value in var x=value; var d=x["devices"] as! [String:Any]; var l=d["listeners"] as! [[String:Any]]; l.append(l[0]); d["listeners"]=l; x["devices"]=d; return x },
            { value in var x=value; var r=x["roles"] as! [[String:Any]]; r[1]["filterDigest"]=String(repeating:"0",count:64); x["roles"]=r; return x },
            { value in var x=value; var r=x["roles"] as! [[String:Any]]; var f=r[1]["fds"] as! [[String:Any]]; f[3]["purpose"]="donor"; r[1]["fds"]=f; x["roles"]=r; return x },
            { value in var x=value; var r=x["roles"] as! [[String:Any]]; var p=r[1]["programs"] as! [[String:Any]]; p[0]["sha256"]=String(repeating:"f",count:64); r[1]["programs"]=p; x["roles"]=r; return x },
            { value in var x=value; var r=x["roles"] as! [[String:Any]]; r[1]["waiting"]=1; x["roles"]=r; return x },
        ]
        for mutation in mutations {
            let bad = try handoff(run,mutate:mutation)
            #expect(throws:VMFailure.admissionUnavailable) {
                _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([bad]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:BootstrapTestClock()) }
        }
    }

    @Test func current_use_resamples_clock_observation_and_one_use_activation() throws {
        let run = try BootstrapRunFixture().run
        let probe = BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2,wall:101,monotonic:11)])
        let clock = BootstrapTestClock([.init(wall:100,monotonic:10),.init(wall:100,monotonic:10),
                                        .init(wall:100,monotonic:10),.init(wall:101,monotonic:11),.init(wall:101,monotonic:11)])
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake(); try qualification.activateBrowser(activation)
        #expect(activation.handle.calls == 1); #expect(probe.requested.count == 2)
        #expect(throws:VMFailure.terminal) { try qualification.activateBrowser(activation) }
    }

    @Test func reentrant_activation_runs_once_and_compensates_owned_handle() throws {
        let run = try BootstrapRunFixture().run
        let probe = BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2),try handoff(run,sequence:3)])
        let clock = BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:20))
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake()
        activation.handle.callback = { #expect(throws:BootstrapCleanupFailure.self) { try qualification.activateBrowser(activation) } }
        #expect(throws:VMFailure.self) { try qualification.activateBrowser(activation) }
        #expect(activation.handle.calls == 0); #expect(activation.handle.stops == 2)
        #expect(throws:VMFailure.terminal) { _ = try qualification.requireBrowserAdmission() }
    }

    @Test func delayed_authorize_and_ordinary_failure_cleanup_all_owned_handles() throws {
        let run = try BootstrapRunFixture().run
        let lifecycle = BootstrapLifecycleFake()
        let probe = BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)])
        let clock = BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:30))
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:lifecycle,
            executables:try executableAuthority(run),clock:clock)
        let activation = BootstrapActivationFake()
        activation.handle.callback = { clock.replace([.init(wall:190,monotonic:10010)]) }
        #expect(throws:VMFailure.self) { try qualification.activateBrowser(activation) }
        #expect(activation.handle.calls == 0)
        #expect(activation.handle.stops == 1)
        #expect(lifecycle.stops == 1)

        let lifecycle2 = BootstrapLifecycleFake()
        var malformed = try handoff(run,sequence:2); malformed.append(0)
        let q2 = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),malformed]),lifecycle:lifecycle2,
            executables:try executableAuthority(run),clock:BootstrapTestClock())
        #expect(throws:VMFailure.self) { _ = try q2.requireBrowserAdmission() }
        #expect(lifecycle2.stops == 1)
    }

    @Test func rollback_expiry_malformed_and_lifecycle_drift_latch_terminal() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        lifecycle.triggerDrift()
        #expect(lifecycle.stops == 1)
        #expect(throws:VMFailure.terminal) { _ = try q.currentProofWithoutActivation() }
        #expect(throws:VMFailure.terminal) { _ = try q.currentProofWithoutActivation() }

        let rollback = BootstrapTestClock([.init(wall:100,monotonic:10),.init(wall:99,monotonic:11)])
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:rollback) }
        var malformed = try handoff(run); malformed.append(0)
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([malformed]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:BootstrapTestClock()) }

        let expiryClock = BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:4)
                                              + [.init(wall:100,monotonic:10),.init(wall:190,monotonic:11)])
        let expiring = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(run),clock:expiryClock)
        #expect(throws:VMFailure.expired) { _ = try expiring.requireBrowserAdmission() }
        #expect(throws:VMFailure.terminal) { _ = try expiring.requireBrowserAdmission() }

        let duringBegin = BootstrapLifecycleFake(); duringBegin.driftOnBegin = true
        #expect(throws:VMFailure.terminal) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),
                lifecycle:duringBegin,executables:try executableAuthority(run),clock:BootstrapTestClock())
        }
        #expect(duringBegin.stops == 1)
    }

    @Test func initial_expiry_after_begin_and_post_success_drift_cleanup_once() throws {
        let run = try BootstrapRunFixture().run
        let clock = BootstrapTestClock(), lifecycle = BootstrapLifecycleFake()
        lifecycle.onBegin = { clock.replace([.init(wall:190,monotonic:10010)]) }
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),
                lifecycle:lifecycle,executables:try executableAuthority(run),clock:clock)
        }
        #expect(lifecycle.stops == 1)

        let live = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:live,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake(); try q.activateBrowser(activation)
        live.triggerDrift(); live.triggerDrift()
        #expect(activation.handle.calls == 1); #expect(activation.handle.stops == 1)
        #expect(live.stops == 1)
        #expect(throws:VMFailure.terminal) { _ = try q.currentProofWithoutActivation() }
    }

    @Test func partial_activation_error_and_uncertain_cleanup_remain_terminal() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,
            probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
            lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        let activation = BootstrapActivationFake()
        activation.handle.uncertain = true
        activation.handle.afterEffect = { throw VMFailure.admissionUnavailable }
        #expect(throws:BootstrapCleanupFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.handle.calls == 1); #expect(activation.handle.stops == 1)
        #expect(lifecycle.stops == 1); #expect(q.cleanupUncertain)
        lifecycle.triggerDrift()
        #expect(activation.handle.stops == 1); #expect(q.cleanupUncertain)
    }
}
