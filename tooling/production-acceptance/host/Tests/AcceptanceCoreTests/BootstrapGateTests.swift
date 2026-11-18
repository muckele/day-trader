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

// C2: the host challenge nonce. Bytes 00..0f give the shared exported value.
private let testHostChallenge = "000102030405060708090a0b0c0d0e0f"
private final class BootstrapNonceFake: BootstrapNonceSource, @unchecked Sendable {
    private let lock = NSLock(); private var values:[Data]
    init(_ values:[Data] = [Data((0..<16).map { UInt8($0) })]) { self.values = values }
    func nonce() throws -> Data { lock.withLock { values.count == 1 ? values[0]:values.removeFirst() } }
}

private final class BootstrapProbeFake: BootstrapProbePort, @unchecked Sendable {
    private var values:[Data]; var requested = [[BootstrapProbeID]](), challenges = [String?]()
    var onCapture:(@Sendable () throws -> Void)?
    init(_ values:[Data]) { self.values = values }
    func capture(ids:[BootstrapProbeID],challenge:BootstrapChallenge?) throws -> Data {
        requested.append(ids); challenges.append(challenge?.value)
        try onCapture?()
        guard !values.isEmpty else { throw VMFailure.admissionUnavailable }
        return values.count == 1 ? values[0]:values.removeFirst()
    }
}

private final class BootstrapLifecycleFake: BootstrapLifecyclePort, BootstrapOwnedLifecycle, @unchecked Sendable {
    private var drift:(@Sendable () -> Void)?; var starts = 0, stops = 0, driftOnBegin = false
    var onBegin:(@Sendable () -> Void)?, beginError:VMFailure?, returnedOwner:(any BootstrapOwnedLifecycle)?
    func begin(handoff:Data,onDrift:@escaping @Sendable () -> Void) throws -> any BootstrapOwnedLifecycle {
        starts += 1; drift = onDrift; onBegin?(); if driftOnBegin { onDrift() }
        if let beginError { throw beginError }
        return returnedOwner ?? self
    }
    var bounds:[Int] = [], onStop:(@Sendable () -> Void)?, uncertain=false, throwingStops=0
    func stopOwned(deadline:Int) throws -> BootstrapStopOutcome {
        stops += 1; bounds.append(deadline); onStop?()
        if throwingStops > 0 { throwingStops -= 1; throw VMFailure.stop }
        return uncertain ? .uncertain:.stopped
    }
    func triggerDrift() { drift?() }
}

private final class BootstrapLateResource: @unchecked Sendable {
    private let lock=NSLock()
    private var acquired=false
    var live:Bool { lock.withLock { acquired } }
    func acquire() { lock.withLock { acquired=true } }
    func stop() { lock.withLock { acquired=false } }
}

private final class BootstrapBlockingLifecycle: BootstrapLifecyclePort, BootstrapOwnedLifecycle, @unchecked Sendable {
    let entered=DispatchSemaphore(value:0), release=DispatchSemaphore(value:0), finished=DispatchSemaphore(value:0)
    let late=BootstrapLateResource()
    private let lock=NSLock()
    private var active=0, _stops=0, _maximumConcurrent=0
    var stops:Int { lock.withLock { _stops } }
    var maximumConcurrent:Int { lock.withLock { _maximumConcurrent } }
    func begin(handoff:Data,onDrift:@escaping @Sendable () -> Void) throws -> any BootstrapOwnedLifecycle {
        onDrift(); late.acquire(); return self
    }
    func stopOwned(deadline:Int) throws -> BootstrapStopOutcome {
        lock.withLock { active += 1; _stops += 1; _maximumConcurrent=max(_maximumConcurrent,active) }
        late.stop(); entered.signal(); release.wait()
        lock.withLock { active -= 1 }
        finished.signal()
        return .stopped
    }
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
    init(legacy:Bool = false,incomplete:Bool = false,durationMs:Int = 30) throws {
        let applianceFixture = try ApplianceFixture()
        var applianceObject = legacy ? applianceFixture.legacyObject():applianceFixture.object
        var components = applianceObject["components"] as! [[String:Any]]
        for (index,id) in ["controller","guestBootstrap","guestProbes","proxy","rolePolicy","routePolicy","seccompPolicy","verifier"].enumerated() {
            if components.contains(where:{ $0["id"] as? String == id }) { continue }
            components.append(["id":id,"sha256":String(repeating:String(index + 1),count:64),
                               "sizeBytes":index + 1,"sourceId":"task10-independent-" + id,"version":"task10-v1"])
        }
        if incomplete { components.removeAll { $0["id"] as? String == "browserWorker" } }
        applianceObject["components"] = components.sorted { ($0["id"] as! String) < ($1["id"] as! String) }
        applianceObject["missingPayload"] = incomplete ? ["browserWorker"]:[]
        applianceObject["payloadState"] = incomplete ? "INCOMPLETE":"COMPLETE"
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
        for value in [100,0,300,190,10000,20,durationMs,1] { var number = UInt64(value).bigEndian; bytes.append(withUnsafeBytes(of:&number) { Data($0) }) }
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

private final class BootstrapPopulationFixture: @unchecked Sendable {
    let authority:OfflineBootstrapPopulationAuthority, paths:[String:URL]
    init(_ run:RunConfiguration) throws {
        let fixture=try ApplianceFixture()
        let inventory=try OfflineInstalledExecutableInventory.decode(fixture.inventoryBytes(),appliance:run.appliance)
        let bytes=fixture.memberBytes()
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false)
        var locations:[String:URL]=[:]
        for (index,path) in bytes.keys.sorted().enumerated() {
            let url=directory.appendingPathComponent(String(index))
            try bytes[path]!.write(to:url)
            try FileManager.default.setAttributes([.posixPermissions:0o400],ofItemAtPath:url.path)
            locations[path]=url
        }
        paths=locations
        authority=try OfflineVMHost.qualifyBootstrapPopulation(run:run,inventory:inventory,
            memberBytes:bytes,installedLocations:locations)
    }
    func driftFirst() throws {
        let url=paths[paths.keys.sorted()[0]]!
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
        try Data("drift".utf8).write(to:url)
    }
}

private func canonical(_ object:Any) throws -> Data {
    try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.withoutEscapingSlashes])
}

// C3: handoffs are MAC'd with the topology-admission key, never the raw capability
// (rawKey:true exists only to prove that the raw capability is denied).
private func admissionKey(_ capability:Data, rawKey:Bool) throws -> SymmetricKey {
    SymmetricKey(data:rawKey ? capability:try ChannelKeys.derive(capability:capability,label:"topology-admission"))
}

private func resign(_ payload:[String:Any], capability:Data, rawKey:Bool = false) throws -> Data {
    let bytes = try canonical(payload)
    let mac = HMAC<SHA256>.authenticationCode(for:bytes,using:try admissionKey(capability,rawKey:rawKey))
        .map { String(format:"%02x",$0) }.joined()
    return try canonical(["mac":mac,"payload":payload,"version":1])
}

private func resignV2(_ payload:[String:Any], capability:Data, rawKey:Bool = false) throws -> Data {
    let bytes = try canonical(payload)
    let domain = Data("acceptance:bootstrap-composition:v1\0".utf8)
    let mac = HMAC<SHA256>.authenticationCode(for:domain + bytes,using:try admissionKey(capability,rawKey:rawKey))
        .map { String(format:"%02x",$0) }.joined()
    return try canonical(["mac":mac,"payload":payload,"version":2])
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
                     wall:Int = 100, monotonic:Int = 10, rawKey:Bool = false,
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
    return try resign(mutate?(payload) ?? payload,capability:run.capability,rawKey:rawKey)
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

    private func compositionHandoff(_ run:RunConfiguration, originals:[[String:Any]], sequence:Int = 1,
                                    epoch:Int = 1, generation:Int = 1,
                                    wall:Int = 100, monotonic:Int = 10,
                                    challenge:String? = testHostChallenge, rawKey:Bool = false,
                                    mutate:(([String:Any]) -> [String:Any])? = nil) throws -> Data {
        let path = try #require(ProcessInfo.processInfo.environment["BOOTSTRAP_V1_HANDOFF_INPUT"])
        let data = try Data(contentsOf:URL(fileURLWithPath:path))
        let envelope = try #require(try JSONSerialization.jsonObject(with:data) as? [String:Any])
        var payload = try #require(envelope["payload"] as? [String:Any])
        payload["runId"] = run.binding.runID
        payload["manifestIdentity"] = run.appliance.manifest.digest
        payload["configIdentity"] = run.binding.configIdentity
        payload["expiresAt"] = run.binding.expiresAt
        payload["sequence"] = sequence
        payload["observedWall"] = wall
        payload["observedMonotonic"] = monotonic
        if let challenge { payload["hostChallenge"] = challenge } else { payload.removeValue(forKey:"hostChallenge") }
        var proxy = payload["proxy"] as! [String:Any]
        proxy["runId"] = run.binding.runID
        proxy["manifestIdentity"] = run.appliance.manifest.digest
        proxy["configIdentity"] = run.binding.configIdentity
        proxy["expiresAt"] = run.binding.expiresAt
        payload["proxy"] = proxy
        let fixture=try ApplianceFixture()
        let inventory=try OfflineInstalledExecutableInventory.decode(fixture.inventoryBytes(),appliance:run.appliance)
        let retainedPins=Dictionary(uniqueKeysWithValues:inventory.records.map { ($0.installedPath,$0.memberSHA256) })
        var roles = payload["roles"] as! [[String:Any]]
        for index in roles.indices {
            roles[index]["runId"] = run.binding.runID
            var fds = roles[index]["fds"] as! [[String:Any]]
            for fdIndex in fds.indices { fds[fdIndex]["runId"] = run.binding.runID }
            roles[index]["fds"] = fds
            var programs = roles[index]["programs"] as! [[String:Any]]
            for programIndex in programs.indices {
                programs[programIndex]["sha256"] = retainedPins[programs[programIndex]["path"] as! String]!
            }
            roles[index]["programs"] = programs
        }
        payload["roles"] = roles
        var composition = payload["composition"] as! [String:Any]
        var binding = composition["binding"] as! [String:Any]
        binding["runId"] = run.binding.runID
        binding["manifestDigest"] = run.appliance.manifest.digest
        binding["configIdentity"] = run.binding.configIdentity
        binding["rolePolicyDigest"] = String(repeating:"d",count:64)
        binding["expiresAtMs"] = run.binding.expiresAt
        binding["epoch"] = epoch
        composition["binding"] = binding
        composition["probeEpochDigest"] = String(repeating:"e",count:64)
        composition["fixtureInventoryDigest"] = String(repeating:"f",count:64)
        composition["proxyRuntimeId"] = String(repeating:"b",count:32)
        var checkpoint = composition["eventCheckpoint"] as! [String:Any]
        checkpoint["binding"] = binding
        checkpoint["generation"] = generation
        checkpoint["sequence"] = sequence
        checkpoint["sourceIdentity"] = String(repeating:"a",count:32)
        composition["eventCheckpoint"] = checkpoint
        composition["roleRuntime"] = originals
        payload["composition"] = composition
        return try resignV2(mutate?(payload) ?? payload,capability:run.capability,rawKey:rawKey)
    }

    private func offlineComposition(_ run:RunConfiguration, probe:BootstrapProbeFake,
                                    lifecycle:any BootstrapLifecyclePort & BootstrapOwnedLifecycle,
                                    clock:BootstrapTestClock,
                                    originals:[[String:Any]],
                                    population:OfflineBootstrapPopulationAuthority? = nil,
                                    events:OfflineBootstrapEventOwner? = nil,
                                    nonces:any BootstrapNonceSource = BootstrapNonceFake()) throws -> BootstrapCompositionV1 {
        let retainedPopulation=try population ?? BootstrapPopulationFixture(run).authority
        let retainedEvents=try events ?? OfflineVMHost.installBootstrapEvents(run:run,
            rolePolicyDigest:String(repeating:"d",count:64),epoch:1,generation:1,
            sourceID:String(repeating:"a",count:32),lostCount:0)
        return try OfflineVMHost.composeBootstrapV1(run:run,probe:probe,lifecycle:lifecycle,
            population:retainedPopulation,eventOwner:retainedEvents,clock:clock,originalRoleRuntime:originals,
            rolePolicyDigest:String(repeating:"d",count:64),epoch:1,generation:1,
            probeEpochDigest:String(repeating:"e",count:64),fixtureInventoryDigest:String(repeating:"f",count:64),
            proxyRuntimeID:String(repeating:"b",count:32),nonces:nonces)
    }

    @Test func v1_review_initial_capture_preserves_typed_failure_and_stops_original_owner() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let foreign=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock(),originals:originals))
        let probe=BootstrapProbeFake([]), lifecycle=BootstrapLifecycleFake()
        probe.onCapture={ throw BootstrapCleanupFailure(cleanup:foreign) }
        let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,
            clock:BootstrapTestClock(),originals:originals)
        #expect(throws:BootstrapCleanupFailure.self) {
            _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
        }
        #expect(lifecycle.stops == 1)
    }

    @Test func v1_review_partial_lifecycle_begin_stops_original_owner_once() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)])
        let lifecycle=BootstrapLifecycleFake(); lifecycle.beginError = .start
        let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,
            clock:BootstrapTestClock(),originals:originals)
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
        }
        #expect(lifecycle.starts == 1)
        #expect(lifecycle.stops == 1)
    }

    @Test func v1_review_late_original_lifecycle_acquisition_invalidates_provisional_stop() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let lifecycle=BootstrapLifecycleFake(), late=BootstrapLateResource()
        lifecycle.onStop={ late.stop() }
        lifecycle.onBegin={ lifecycle.triggerDrift(); late.acquire() }
        let composition=try offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
        var typed=false, terminal=false
        do { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        catch is BootstrapCleanupFailure { typed=true }
        catch let error as VMFailure { terminal=error == .terminal }
        #expect(!late.live || typed)
        #expect(!terminal || !late.live)
        #expect(lifecycle.stops == 2)
    }

    @Test func v1_review_late_substituted_lifecycle_is_retained_with_original() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let lifecycle=BootstrapLifecycleFake(), substitute=BootstrapLifecycleFake()
        let originalLate=BootstrapLateResource(), substituteLate=BootstrapLateResource()
        lifecycle.onStop={ originalLate.stop() }; substitute.onStop={ substituteLate.stop() }
        lifecycle.returnedOwner=substitute
        lifecycle.onBegin={ lifecycle.triggerDrift(); originalLate.acquire(); substituteLate.acquire() }
        let composition=try offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
        #expect(throws:VMFailure.terminal) {
            _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
        }
        #expect(!originalLate.live); #expect(!substituteLate.live)
        #expect(lifecycle.stops == 2); #expect(substitute.stops == 1)
    }

    @Test func v1_review_late_acquisition_after_uncertain_or_throwing_stop_is_typed() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        for throwsStop in [false,true] {
            let lifecycle=BootstrapLifecycleFake(), late=BootstrapLateResource()
            lifecycle.uncertain = !throwsStop; lifecycle.throwingStops = throwsStop ? 1:0
            lifecycle.onStop={ late.stop() }
            lifecycle.onBegin={ lifecycle.triggerDrift(); late.acquire() }
            let composition=try offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
            var cleanup:(any BootstrapCleanupOwner)?
            do { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
            catch let error as BootstrapCleanupFailure { cleanup=error.cleanup }
            #expect(cleanup?.cleanupUncertain == true)
            #expect(!late.live)
            #expect(lifecycle.stops == 2)
        }
    }

    @Test func v1_review_late_acquisition_with_zero_shared_budget_retains_typed_original() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let lifecycle=BootstrapLifecycleFake(), late=BootstrapLateResource()
        let clock=BootstrapTestClock()
        lifecycle.onStop={ late.stop(); clock.replace([.init(wall:100,monotonic:60010)]) }
        lifecycle.onBegin={ lifecycle.triggerDrift(); late.acquire() }
        let composition=try offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:lifecycle,clock:clock,originals:originals)
        var cleanup:(any BootstrapCleanupOwner)?
        do { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        catch let error as BootstrapCleanupFailure { cleanup=error.cleanup }
        #expect(cleanup?.cleanupUncertain == true)
        #expect(late.live)
        #expect(lifecycle.stops == 1)
    }

    @Test func v1_review_pending_lifecycle_acquisition_is_observable_as_cleanup_uncertainty() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let lifecycle=BootstrapBlockingLifecycle()
        let clock=BootstrapTestClock([.init(wall:100,monotonic:10),.init(wall:100,monotonic:10)]
            + Array(repeating:.init(wall:100,monotonic:10),count:50)
            + [.init(wall:100,monotonic:60010)])
        let composition=try offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:lifecycle,clock:clock,originals:originals)
        var cleanup:(any BootstrapCleanupOwner)?
        do { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        catch let error as BootstrapCleanupFailure { cleanup=error.cleanup }
        #expect(lifecycle.entered.wait(timeout:.now() + 1) == .success)
        #expect(cleanup?.cleanupUncertain == true)
        #expect(lifecycle.stops == 1)
        #expect(lifecycle.maximumConcurrent == 1)
        #expect(lifecycle.late.live)
        lifecycle.release.signal()
        #expect(lifecycle.finished.wait(timeout:.now() + 1) == .success)
    }

    @Test func v1_review_replayed_or_decreased_event_checkpoint_is_denied() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        func data(_ sequence:Int,_ eventSequence:Int) throws -> Data {
            try compositionHandoff(run,originals:originals,sequence:sequence) { value in
                var x=value, c=x["composition"] as! [String:Any], e=c["eventCheckpoint"] as! [String:Any]
                e["sequence"]=eventSequence; c["eventCheckpoint"]=e; x["composition"]=c; return x
            }
        }
        for next in [9,8] {
            let lifecycle=BootstrapLifecycleFake()
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:BootstrapProbeFake([try data(1,9),try data(2,next)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals))
            #expect(throws:VMFailure.self) { _=try q.requireBrowserAdmission() }
            #expect(lifecycle.stops == 1)
        }
    }

    @Test func v1_review_legacy_manifest_denied_before_capture_or_lifecycle() throws {
        for run in [try BootstrapRunFixture(legacy:true).run,try BootstrapRunFixture(incomplete:true).run] {
            let originals=runtimeRows(), probe=BootstrapProbeFake([]), lifecycle=BootstrapLifecycleFake()
            #expect(throws:(any Error).self) {
                let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,
                    clock:BootstrapTestClock(),originals:originals)
                _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
            }
            #expect(probe.requested.isEmpty)
            #expect(lifecycle.starts == 0)
        }
    }

    @Test func v1_review_original_lifecycle_drift_substitution_and_uncertain_cleanup_are_typed() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        do {
            let lifecycle=BootstrapLifecycleFake(); lifecycle.driftOnBegin=true
            let composition=try offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
            #expect(throws:VMFailure.terminal) { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
            // The first receipt was provisional while begin was unsettled.
            #expect(lifecycle.stops == 2)
        }
        do {
            let lifecycle=BootstrapLifecycleFake(), substitute=BootstrapLifecycleFake()
            lifecycle.returnedOwner=substitute
            let composition=try offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
            #expect(throws:VMFailure.terminal) { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
            #expect(lifecycle.stops == 1); #expect(substitute.stops == 1)
        }
        do {
            let lifecycle=BootstrapLifecycleFake(); lifecycle.beginError = .start; lifecycle.uncertain=true
            let composition=try offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
            var cleanup:(any BootstrapCleanupOwner)?
            do { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
            catch let error as BootstrapCleanupFailure { cleanup=error.cleanup }
            #expect(cleanup?.cleanupUncertain == true); #expect(lifecycle.stops == 1)
        }
    }

    @Test func v1_review_zero_shared_cleanup_budget_remains_typed() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let lifecycle=BootstrapLifecycleFake(); lifecycle.beginError = .start
        // The host terminal decision (third sample, monotonic 10) starts the shared
        // end; it is already exhausted (60010) when the first stop is reserved.
        let clock=BootstrapTestClock([.init(wall:100,monotonic:10),.init(wall:100,monotonic:10),
                                      .init(wall:100,monotonic:10),.init(wall:100,monotonic:60010)])
        let composition=try offlineComposition(run,
            probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
            lifecycle:lifecycle,clock:clock,originals:originals)
        #expect(throws:BootstrapCleanupFailure.self) {
            _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
        }
        #expect(lifecycle.stops == 0)
    }

    @Test func v1_host_cleanup_budget_starts_at_terminal_decision() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        // Composition variant: a successful admission is routine and never starts the host end.
        do {
            let lifecycle=BootstrapLifecycleFake(), clock=BootstrapTestClock()
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals)]),
                lifecycle:lifecycle,clock:clock,originals:originals))
            #expect(q.cleanupEnd == nil)
            // A terminal decision 61000 ms after admission still gets the full window.
            let drift=10 + 61000
            clock.replace([.init(wall:100,monotonic:drift)])
            lifecycle.triggerDrift()
            #expect(q.cleanupEnd == drift + 60000)
            #expect(lifecycle.stops == 1)
            #expect(lifecycle.bounds.allSatisfy { $0 > 0 && $0 <= 60000 })
            #expect(!q.cleanupUncertain)
        }
        // Literal-wire variant: the same terminal-start rule.
        do {
            let lifecycle=BootstrapLifecycleFake(), clock=BootstrapTestClock()
            let q=try OfflineVMHost.bootstrapCheck(run:run,
                probe:BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)]),
                lifecycle:lifecycle,executables:try executableAuthority(run),clock:clock)
            #expect(q.cleanupEnd == nil)
            let drift=10 + 61000
            clock.replace([.init(wall:100,monotonic:drift)])
            lifecycle.triggerDrift()
            #expect(q.cleanupEnd == drift + 60000)
            #expect(lifecycle.stops == 1)
            #expect(lifecycle.bounds.allSatisfy { $0 > 0 && $0 <= 60000 })
        }
    }

    @Test func v1_review_population_substitution_and_member_drift_deny_before_effects() throws {
        let run=try BootstrapRunFixture().run, other=try BootstrapRunFixture().run, originals=runtimeRows()
        let foreign=try BootstrapPopulationFixture(other)
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)]), lifecycle=BootstrapLifecycleFake()
        #expect(throws:(any Error).self) {
            _=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),
                originals:originals,population:foreign.authority)
        }
        #expect(probe.requested.isEmpty); #expect(lifecycle.starts == 0)

        let retained=try BootstrapPopulationFixture(run)
        let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),
            originals:originals,population:retained.authority)
        try retained.driftFirst()
        #expect(throws:(any Error).self) { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        #expect(probe.requested.isEmpty); #expect(lifecycle.starts == 0)
    }

    @Test func v1_review_member_population_rechecked_at_current_and_effect_boundaries() throws {
        let originals=runtimeRows()
        do {
            let run=try BootstrapRunFixture().run, retained=try BootstrapPopulationFixture(run)
            let lifecycle=BootstrapLifecycleFake(), probe=BootstrapProbeFake([
                try compositionHandoff(run,originals:originals)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals,
                population:retained.authority))
            try retained.driftFirst()
            #expect(throws:VMFailure.admissionUnavailable) { _=try q.currentProofWithoutActivation() }
            #expect(lifecycle.stops == 1)
        }
        do {
            let run=try BootstrapRunFixture().run, retained=try BootstrapPopulationFixture(run)
            let lifecycle=BootstrapLifecycleFake(), probe=BootstrapProbeFake([
                try compositionHandoff(run,originals:originals),
                try compositionHandoff(run,originals:originals,sequence:2)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals,
                population:retained.authority))
            let activation=BootstrapActivationFake(); activation.handle.callback={ try retained.driftFirst() }
            #expect(throws:VMFailure.admissionUnavailable) { try q.activateBrowser(activation) }
            #expect(activation.handle.calls == 0); #expect(activation.handle.stops == 1)
            #expect(lifecycle.stops == 1)
        }
    }

    @Test func v1_review_event_owner_absent_late_or_foreign_is_denied_before_capture() throws {
        let run=try BootstrapRunFixture().run, other=try BootstrapRunFixture().run, originals=runtimeRows()
        let population=try BootstrapPopulationFixture(run).authority
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)]), lifecycle=BootstrapLifecycleFake()
        #expect(throws:(any Error).self) {
            _=try OfflineVMHost.composeBootstrapV1(run:run,probe:probe,lifecycle:lifecycle,
                population:population,eventOwner:nil,clock:BootstrapTestClock(),originalRoleRuntime:originals,
                rolePolicyDigest:String(repeating:"d",count:64),epoch:1,generation:1,
                probeEpochDigest:String(repeating:"e",count:64),fixtureInventoryDigest:String(repeating:"f",count:64),
                proxyRuntimeID:String(repeating:"b",count:32))
        }
        let late=OfflineBootstrapEventOwner.pending(run:run,rolePolicyDigest:String(repeating:"d",count:64),
            epoch:1,generation:1,sourceID:String(repeating:"a",count:32),lostCount:0)
        let foreign=try OfflineVMHost.installBootstrapEvents(run:other,rolePolicyDigest:String(repeating:"d",count:64),
            epoch:1,generation:1,sourceID:String(repeating:"a",count:32),lostCount:0)
        for owner in [late,foreign] {
            #expect(throws:(any Error).self) {
                _=try OfflineVMHost.composeBootstrapV1(run:run,probe:probe,lifecycle:lifecycle,
                    population:population,eventOwner:owner,clock:BootstrapTestClock(),originalRoleRuntime:originals,
                    rolePolicyDigest:String(repeating:"d",count:64),epoch:1,generation:1,
                    probeEpochDigest:String(repeating:"e",count:64),fixtureInventoryDigest:String(repeating:"f",count:64),
                    proxyRuntimeID:String(repeating:"b",count:32))
            }
        }
        #expect(probe.requested.isEmpty); #expect(lifecycle.starts == 0)
    }

    @Test func v1_guest_handoff_matches_original_host_run_and_inventory() throws {
        let fixturePath = try #require(ProcessInfo.processInfo.environment["BOOTSTRAP_V1_HANDOFF_INPUT"])
        let exact = try Data(contentsOf:URL(fileURLWithPath:fixturePath))
        let envelope = try #require(try JSONSerialization.jsonObject(with:exact) as? [String:Any])
        let payload = try #require(envelope["payload"] as? [String:Any])
        let evidence = try #require(payload["composition"] as? [String:Any])
        let binding = try #require(evidence["binding"] as? [String:Any])
        let exactOriginals = try #require(evidence["roleRuntime"] as? [[String:Any]])
        let checkpoint = try #require(evidence["eventCheckpoint"] as? [String:Any])
        let roles = try #require(payload["roles"] as? [[String:Any]])
        let pins = Dictionary(uniqueKeysWithValues:(roles[0]["programs"] as! [[String:Any]]).map {
            ($0["path"] as! String,$0["sha256"] as! String) })
        let expectation = BootstrapCompositionExpectation(rolePolicyDigest:binding["rolePolicyDigest"] as! String,
            epoch:binding["epoch"] as! Int,generation:checkpoint["generation"] as! Int,
            probeEpochDigest:evidence["probeEpochDigest"] as! String,
            fixtureInventoryDigest:evidence["fixtureInventoryDigest"] as! String,
            eventSourceID:checkpoint["sourceIdentity"] as! String,
            proxyRuntimeID:evidence["proxyRuntimeId"] as! String,originalRoleRuntime:exactOriginals)
        let exactCapability=Data(repeating:7,count:32)
        let exactAuthority=try BootstrapExecutableAuthority.offlineLiteral(pins:pins)
        // The Python producer answered the shared test challenge (nonce 00..0f).
        #expect(payload["hostChallenge"] as? String == testHostChallenge)
        let exactChallenge=try BootstrapChallengeIssuer(nonces:BootstrapNonceFake())
            .issue(kind:.initial,at:ClockSample(wall:100,monotonic:10))
        #expect(throws:Never.self) {
            _ = try BootstrapHandoff.verify(data:exact,expectedRunID:payload["runId"] as! String,
                manifestIdentity:payload["manifestIdentity"] as! String,
                configIdentity:payload["configIdentity"] as! String,expiresAt:payload["expiresAt"] as! Int,
                capability:exactCapability,executables:exactAuthority,composition:expectation,
                challenge:exactChallenge)
        }
        let mutations:[([String:Any]) -> [String:Any]] = [
            { value in var x=value, c=x["composition"] as! [String:Any], b=c["binding"] as! [String:Any]; b["epoch"]=true; c["binding"]=b; x["composition"]=c; return x },
            { value in var x=value, c=x["composition"] as! [String:Any], e=c["eventCheckpoint"] as! [String:Any]; e["generation"]=2; c["eventCheckpoint"]=e; x["composition"]=c; return x },
            { value in var x=value, c=x["composition"] as! [String:Any]; c["unknown"]=0; x["composition"]=c; return x },
            { value in var x=value, c=x["composition"] as! [String:Any], r=c["roleRuntime"] as! [[String:Any]]; r[0]["inheritedFDs"]=[0,1,2,3,true]; c["roleRuntime"]=r; x["composition"]=c; return x },
        ]
        for mutation in mutations {
            let vector=try resignV2(mutation(payload),capability:exactCapability)
            #expect(throws:VMFailure.admissionUnavailable) {
                _ = try BootstrapHandoff.verify(data:vector,expectedRunID:payload["runId"] as! String,
                    manifestIdentity:payload["manifestIdentity"] as! String,
                    configIdentity:payload["configIdentity"] as! String,expiresAt:payload["expiresAt"] as! Int,
                    capability:exactCapability,executables:exactAuthority,composition:expectation,
                challenge:exactChallenge)
            }
        }
        var noncanonical=exact; noncanonical.append(0x0a)
        #expect(throws:VMFailure.admissionUnavailable) { _ = try BootstrapHandoff.verify(data:noncanonical,
            expectedRunID:payload["runId"] as! String,manifestIdentity:payload["manifestIdentity"] as! String,
            configIdentity:payload["configIdentity"] as! String,expiresAt:payload["expiresAt"] as! Int,
            capability:exactCapability,executables:exactAuthority,composition:expectation,
                challenge:exactChallenge) }
        var badMAC=envelope; badMAC["mac"]=String(repeating:"0",count:64)
        #expect(throws:VMFailure.admissionUnavailable) { _ = try BootstrapHandoff.verify(data:try canonical(badMAC),
            expectedRunID:payload["runId"] as! String,manifestIdentity:payload["manifestIdentity"] as! String,
            configIdentity:payload["configIdentity"] as! String,expiresAt:payload["expiresAt"] as! Int,
            capability:exactCapability,executables:exactAuthority,composition:expectation,
                challenge:exactChallenge) }
        let run = try BootstrapRunFixture().run, originals = runtimeRows()
        let probe = BootstrapProbeFake([try compositionHandoff(run,originals:originals)])
        let lifecycle = BootstrapLifecycleFake(), clock = BootstrapTestClock()
        let composition = try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals)
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
        let proof = try qualification.currentProofWithoutActivation()
        #expect(proof.runID == run.binding.runID)
        #expect(proof.manifestIdentity == run.appliance.manifest.digest)
        #expect(lifecycle.starts == 1)
        #expect(throws:VMFailure.admissionUnavailable) { _ = try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        #expect(probe.requested.count == 1); #expect(lifecycle.starts == 1)
    }

    @Test func v1_wrong_epoch_generation_runtime_or_fixture_denied() throws {
        let run = try BootstrapRunFixture().run, originals = runtimeRows()
        let mutations:[([String:Any]) -> [String:Any]] = [
            { value in var x=value; var c=x["composition"] as! [String:Any]; var b=c["binding"] as! [String:Any]; b["epoch"]=2; c["binding"]=b; x["composition"]=c; return x },
            { value in var x=value; var c=x["composition"] as! [String:Any]; var e=c["eventCheckpoint"] as! [String:Any]; e["generation"]=2; c["eventCheckpoint"]=e; x["composition"]=c; return x },
            { value in var x=value; var c=x["composition"] as! [String:Any]; c["fixtureInventoryDigest"]=String(repeating:"0",count:64); x["composition"]=c; return x },
            { value in var x=value; var c=x["composition"] as! [String:Any]; var r=c["roleRuntime"] as! [[String:Any]]; r[0]["childId"]=String(repeating:"0",count:32); c["roleRuntime"]=r; x["composition"]=c; return x },
        ]
        for mutation in mutations {
            let probe = BootstrapProbeFake([try compositionHandoff(run,originals:originals,mutate:mutation)])
            let lifecycle=BootstrapLifecycleFake(), clock=BootstrapTestClock()
            let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals)
            #expect(throws:VMFailure.admissionUnavailable) { _ = try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        }
    }

    @Test func v1_current_descriptor_provenance_and_lifecycle_required() throws {
        let run = try BootstrapRunFixture().run, originals = runtimeRows()
        for variant in 0...2 {
            let data = try compositionHandoff(run,originals:originals) { value in
                var x=value, c=x["composition"] as! [String:Any], rows=c["roleRuntime"] as! [[String:Any]]
                if variant == 0 { rows[3]["lifecycle"]="WAITING" }
                if variant == 1 { rows[3]["childId"]=String(repeating:"e",count:32) }
                if variant == 2 { var fds=rows[3]["currentFDs"] as! [[String:Any]]; fds[5]["ownerId"]=String(repeating:"e",count:32); rows[3]["currentFDs"]=fds }
                c["roleRuntime"]=rows; x["composition"]=c; return x
            }
            let probe=BootstrapProbeFake([data]), lifecycle=BootstrapLifecycleFake(), clock=BootstrapTestClock()
            let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals)
            #expect(throws:VMFailure.admissionUnavailable) { _ = try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
        }
    }

    @Test func v1_initial_event_owner_precedes_snapshot() throws {
        let run = try BootstrapRunFixture().run, originals = runtimeRows(), lifecycle=BootstrapLifecycleFake()
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)]), clock=BootstrapTestClock()
        let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals)
        probe.onCapture = { #expect(composition.eventOwnerOwnsActiveCapture) }
        _ = try OfflineVMHost.bootstrapCheck(run:run,composition:composition)
    }

    @Test func v1_late_capture_cleanup_remains_typed() throws {
        let run = try BootstrapRunFixture().run, originals = runtimeRows()
        let foreignProbe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)])
        let foreign=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
            probe:foreignProbe,lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock(),originals:originals))
        let initial=BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                                        try compositionHandoff(run,originals:originals,sequence:2)])
        let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
            probe:initial,lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock(),originals:originals))
        initial.onCapture = { throw BootstrapCleanupFailure(cleanup:foreign) }
        #expect(throws:BootstrapCleanupFailure.self) { _ = try q.requireBrowserAdmission() }
        #expect(q.cleanupUncertain)
    }

    @Test func v1_effect_boundary_grant_expiry_cancel_denied() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows(), lifecycle=BootstrapLifecycleFake()
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals),try compositionHandoff(run,originals:originals,sequence:2)])
        let clock=BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:12))
        let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals))
        let activation=BootstrapActivationFake(); activation.handle.callback={ lifecycle.triggerDrift() }
        #expect(throws:VMFailure.self) { try q.activateBrowser(activation) }
        #expect(activation.handle.calls == 0)
        #expect(activation.handle.stops >= 1)
    }

    @Test func v1_native_descriptor_or_delivery_fence_unavailable_stays_denied() throws {
        let run=try BootstrapRunFixture().run, originals=runtimeRows(), lifecycle=BootstrapLifecycleFake(), clock=BootstrapTestClock()
        let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals)])
        let composition=try offlineComposition(run,probe:probe,lifecycle:lifecycle,clock:clock,originals:originals)
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(run:run,composition:composition) }
        #expect(probe.requested.isEmpty); #expect(lifecycle.starts == 0)
    }

    @Test func v1_cli_missing_native_prerequisites_has_zero_effects() throws {
        var effects=0
        let command=try HostDispatch.parse(["bootstrap-check","--manifest","/signed/m","--release","/signed/r"])
        #expect(throws:VMFailure.unavailable) { _ = try HostDispatch.execute(command) { _,_,_,_,_ in effects += 1; return [] } }
        #expect(effects == 0)
        let invocation=try #require(try HostDispatch.bootstrapInvocation(["bootstrap-check","--manifest","/signed/m","--release","/signed/r"]))
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(invocation:invocation) }
        #expect(effects == 0)
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
        let roles = payload["roles"] as! [[String:Any]]
        #expect(throws:Never.self) { try BootstrapHandoff.validateRolesV2(roles,runID:runID,programPins:pythonProgramPins,runtime:originals,originals:originals,generation:1) }
        for (key,value) in [("waiting",false as Any),("noNewPrivs",0),("seccomp",0),("uids",[0,0,0])] {
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
    private func selectorRuntimeRows(sharedInode:Bool = true) -> [[String:Any]] {
        var rows = runtimeRows(), fds = Array((rows[3]["currentFDs"] as! [[String:Any]]).prefix(5))
        // Pinned Linux6.8 fs/eventpoll.c:2055–2056 calls anon_inode_getfile;
        // fs/anon_inodes.c:96–106,137–147 uses one inode for distinct file owners.
        // Member SHA256s: eventpoll.c c8b2fed972bcb1621c8efec4b299ee5011f398d1ca2d95be9bb20f08ce8c6d96;
        // anon_inodes.c 77dda97cc9a37fa66adad6b22abbef629962b9a64cab95ebfe80353f6753bd58.
        // These literal observations create no native selector or provenance.
        let extras:[(String,String,String)] = [
            ("PROXY_LISTENER","9","900"), ("PROXY_STOP_SELECTOR","16","1066"),
            ("PROXY_ACCEPTED_STREAM","9","901"), ("PROXY_VSOCK_STREAM","9","902"),
            ("PROXY_CONNECT_SELECTOR","16",sharedInode ? "1066":"1067")]
        for (index,extra) in extras.enumerated() {
            fds.append(["fd":index+5,"kind":extra.0,"device":extra.1,"inode":extra.2,"flags":2,
                        "ownerId":String(format:"%032x",500+index),"acquiredGeneration":1])
        }
        rows[3]["currentFDs"] = fds; return rows
    }
    @Test func t4_r1_distinct_original_selectors_can_share_anonymous_inode() throws {
        for shared in [false,true] {
            let original = selectorRuntimeRows(sharedInode:shared)
            #expect(throws:Never.self) { try BootstrapHandoff.validateRoleRuntimeV1(original,originals:original,generation:1) }
        }
    }
    @Test func t4_r1_shared_selector_inode_does_not_replace_original_provenance() throws {
        let original = selectorRuntimeRows()
        for (key,value) in [("ownerId",String(repeating:"e",count:32) as Any),("fd",10),
                            ("kind","PROXY_STOP_SELECTOR"),("flags",0),("device","17"),("inode","1067"),("acquiredGeneration",2)] {
            var changed = original, fds = original[3]["currentFDs"] as! [[String:Any]]
            fds[9][key] = value; changed[3]["currentFDs"] = fds
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:original,generation:2) }
        }
        for variant in 0...6 {
            var changed = original, fds = original[3]["currentFDs"] as! [[String:Any]]
            switch variant {
            case 0: fds[9]["ownerId"] = fds[6]["ownerId"] // Reuse a stop owner for a connect selector.
            case 1: fds[9]["fd"] = fds[6]["fd"]
            case 2: fds[9]["kind"] = "RUNTIME_INTERNAL"
            case 3: fds[8]["inode"] = fds[7]["inode"] // Socket/socket collision remains forbidden.
            case 4: fds[9]["device"] = fds[5]["device"]; fds[9]["inode"] = fds[5]["inode"] // Earlier socket.
            case 5: fds[8]["device"] = fds[6]["device"]; fds[8]["inode"] = fds[6]["inode"] // Earlier selector.
            default: fds[9]["device"] = fds[3]["device"]; fds[9]["inode"] = fds[3]["inode"] // Inherited pipe.
            }
            changed[3]["currentFDs"] = fds
            #expect(throws:VMFailure.admissionUnavailable) { try BootstrapHandoff.validateRoleRuntimeV1(changed,originals:changed,generation:1) }
        }
    }
    @Test func local_n5_typed_capture_failure_remains_sticky_at_every_gate_entry() throws {
        // T10-13: one sequence-1 legacy handoff per run, so each qualification
        // here has its own run; the literal-wire path captures again only
        // through activateBrowser (requireBrowserAdmission is composition-only).
        let originalRun = try BootstrapRunFixture().run, run = try BootstrapRunFixture().run
        let original = try OfflineVMHost.bootstrapCheck(run:originalRun,
            probe:BootstrapProbeFake([try handoff(originalRun)]),lifecycle:BootstrapLifecycleFake(),
            executables:try executableAuthority(originalRun),clock:BootstrapTestClock())
        let probe = BootstrapProbeFake([try handoff(run),try handoff(run,sequence:2)])
        let q = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),
            executables:try executableAuthority(run),clock:BootstrapTestClock())
        probe.onCapture = { throw BootstrapCleanupFailure(cleanup:original) }
        for operation in [{ try q.activateBrowser(BootstrapActivationFake()) },
                          { _ = try q.requireBrowserAdmission() },
                          { _ = try q.currentProofWithoutActivation() }] {
            do { try operation(); Issue.record("cleanup failure returned admission") }
            catch let error as BootstrapCleanupFailure { #expect(error.cleanup === q) }
        }
        #expect(q.cleanupUncertain)
        let third = try BootstrapRunFixture().run
        #expect(throws:BootstrapCleanupFailure.self) {
            _ = try OfflineVMHost.bootstrapCheck(run:third,probe:probe,lifecycle:BootstrapLifecycleFake(),
                executables:try executableAuthority(third),clock:BootstrapTestClock())
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
            executables:try BootstrapExecutableAuthority.offlineLiteral(pins:pythonProgramPins),challenge:nil)
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
                    executables:try BootstrapExecutableAuthority.offlineLiteral(pins:pythonProgramPins),challenge:nil)
            }
        }
    }

    @Test func native_entry_remains_fail_closed_and_composition_selection_is_bounded() throws {
        let run = try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(run:run) }
        _ = try NativeBootstrapComposition.select(manifestPath:"/signed/manifest.json",releasePath:"/signed/release.json",platform:"darwin",machine:"arm64")
        #expect(throws:VMFailure.admissionUnavailable) { _ = try NativeBootstrapComposition.select(manifestPath:"",releasePath:"x",platform:"darwin",machine:"arm64") }
        #expect(throws:VMFailure.admissionUnavailable) { _ = try NativeBootstrapComposition.select(manifestPath:"/signed/m",releasePath:"/signed/r",platform:"linux",machine:"aarch64") }
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
            let run = try BootstrapRunFixture().run  // one sequence-1 legacy handoff per run
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

        let lifecycle2 = BootstrapLifecycleFake(), run2 = try BootstrapRunFixture().run
        var malformed = try handoff(run2,sequence:2); malformed.append(0)
        let q2 = try OfflineVMHost.bootstrapCheck(run:run2,
            probe:BootstrapProbeFake([try handoff(run2),malformed]),lifecycle:lifecycle2,
            executables:try executableAuthority(run2),clock:BootstrapTestClock())
        #expect(throws:VMFailure.self) { try q2.activateBrowser(BootstrapActivationFake()) }
        #expect(lifecycle2.stops == 1)
    }

    @Test func rollback_expiry_malformed_and_lifecycle_drift_latch_terminal() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let q = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake([try handoff(run)]),lifecycle:lifecycle,executables:try executableAuthority(run),clock:BootstrapTestClock())
        lifecycle.triggerDrift()
        #expect(lifecycle.stops == 1)
        #expect(throws:VMFailure.terminal) { _ = try q.currentProofWithoutActivation() }
        #expect(throws:VMFailure.terminal) { _ = try q.currentProofWithoutActivation() }

        // One sequence-1 legacy handoff per run (T10-13): each check has its own run.
        let rollback = BootstrapTestClock([.init(wall:100,monotonic:10),.init(wall:99,monotonic:11)])
        let rollbackRun = try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:rollbackRun,probe:BootstrapProbeFake([try handoff(rollbackRun)]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(rollbackRun),clock:rollback) }
        let malformedRun = try BootstrapRunFixture().run
        var malformed = try handoff(malformedRun); malformed.append(0)
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:malformedRun,probe:BootstrapProbeFake([malformed]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(malformedRun),clock:BootstrapTestClock()) }

        let expiryClock = BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:4)
                                              + [.init(wall:100,monotonic:10),.init(wall:190,monotonic:11)])
        let expiryRun = try BootstrapRunFixture().run
        let expiring = try OfflineVMHost.bootstrapCheck(run:expiryRun,probe:BootstrapProbeFake([try handoff(expiryRun)]),lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(expiryRun),clock:expiryClock)
        #expect(throws:VMFailure.expired) { try expiring.activateBrowser(BootstrapActivationFake()) }
        #expect(throws:VMFailure.terminal) { try expiring.activateBrowser(BootstrapActivationFake()) }

        let duringBegin = BootstrapLifecycleFake(); duringBegin.driftOnBegin = true
        let beginRun = try BootstrapRunFixture().run
        #expect(throws:VMFailure.terminal) {
            _ = try OfflineVMHost.bootstrapCheck(run:beginRun,probe:BootstrapProbeFake([try handoff(beginRun)]),
                lifecycle:duringBegin,executables:try executableAuthority(beginRun),clock:BootstrapTestClock())
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

        let live = BootstrapLifecycleFake(), liveRun = try BootstrapRunFixture().run
        let q = try OfflineVMHost.bootstrapCheck(run:liveRun,
            probe:BootstrapProbeFake([try handoff(liveRun),try handoff(liveRun,sequence:2)]),
            lifecycle:live,executables:try executableAuthority(liveRun),clock:BootstrapTestClock())
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

    // MARK: Task 3 (E2, E3 part 1; T10-1, T10-7, T10-10, T10-13)

    private func nonce(_ first:Int) -> Data { Data((first..<(first+16)).map { UInt8($0) }) }
    private func retainedPins(_ run:RunConfiguration) throws -> [String:String] {
        let inventory=try OfflineInstalledExecutableInventory.decode(try ApplianceFixture().inventoryBytes(),appliance:run.appliance)
        return Dictionary(uniqueKeysWithValues:inventory.records.map { ($0.installedPath,$0.memberSHA256) })
    }
    private func verifyComposition(_ run:RunConfiguration,_ data:Data,originals:[[String:Any]],
                                   challenge:BootstrapChallenge?) throws -> AdmissionProof {
        let expectation=BootstrapCompositionExpectation(rolePolicyDigest:String(repeating:"d",count:64),
            epoch:1,generation:1,probeEpochDigest:String(repeating:"e",count:64),
            fixtureInventoryDigest:String(repeating:"f",count:64),eventSourceID:String(repeating:"a",count:32),
            proxyRuntimeID:String(repeating:"b",count:32),originalRoleRuntime:originals)
        return try BootstrapHandoff.verify(data:data,expectedRunID:run.binding.runID,
            manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
            expiresAt:run.binding.expiresAt,capability:run.capability,
            executables:try BootstrapExecutableAuthority.offlineLiteral(pins:try retainedPins(run)),
            composition:expectation,challenge:challenge)
    }
    private func resigned(_ data:Data,key:Data) throws -> Data {
        var envelope=try #require(try JSONSerialization.jsonObject(with:data) as? [String:Any])
        let payload=try #require(envelope["payload"] as? [String:Any]), version=try #require(envelope["version"] as? Int)
        let domain=version == 2 ? Data("acceptance:bootstrap-composition:v1\0".utf8):Data(), body=try canonical(payload)
        envelope["mac"]=HMAC<SHA256>.authenticationCode(for:domain + body,using:SymmetricKey(data:key))
            .map { String(format:"%02x",$0) }.joined()
        return try canonical(envelope)
    }

    @Test func v1_channel_key_derivation_matches_python_vectors() throws {
        // C3 vectors from the plan (Python hmac); never edited to match.
        let capability=Data(repeating:7,count:32)
        func hex(_ value:Data) -> String { value.map { String(format:"%02x",$0) }.joined() }
        #expect(hex(try ChannelKeys.derive(capability:capability,label:"vsock-stream"))
            == "5814c7147c97464dd6833b65cfd337b5d6f8277a080522efe9c3f7f498d54d00")
        #expect(hex(try ChannelKeys.derive(capability:capability,label:"topology-admission"))
            == "49206226671c56e90e00b0198cbeca8b32acb63e5e5c714b12989d3172cf0e49")
        for label in ["vsock","topology-admission\0","TOPOLOGY-ADMISSION","","bootstrap-composition"] {
            #expect(throws:VMFailure.admissionUnavailable) { _=try ChannelKeys.derive(capability:capability,label:label) }
        }
        for bad in [Data(count:31),Data(count:33),Data()] {
            #expect(throws:VMFailure.admissionUnavailable) { _=try ChannelKeys.derive(capability:bad,label:"vsock-stream") }
        }
    }

    @Test func v1_host_challenge_is_one_use_and_host_deadline_bound() throws {
        #expect(BOOTSTRAP_CHALLENGE_INITIAL_MS == 120000); #expect(BOOTSTRAP_CHALLENGE_CURRENT_MS == 2000)
        let start=ClockSample(wall:100,monotonic:10)
        // Issuer: nonce bytes 00..0f; the answering handoff is consumed once.
        do {
            let issuer=BootstrapChallengeIssuer(nonces:BootstrapNonceFake())
            let challenge=try issuer.issue(kind:.initial,at:start)
            #expect(challenge.value == testHostChallenge); #expect(challenge.kind == .initial)
            #expect(throws:Never.self) { try issuer.consume(challenge,handoffChallenge:testHostChallenge,at:start) }
            #expect(throws:VMFailure.admissionUnavailable) {
                try issuer.consume(challenge,handoffChallenge:testHostChallenge,at:start) }
        }
        // Deadlines on host monotonic time only: exactly at the deadline admits, +1 ms denies.
        for (kind,limit) in [(BootstrapChallengeKind.initial,120000),(.current,2000)] {
            for (elapsed,admits) in [(limit,true),(limit+1,false)] {
                let issuer=BootstrapChallengeIssuer(nonces:BootstrapNonceFake([nonce(0),nonce(16)]))
                if kind == .current {
                    let initial=try issuer.issue(kind:.initial,at:start)
                    try issuer.consume(initial,handoffChallenge:initial.value,at:start)
                }
                let challenge=try issuer.issue(kind:kind,at:start)
                // Guest-local wall time is irrelevant: the host wall sample never moves here.
                let at=ClockSample(wall:100,monotonic:10+elapsed)
                if admits {
                    #expect(throws:Never.self) { try issuer.consume(challenge,handoffChallenge:challenge.value,at:at) }
                } else {
                    #expect(throws:VMFailure.admissionUnavailable) {
                        try issuer.consume(challenge,handoffChallenge:challenge.value,at:at) }
                }
            }
        }
        // A different answer, or a host clock behind the issue sample, is denied.
        do {
            let issuer=BootstrapChallengeIssuer(nonces:BootstrapNonceFake())
            let challenge=try issuer.issue(kind:.initial,at:start)
            #expect(throws:VMFailure.admissionUnavailable) {
                try issuer.consume(challenge,handoffChallenge:"101112131415161718191a1b1c1d1e1f",at:start) }
            let other=BootstrapChallengeIssuer(nonces:BootstrapNonceFake())
            let late=try other.issue(kind:.initial,at:start)
            #expect(throws:VMFailure.admissionUnavailable) {
                try other.consume(late,handoffChallenge:late.value,at:ClockSample(wall:100,monotonic:9)) }
        }
        // Full path: the composition issues 00..0f and the answering handoff admits;
        // a current check whose handoff arrives 2001 host-ms after issue is denied.
        let originals=runtimeRows()
        for (elapsed,admits) in [(2000,true),(2001,false)] {
            let run=try BootstrapRunFixture(durationMs:10000).run, lifecycle=BootstrapLifecycleFake()
            let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                                          try compositionHandoff(run,originals:originals,sequence:2)])
            let clock=BootstrapTestClock(Array(repeating:.init(wall:100,monotonic:10),count:6)
                                         + [.init(wall:100,monotonic:10+elapsed)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:lifecycle,clock:clock,originals:originals))
            #expect(probe.challenges == [testHostChallenge])
            if admits {
                #expect(throws:Never.self) { _=try q.requireBrowserAdmission() }
            } else {
                #expect(throws:VMFailure.admissionUnavailable) { _=try q.requireBrowserAdmission() }
                #expect(lifecycle.stops == 1)
            }
            #expect(probe.challenges == [testHostChallenge,testHostChallenge])
        }
        // Guest observedWall/observedMonotonic are guest-local: 0 and 2^53-1 both
        // admit on the composition (initial and current) and the literal-wire paths.
        for observed in [0,9007199254740991] {
            let run=try BootstrapRunFixture().run
            let probe=BootstrapProbeFake([
                try compositionHandoff(run,originals:originals,wall:observed,monotonic:observed),
                try compositionHandoff(run,originals:originals,sequence:2,wall:observed,monotonic:observed)])
            #expect(throws:Never.self) {
                let q=try OfflineVMHost.bootstrapCheck(run:run,composition:self.offlineComposition(run,
                    probe:probe,lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock(),originals:originals))
                let proof=try q.requireBrowserAdmission()
                #expect(proof.observedWall == observed); #expect(proof.observedMonotonic == observed)
            }
            let legacy=try BootstrapRunFixture().run
            #expect(throws:Never.self) {
                let q=try OfflineVMHost.bootstrapCheck(run:legacy,probe:BootstrapProbeFake([
                    try handoff(legacy,wall:observed,monotonic:observed),
                    try handoff(legacy,sequence:2,wall:observed,monotonic:observed)]),
                    lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(legacy),
                    clock:BootstrapTestClock())
                try q.activateBrowser(BootstrapActivationFake())
            }
        }
    }

    @Test func v1_internal_current_handoff_without_challenge_denied() throws {
        // R3: a guest-internal current (require_current) carries no hostChallenge.
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        do {
            let lifecycle=BootstrapLifecycleFake()
            let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                try compositionHandoff(run,originals:originals,sequence:2,challenge:nil)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals))
            #expect(throws:VMFailure.admissionUnavailable) { _=try q.requireBrowserAdmission() }
            #expect(lifecycle.stops == 1)
            #expect(probe.challenges == [testHostChallenge,testHostChallenge])
        }
        do {
            let lifecycle=BootstrapLifecycleFake()
            let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals,challenge:nil)])
            #expect(throws:VMFailure.admissionUnavailable) {
                _=try OfflineVMHost.bootstrapCheck(run:run,composition:self.offlineComposition(run,
                    probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)) }
            #expect(lifecycle.starts == 0)
        }
        do {  // Control: the same current answering the host challenge admits.
            let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                try compositionHandoff(run,originals:originals,sequence:2)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock(),originals:originals))
            #expect(throws:Never.self) { _=try q.requireBrowserAdmission() }
        }
    }

    @Test func v1_initial_challenge_cannot_satisfy_current_check() throws {
        let start=ClockSample(wall:100,monotonic:10)
        let issuer=BootstrapChallengeIssuer(nonces:BootstrapNonceFake([nonce(0),nonce(16),nonce(32)]))
        let initial=try issuer.issue(kind:.initial,at:start)
        // No current challenge exists before the initial one is consumed.
        #expect(throws:VMFailure.admissionUnavailable) { _=try issuer.issue(kind:.current,at:start) }
        try issuer.consume(initial,handoffChallenge:initial.value,at:start)
        // A consumed initial challenge never answers again, and no second initial is issued.
        #expect(throws:VMFailure.admissionUnavailable) { try issuer.consume(initial,handoffChallenge:initial.value,at:start) }
        #expect(throws:VMFailure.admissionUnavailable) { _=try issuer.issue(kind:.initial,at:start) }
        let current=try issuer.issue(kind:.current,at:start)
        #expect(current.kind == .current)
        #expect(throws:VMFailure.admissionUnavailable) {
            try issuer.consume(current,handoffChallenge:initial.value,at:start) }
        // Full path: nonces 00..0f then 10..1f. A current handoff that answers the
        // initial challenge is denied; the one answering the current challenge admits.
        let run=try BootstrapRunFixture().run, originals=runtimeRows()
        let second="101112131415161718191a1b1c1d1e1f"
        for (answer,admits) in [(testHostChallenge,false),(second,true)] {
            let lifecycle=BootstrapLifecycleFake()
            let probe=BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                try compositionHandoff(run,originals:originals,sequence:2,challenge:answer)])
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals,
                nonces:BootstrapNonceFake([nonce(0),nonce(16)])))
            if admits {
                #expect(throws:Never.self) { _=try q.requireBrowserAdmission() }
            } else {
                #expect(throws:VMFailure.admissionUnavailable) { _=try q.requireBrowserAdmission() }
                #expect(lifecycle.stops == 1)
            }
            #expect(probe.challenges == [testHostChallenge,second])
        }
    }

    @Test func v1_handoff_mac_with_raw_capability_denied() throws {
        let originals=runtimeRows()
        let vsock=try ChannelKeys.derive(capability:Data(repeating:7,count:32),label:"vsock-stream")
        do {  // Composition, initial check.
            let run=try BootstrapRunFixture().run
            for (data,admits) in [(try compositionHandoff(run,originals:originals,rawKey:true),false),
                                  (try resigned(try compositionHandoff(run,originals:originals),key:vsock),false),
                                  (try compositionHandoff(run,originals:originals),true)] {
                let lifecycle=BootstrapLifecycleFake()
                let composition=try offlineComposition(run,probe:BootstrapProbeFake([data]),
                    lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals)
                if admits {
                    #expect(throws:Never.self) { _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
                } else {
                    #expect(throws:VMFailure.admissionUnavailable) {
                        _=try OfflineVMHost.bootstrapCheck(run:run,composition:composition) }
                    #expect(lifecycle.starts == 0)
                }
            }
        }
        do {  // Composition, current check.
            let run=try BootstrapRunFixture().run, lifecycle=BootstrapLifecycleFake()
            let q=try OfflineVMHost.bootstrapCheck(run:run,composition:offlineComposition(run,
                probe:BootstrapProbeFake([try compositionHandoff(run,originals:originals),
                    try compositionHandoff(run,originals:originals,sequence:2,rawKey:true)]),
                lifecycle:lifecycle,clock:BootstrapTestClock(),originals:originals))
            #expect(throws:VMFailure.admissionUnavailable) { _=try q.requireBrowserAdmission() }
            #expect(lifecycle.stops == 1)
        }
        // Literal wire (v1).
        let raw=try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try OfflineVMHost.bootstrapCheck(run:raw,probe:BootstrapProbeFake([try handoff(raw,rawKey:true)]),
                lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(raw),clock:BootstrapTestClock()) }
        let control=try BootstrapRunFixture().run
        #expect(throws:Never.self) {
            _=try OfflineVMHost.bootstrapCheck(run:control,probe:BootstrapProbeFake([try handoff(control)]),
                lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(control),clock:BootstrapTestClock()) }
    }

    @Test func v1_host_challenge_excluded_from_stable_digest_but_macd() throws {
        // P6: hostChallenge is MAC-covered but excluded from the stable digest.
        let run=try BootstrapRunFixture().run, originals=runtimeRows(), start=ClockSample(wall:100,monotonic:10)
        let first=try BootstrapChallengeIssuer(nonces:BootstrapNonceFake([nonce(0)])).issue(kind:.initial,at:start)
        let second=try BootstrapChallengeIssuer(nonces:BootstrapNonceFake([nonce(16)])).issue(kind:.initial,at:start)
        let a=try verifyComposition(run,try compositionHandoff(run,originals:originals,challenge:first.value),
                                    originals:originals,challenge:first)
        let b=try verifyComposition(run,try compositionHandoff(run,originals:originals,challenge:second.value),
                                    originals:originals,challenge:second)
        #expect(a.hostChallenge == first.value); #expect(b.hostChallenge == second.value)
        #expect(a.topologyDigest == b.topologyDigest)
        #expect(a.roleInventoryDigest == b.roleInventoryDigest)
        #expect(a.deviceInventoryDigest == b.deviceInventoryDigest)
        // Tampering the answered value without the key fails the MAC, even when
        // the tampered value matches the challenge the host now holds.
        var envelope=try #require(try JSONSerialization.jsonObject(with:
            try compositionHandoff(run,originals:originals,challenge:first.value)) as? [String:Any])
        var payload=try #require(envelope["payload"] as? [String:Any])
        payload["hostChallenge"]=second.value; envelope["payload"]=payload
        let tampered=try canonical(envelope)
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try self.verifyComposition(run,tampered,originals:originals,challenge:second) }
        // The host challenge it holds must be the one answered.
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try self.verifyComposition(run,try self.compositionHandoff(run,originals:originals,challenge:first.value),
                                         originals:originals,challenge:second) }
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try self.verifyComposition(run,try self.compositionHandoff(run,originals:originals,challenge:first.value),
                                         originals:originals,challenge:nil) }
    }

    @Test func v1_legacy_handoff_one_use_per_run_and_never_operational() throws {
        // T10-13: one sequence-1 literal-wire handoff per run.
        let run=try BootstrapRunFixture().run
        let first=BootstrapProbeFake([try handoff(run)]), second=BootstrapProbeFake([try handoff(run)])
        #expect(throws:Never.self) {
            _=try OfflineVMHost.bootstrapCheck(run:run,probe:first,lifecycle:BootstrapLifecycleFake(),
                executables:try executableAuthority(run),clock:BootstrapTestClock()) }
        let lifecycle=BootstrapLifecycleFake()
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try OfflineVMHost.bootstrapCheck(run:run,probe:second,lifecycle:lifecycle,
                executables:try executableAuthority(run),clock:BootstrapTestClock()) }
        #expect(second.requested.isEmpty); #expect(lifecycle.starts == 0)
        // A failed check also spends the run's one claim.
        let failed=try BootstrapRunFixture().run
        var malformed=try handoff(failed); malformed.append(0)
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try OfflineVMHost.bootstrapCheck(run:failed,probe:BootstrapProbeFake([malformed]),
                lifecycle:BootstrapLifecycleFake(),executables:try executableAuthority(failed),clock:BootstrapTestClock()) }
        let retry=BootstrapProbeFake([try handoff(failed)])
        #expect(throws:VMFailure.admissionUnavailable) {
            _=try OfflineVMHost.bootstrapCheck(run:failed,probe:retry,lifecycle:BootstrapLifecycleFake(),
                executables:try executableAuthority(failed),clock:BootstrapTestClock()) }
        #expect(retry.requested.isEmpty)
        // Never operational: browser admission requires a composition (P7).
        let live=try BootstrapRunFixture().run, liveLifecycle=BootstrapLifecycleFake()
        let probe=BootstrapProbeFake([try handoff(live),try handoff(live,sequence:2)])
        let q=try OfflineVMHost.bootstrapCheck(run:live,probe:probe,lifecycle:liveLifecycle,
            executables:try executableAuthority(live),clock:BootstrapTestClock())
        #expect(throws:VMFailure.admissionUnavailable) { _=try q.requireBrowserAdmission() }
        #expect(probe.requested.count == 1); #expect(liveLifecycle.stops == 1)
        #expect(throws:VMFailure.terminal) { _=try q.currentProofWithoutActivation() }
    }
}
