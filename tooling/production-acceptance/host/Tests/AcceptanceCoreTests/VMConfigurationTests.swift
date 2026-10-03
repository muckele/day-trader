import Foundation
import Testing
import Virtualization
@testable import AcceptanceCore

struct ApplianceFixture {
    let object:[String:Any], expected:String, locations:[String:URL]
    init() throws {
        let path = try #require(ProcessInfo.processInfo.environment["M3_APPLIANCE_INPUT"])
        let url = URL(fileURLWithPath:path), bytes = try Data(contentsOf:url)
        try #require(bytes.count <= 131072)
        let bundle = try #require(JSONSerialization.jsonObject(with:bytes) as? [String:Any])
        try #require(Set(bundle.keys) == Set(["bundleVersion","manifest","expectedManifestDigest","files"]))
        try #require(bundle["bundleVersion"] as? Int == 1)
        try #require(bundle["files"] as? [String:String] == ["base":"base.synthetic","kernel":"kernel.synthetic","initramfs":"initramfs.synthetic"])
        object = try #require(bundle["manifest"] as? [String:Any]); expected = try #require(bundle["expectedManifestDigest"] as? String)
        locations = ["base","kernel","initramfs"].reduce(into:[:]) { $0[$1] = url.deletingLastPathComponent().appendingPathComponent($1+".synthetic") }
    }
    func wire(_ value:[String:Any]? = nil) throws -> Data { try JSONSerialization.data(withJSONObject:value ?? object,options:[.sortedKeys,.withoutEscapingSlashes]) }
    func manifest() throws -> ApplianceManifest { try ApplianceManifest.decode(wire()) }
    func legacyObject() -> [String:Any] {
        var x = object, policy = x["policy"] as! [String:Any], layout = policy["layout"] as! [String:Any]
        layout.removeValue(forKey:"browserWorker"); policy["layout"] = layout; policy.removeValue(forKey:"bootstrapComposition")
        policy["kernelFeatures"] = (policy["kernelFeatures"] as! [String]).filter { !["CONFIG_AUDIT","CONFIG_AUDITSYSCALL","CONFIG_INOTIFY_USER"].contains($0) }
        x["policy"] = policy; x["manifestVersion"] = 1
        x["components"] = (x["components"] as! [[String:Any]]).filter { $0["id"] as? String != "browserWorker" }
        return x
    }
    func verified() throws -> ArtifactVerifiedAppliance { try manifest().verifyArtifacts(locations:locations,expectedManifestDigest:expected) }
    func inventoryBytes() throws -> Data {
        let path = try #require(ProcessInfo.processInfo.environment["M3_APPLIANCE_INPUT"])
        return try Data(contentsOf:URL(fileURLWithPath:path).deletingLastPathComponent().appendingPathComponent("executable-members.json"))
    }
    func memberBytes() -> [String:Data] {
        let literals = [("browserWorker","/opt/acceptance/guest/browser-worker.cjs"),("controller","/opt/acceptance/guest/controller.cjs"),
                        ("proxy","/opt/acceptance/guest/proxy.py"),("verifier","/opt/acceptance/guest/verifier.cjs"),
                        ("node","/opt/acceptance/runtime/node/bin/node"),("python","/opt/acceptance/runtime/python/bin/python3"),
                        ("chromium","/opt/acceptance/runtime/chromium/chrome")]
        return Dictionary(uniqueKeysWithValues:literals.map { id,path in
            (path,Data(((["node","python","chromium"].contains(id) ? "SYNTHETIC NONBOOTABLE ":"SYNTHETIC ")+id+"\n").utf8))
        })
    }
    func policy(_ section:String,_ key:String,_ value:Any) -> [String:Any] {
        var result = object, p = result["policy"] as! [String:Any], row = p[section] as! [String:Any]
        row[key] = value; p[section] = row; result["policy"] = p; return result
    }
}
@Suite(.serialized) struct VMConfigurationTests {
    @Test func v1_manifest_payload_and_reference_match_python() throws {
        let f = try ApplianceFixture()
        #expect((try? ApplianceManifest.decode(f.wire()).digest) == f.expected)
        let m = try f.manifest(); #expect(try m.canonicalBytes() == f.wire())
        let p = f.object["policy"] as! [String:Any], composition = p["bootstrapComposition"] as! [String:Any]
        #expect(composition["referenceDigest"] as? String == "a2e1be5762976e07f270c6646ce5e4d94c48efcc2c78dacaf29ed3e32471be7d")
        var x = f.object, policy = p, changed = composition
        changed["referenceDigest"] = String(repeating:"0",count:64); policy["bootstrapComposition"] = changed; x["policy"] = policy
        #expect(throws:ApplianceFailure.policy) { _ = try ApplianceManifest.decode(f.wire(x)) }
    }
    @Test func v1_legacy_manifest_cannot_admit_bootstrap() throws {
        let f = try ApplianceFixture(), raw = try f.wire(f.legacyObject()), legacy = try ApplianceManifest.decode(raw)
        #expect(try legacy.canonicalBytes() == raw)
        #expect(throws:ApplianceFailure.qualificationUnavailable) { try legacy.requireComposition() }
        var missing = f.object
        missing["components"] = (missing["components"] as! [[String:Any]]).filter { $0["id"] as? String != "browserWorker" }
        missing["missingPayload"] = ["browserWorker"]; missing["payloadState"] = "INCOMPLETE"
        let incomplete = try ApplianceManifest.decode(f.wire(missing))
        #expect(throws:ApplianceFailure.payloadIncomplete) { try incomplete.requireComposition() }
    }
    @Test func v1_worker_direct_mapping_and_member_bytes_required() throws {
        let f = try ApplianceFixture(), appliance = try f.verified()
        #expect(throws:Never.self) {
            let inventory = try OfflineInstalledExecutableInventory.decode(f.inventoryBytes(),appliance:appliance)
            _ = try inventory.validateMemberBytes(f.memberBytes())
            for row in inventory.records where !row.memberPath.isEmpty { #expect(row.memberSHA256 != row.artifactSHA256) }
        }
        let original = try JSONSerialization.jsonObject(with:f.inventoryBytes()) as! [String:Any]
        for key in ["componentId","memberPath","installedPath","memberSHA256","artifactSHA256","sizeBytes"] {
            var document = original, rows = document["members"] as! [[String:Any]]
            rows[0][key] = key == "sizeBytes" ? 123 as Any : key.contains("SHA256") ? String(repeating:"0",count:64) : "guestProbes"
            document["members"] = rows
            #expect(throws:ApplianceFailure.artifactMismatch) { _ = try OfflineInstalledExecutableInventory.decode(f.wire(document),appliance:appliance) }
        }
        let inventory = try OfflineInstalledExecutableInventory.decode(f.inventoryBytes(),appliance:appliance)
        for row in inventory.records {
            var bytes = f.memberBytes(); bytes[row.installedPath] = Data("archive hash is not member bytes".utf8)
            #expect(throws:ApplianceFailure.artifactMismatch) { _ = try inventory.validateMemberBytes(bytes) }
        }
    }
    @Test func v1_population_and_original_base_owner_required() throws {
        let f = try ApplianceFixture(), appliance = try f.verified()
        #expect(throws:Never.self) {
            let inventory = try OfflineInstalledExecutableInventory.decode(f.inventoryBytes(),appliance:appliance)
            let bytes = f.memberBytes(), members = try inventory.validateMemberBytes(bytes)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:false)
            defer { try? FileManager.default.removeItem(at:dir) }
            var paths:[String:URL] = [:]
            for (index,path) in bytes.keys.sorted().enumerated() {
                let url = dir.appendingPathComponent(String(index)); try bytes[path]!.write(to:url)
                try FileManager.default.setAttributes([.posixPermissions:0o400],ofItemAtPath:url.path); paths[path] = url
            }
            let observed = try inventory.observeOfflinePopulation(members:members,originalBase:appliance,installedLocations:paths)
            try observed.recheck()
            #expect(throws:ApplianceFailure.qualificationUnavailable) { _ = try InstalledExecutableInventory.requireNative(observed) }
            #expect(throws:ApplianceFailure.identityMismatch) { _ = try inventory.observeOfflinePopulation(members:members,originalBase:f.verified(),installedLocations:paths) }
            #expect(throws:ApplianceFailure.artifactMismatch) { _ = try inventory.observeOfflinePopulation(members:members,originalBase:appliance,installedLocations:[:]) }
            let path = paths.keys.sorted()[0], url = paths[path]!
            try FileManager.default.setAttributes([.posixPermissions:0o666],ofItemAtPath:url.path)
            #expect(throws:ApplianceFailure.artifactMismatch) { _ = try inventory.observeOfflinePopulation(members:members,originalBase:appliance,installedLocations:paths) }
            #expect(throws:ApplianceFailure.inputChanged) { try observed.recheck() }
        }
    }
    @Test func v1_offline_inventory_cannot_mint_native_authority() throws {
        let f = try ApplianceFixture(), appliance = try f.verified()
        #expect(throws:Never.self) {
            let offline = try OfflineInstalledExecutableInventory.decode(f.inventoryBytes(),appliance:appliance)
            #expect(throws:ApplianceFailure.qualificationUnavailable) { _ = try InstalledExecutableInventory.requireNative(offline) }
            #expect(throws:ApplianceFailure.qualificationUnavailable) { _ = try InstalledExecutableInventory.requireNative(offline.records) }
        }
        var document = try JSONSerialization.jsonObject(with:f.inventoryBytes()) as! [String:Any]
        document["populationState"] = "VERIFIED"
        #expect(throws:ApplianceFailure.invalidManifest) { _ = try OfflineInstalledExecutableInventory.decode(f.wire(document),appliance:appliance) }
        document = try JSONSerialization.jsonObject(with:f.inventoryBytes()) as! [String:Any]
        for key in ["inputsDigest","manifestDigest"] {
            var changed = document; changed[key] = String(repeating:"0",count:64)
            #expect(throws:ApplianceFailure.identityMismatch) { _ = try OfflineInstalledExecutableInventory.decode(f.wire(changed),appliance:appliance) }
        }
        var base = document["baseIdentity"] as! [String:Any]; base["sha256"] = String(repeating:"0",count:64); document["baseIdentity"] = base
        #expect(throws:ApplianceFailure.identityMismatch) { _ = try OfflineInstalledExecutableInventory.decode(f.wire(document),appliance:appliance) }
    }
    @Test func v1_strict_manifest_and_inventory_wire_rejects_ambiguous_values() throws {
        let f = try ApplianceFixture(), raw = String(decoding:try f.wire(),as:UTF8.self), appliance = try f.verified()
        for value in ["true","2.0","2e0","-0","3","2,\"manifestVersion\":2"] {
            #expect(throws:ApplianceFailure.invalidManifest) { _ = try ApplianceManifest.decode(Data(raw.replacingOccurrences(of:"\"manifestVersion\":2",with:"\"manifestVersion\":"+value).utf8)) }
        }
        let inventory = String(decoding:try f.inventoryBytes(),as:UTF8.self)
        for value in ["true","1.0","1e0","1,\"inventoryVersion\":1"] {
            #expect(throws:ApplianceFailure.invalidManifest) { _ = try OfflineInstalledExecutableInventory.decode(Data(inventory.replacingOccurrences(of:"\"inventoryVersion\":1",with:"\"inventoryVersion\":"+value).utf8),appliance:appliance) }
        }
        let original = try JSONSerialization.jsonObject(with:f.inventoryBytes()) as! [String:Any]
        for variant in 0...4 {
            var document = original, rows = document["members"] as! [[String:Any]]
            switch variant {
            case 0: rows.removeLast()
            case 1: rows.append(rows[0])
            case 2: rows[0]["extra"] = 0
            case 3: rows[0]["sizeBytes"] = true
            default: document["extra"] = 0
            }
            document["members"] = rows
            #expect(throws:ApplianceFailure.invalidManifest) { _ = try OfflineInstalledExecutableInventory.decode(f.wire(document),appliance:appliance) }
        }
    }
    @Test func python_composition_identity_and_artifact_bytes() throws {
        let f = try ApplianceFixture(), m = try f.manifest(), a = try f.verified()
        #expect(m.digest == f.expected)
        for id in ["base","kernel","initramfs"] { #expect(try a.artifactBytes(id) == Data(contentsOf:f.locations[id]!)) }
        #expect(!m.runtimeBlockers.contains(.payloadIncomplete)); #expect(m.runtimeBlockers.contains(.syntheticOnly))
        #expect(m.runtimeBlockers.contains(.signingUnavailable)); #expect(m.runtimeBlockers.contains(.qualificationUnavailable))
    }
    @Test func zero_network_and_no_forbidden_objects() throws {
        let a = try ApplianceFixture().verified(), c = try a.inspectionConfiguration()
        #expect(c.networkDevices.isEmpty); #expect(c.directorySharingDevices.isEmpty); #expect(c.consoleDevices.isEmpty)
        #expect(c.audioDevices.isEmpty); #expect(c.graphicsDevices.isEmpty); #expect(c.keyboards.isEmpty); #expect(c.pointingDevices.isEmpty); #expect(c.memoryBalloonDevices.isEmpty)
        if #available(macOS 15,*) { #expect(c.usbControllers.isEmpty) }
        if #available(macOS 27,*) { #expect(c.customVirtioDevices.isEmpty) }
        #expect(c.serialPorts.count == 1); #expect(c.serialPorts.first is VZVirtioConsoleDeviceSerialPortConfiguration)
        #expect(c.socketDevices.count == 1); #expect(c.socketDevices.first is VZVirtioSocketDeviceConfiguration)
        #expect(c.entropyDevices.count == 1); #expect(c.bootLoader is VZLinuxBootLoader)
        #expect(c.storageDevices.isEmpty); #expect(c.serialPorts.first?.attachment == nil) // Deliberately unattached inspection shell.
        #expect(c.cpuCount == 2); #expect(c.memorySize == 2147483648)
        try a.inspect(c)
    }
    @Test func implicit_device_and_resource_drift_denied() throws {
        let a = try ApplianceFixture().verified(), c = try a.inspectionConfiguration()
        c.networkDevices = [VZVirtioNetworkDeviceConfiguration()]
        #expect(throws:ApplianceFailure.policy) { try a.inspect(c) }
        c.networkDevices = []; c.consoleDevices = [VZVirtioConsoleDeviceConfiguration()]
        #expect(throws:ApplianceFailure.policy) { try a.inspect(c) }
        c.consoleDevices = []; c.cpuCount = 8
        #expect(throws:ApplianceFailure.policy) { try a.inspect(c) }
    }
    @Test func architecture_runtime_identity_and_payload_denied() throws {
        let f = try ApplianceFixture(); var x = f.object; x["architecture"] = "x86_64"
        #expect(throws:ApplianceFailure.architecture) { _ = try ApplianceManifest.decode(f.wire(x)) }
        x = f.object; x["components"] = (x["components"] as! [[String:Any]]).filter { $0["id"] as? String != "chromium" }
        #expect(throws:ApplianceFailure.missingRuntime) { _ = try ApplianceManifest.decode(f.wire(x)) }
        x = f.object; x["missingPayload"] = ["browserWorker"]
        #expect(throws:ApplianceFailure.payloadIncomplete) { _ = try ApplianceManifest.decode(f.wire(x)) }
        x = f.object; var outputs = x["outputs"] as! [[String:Any]]; outputs[1]["sha256"] = String(repeating:"0",count:64); x["outputs"] = outputs
        #expect(throws:ApplianceFailure.artifactMismatch) { _ = try ApplianceManifest.decode(f.wire(x)) }
    }
    @Test func network_writable_storage_save_restore_and_policy_mutation_denied() throws {
        let f = try ApplianceFixture()
        for (section,key,value) in [("devices","network",1 as Any),("devices","networkAttachments",1),("devices","hostTCPAdmin",1),("devices","serial",2),("devices","vsockPort",4051),("storage","baseReadOnly",false),("storage","writableDisks",1),("storage","saveRestore",true),("storage","hibernation",true),("storage","hostShares",true),("resources","memoryBytes",1),("roles","browser",0),("layout","browserRoot","/tmp")] {
            #expect(throws:ApplianceFailure.policy) { _ = try ApplianceManifest.decode(f.wire(f.policy(section,key,value))) }
        }
    }
    @Test func strict_unknown_duplicate_numeric_and_oversize_wire_denied() throws {
        let f = try ApplianceFixture(), raw = String(decoding:try f.wire(f.legacyObject()),as:UTF8.self)
        for changed in [raw.replacingOccurrences(of:"\"manifestVersion\":1",with:"\"manifestVersion\":1,\"manifestVersion\":1"),raw.replacingOccurrences(of:"\"manifestVersion\":1",with:"\"manifestVersion\":1e0"),raw.replacingOccurrences(of:"\"manifestVersion\":1",with:"\"manifestVersion\":true"),raw.replacingOccurrences(of:"\"network\":0",with:"\"network\":-0"),raw.dropLast()+",\"extra\":1}",String(repeating:" ",count:65537)+raw] {
            #expect(throws:ApplianceFailure.invalidManifest) { _ = try ApplianceManifest.decode(Data(changed.utf8)) }
        }
    }
    @Test func expected_identity_location_and_bytes_are_required() throws {
        let f = try ApplianceFixture(), m = try f.manifest()
        #expect(throws:ApplianceFailure.identityMismatch) { _ = try m.verifyArtifacts(locations:f.locations,expectedManifestDigest:String(repeating:"0",count:64)) }
        #expect(throws:ApplianceFailure.artifactMismatch) { _ = try m.verifyArtifacts(locations:[:],expectedManifestDigest:f.expected) }
        var wrong = f.locations; wrong["base"] = wrong["kernel"]
        #expect(throws:ApplianceFailure.artifactMismatch) { _ = try m.verifyArtifacts(locations:wrong,expectedManifestDigest:f.expected) }
    }
    @Test func substitution_after_verification_rejected() throws {
        let f = try ApplianceFixture(), dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:dir) }
        var paths:[String:URL] = [:]
        for (id,url) in f.locations { let target = dir.appendingPathComponent(id); try FileManager.default.copyItem(at:url,to:target); paths[id] = target }
        let a = try f.manifest().verifyArtifacts(locations:paths,expectedManifestDigest:f.expected)
        try Data("changed".utf8).write(to:paths["base"]!)
        #expect(throws:ApplianceFailure.inputChanged) { try a.recheck() }
    }
}

private final class VMEvent: @unchecked Sendable {
    private let lock = NSLock(); private var fired = false; private var waiters:[CheckedContinuation<Void,Never>] = []
    func signal() { let cs = lock.withLock { fired = true; let cs = waiters; waiters = []; return cs }; cs.forEach { $0.resume() } }
    func wait() async { await withCheckedContinuation { c in let now = lock.withLock { if fired { return true }; waiters.append(c); return false }; if now { c.resume() } } }
}
private final class VMCount: @unchecked Sendable { private let lock = NSLock(); private var n = 0; var value:Int { lock.withLock { n } }; func add() { lock.withLock { n += 1 } } }
private actor VMGate<T:Sendable> {
    private var continuation:CheckedContinuation<T,any Error>?
    let entered = VMEvent()
    func get() async throws -> T { try await withCheckedThrowingContinuation { continuation = $0; entered.signal() } }
    func finish(_ value:T) { continuation?.resume(returning:value); continuation = nil }
}
private final class VMTestClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock(); private var wall = 160, mono = 10
    private var waits:[UUID:CheckedContinuation<Void,any Error>] = [:]
    let waiting = VMEvent()
    func sample() throws -> ClockSample { lock.withLock { ClockSample(wall:wall,monotonic:mono) } }
    func advance(wall:Int,mono:Int) { let cs = lock.withLock { self.wall = wall; self.mono = mono; let cs = Array(waits.values); waits = [:]; return cs }; cs.forEach { $0.resume() } }
    func wait(milliseconds:Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c:CheckedContinuation<Void,any Error>) in
                lock.withLock { if Task.isCancelled { c.resume(throwing:CancellationError()) } else { waits[id] = c } }; waiting.signal()
            }
        } onCancel: { self.lock.withLock { self.waits.removeValue(forKey:id) }?.resume(throwing:CancellationError()) }
    }
}
private final class VMFakeInstance: OfflineVMInstance, @unchecked Sendable {
    let stops = VMCount(), disposals = VMCount(), disposed = VMEvent(), stopping = VMEvent()
    let gate:VMGate<Void>?
    let beforeStopReturn:(@Sendable () async -> Void)?
    init(gate:VMGate<Void>? = nil,beforeStopReturn:(@Sendable () async -> Void)? = nil) { self.gate = gate; self.beforeStopReturn = beforeStopReturn }
    func stop() async throws { stops.add(); stopping.signal(); if let gate { try await gate.get() }; await beforeStopReturn?() }
    func dispose() { disposals.add(); disposed.signal() }
}

// Completion changes the sampled time without waking either clock waiter. Thus the
// completion publisher, not timer scheduling, must enforce the absolute deadline.
private final class VMCompletionClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current:Result<ClockSample,VMFailure> = .success(ClockSample(wall:160,monotonic:10))
    private var waits:[UUID:(Int,CheckedContinuation<Void,any Error>)] = [:]
    let stopTimerWaiting = VMEvent(), stopTimerProgressed = VMEvent()
    func sample() throws -> ClockSample { try lock.withLock { try current.get() } }
    func set(_ value:Result<ClockSample,VMFailure>) { lock.withLock { current = value } }
    func wakeStopTimer() {
        let ready = lock.withLock {
            let ids = waits.filter { $0.value.0 == 10 }.map(\.key)
            return ids.compactMap { waits.removeValue(forKey:$0)?.1 }
        }
        ready.forEach { $0.resume() }
    }
    func wait(milliseconds:Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c:CheckedContinuation<Void,any Error>) in
                lock.withLock { if Task.isCancelled { c.resume(throwing:CancellationError()) } else { waits[id] = (milliseconds,c) } }
                if milliseconds == 10 { stopTimerWaiting.signal() }
                if milliseconds == 5 { stopTimerProgressed.signal() }
            }
        } onCancel: { self.lock.withLock { self.waits.removeValue(forKey:id)?.1 }?.resume(throwing:CancellationError()) }
    }
}

extension VMConfigurationTests {
    @Test func timer_clock_failure_remains_failed_after_clock_recovers_and_stop_returns() async throws {
        let cases:[Result<ClockSample,VMFailure>] = [
            .failure(.clock),
            .success(ClockSample(wall:160,monotonic:9)),
            .success(ClockSample(wall:159,monotonic:11)),
            .success(ClockSample(wall:160,monotonic:Int.max))
        ]
        for sample in cases {
            let h = try VMHarness(), clock = VMCompletionClock(), gate = VMGate<Void>(), returning = VMEvent()
            let instance = VMFakeInstance(gate:gate,beforeStopReturn:{ returning.signal() })
            let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:VMFakeEffects(instance:instance),clock:clock)
            let stop = Task { await handle.stop(deadline:20) }
            await gate.entered.wait(); await clock.stopTimerWaiting.wait()
            clock.set(sample); clock.wakeStopTimer()
            // Await the timer's published failure before releasing completion. This
            // tests outcome preservation, not scheduler reproduction of the old gap.
            #expect(await stop.value == .failed)
            #expect(instance.disposals.value == 1); #expect(h.counts.allSatisfy { $0.value == 1 })
            clock.set(.success(ClockSample(wall:160,monotonic:15)))
            await gate.finish(()); await returning.wait()
            #expect(await handle.stop(deadline:100) == .failed)
            #expect(instance.stops.value == 1); #expect(instance.disposals.value == 1)
        }
    }
    @Test func stop_completion_rechecks_deadline_and_clock_before_publishing_success() async throws {
        let cases:[(Result<ClockSample,VMFailure>,StopOutcome)] = [
            (.success(ClockSample(wall:160,monotonic:21)),.deadlineExceeded),
            (.success(ClockSample(wall:160,monotonic:20)),.deadlineExceeded),
            (.success(ClockSample(wall:160,monotonic:9)),.failed),
            (.success(ClockSample(wall:160,monotonic:-1)),.failed),
            (.success(ClockSample(wall:160,monotonic:Int.max)),.failed),
            (.failure(.clock),.failed)
        ]
        for (sample,expected) in cases {
            let h = try VMHarness(), clock = VMCompletionClock()
            let instance = VMFakeInstance(beforeStopReturn:{ await clock.stopTimerWaiting.wait(); clock.set(sample) })
            let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:VMFakeEffects(instance:instance),clock:clock)
            #expect(await handle.stop(deadline:20) == expected)
            #expect(instance.stops.value == 1); #expect(instance.disposals.value == 1)
            #expect(h.counts.allSatisfy { $0.value == 1 })
            #expect(await handle.stop(deadline:100) == expected)
            #expect(instance.disposals.value == 1)
        }
    }
    @Test func stop_completion_rejects_rollback_after_timer_observed_progress() async throws {
        let h = try VMHarness(), clock = VMCompletionClock()
        let instance = VMFakeInstance(beforeStopReturn:{
            await clock.stopTimerWaiting.wait()
            clock.set(.success(ClockSample(wall:160,monotonic:15))); clock.wakeStopTimer()
            await clock.stopTimerProgressed.wait()
            clock.set(.success(ClockSample(wall:160,monotonic:14)))
        })
        let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:VMFakeEffects(instance:instance),clock:clock)
        #expect(await handle.stop(deadline:20) == .failed)
        #expect(instance.stops.value == 1); #expect(instance.disposals.value == 1)
        #expect(h.counts.allSatisfy { $0.value == 1 })
    }
}
private final class VMFakeEffects: OfflineVMEffects, @unchecked Sendable {
    let starts = VMCount(), instance:VMFakeInstance, gate:VMGate<any OfflineVMInstance>?
    private let lock = NSLock(); private var consumed:VMConfigurationPlan?
    var plan:VMConfigurationPlan? { lock.withLock { consumed } }
    init(instance:VMFakeInstance = VMFakeInstance(),gate:VMGate<any OfflineVMInstance>? = nil) { self.instance = instance; self.gate = gate }
    func start(plan:VMConfigurationPlan) async throws -> any OfflineVMInstance { starts.add(); lock.withLock { consumed = plan }; if let gate { return try await gate.get() }; return instance }
}
private struct VMHarness {
    let run:RunConfiguration, counts:[VMCount]
    init(manifestDigest:String? = nil, capability:Data = Data(repeating:7,count:32), signatureTampered:Bool = false, appliance supplied:ArtifactVerifiedAppliance? = nil) throws {
        let appliance = try supplied ?? ApplianceFixture().verified(), fixture = try BrokerTests.fixture()
        let options = fixture["options"] as! [String:Any], expected = options["expected"] as! [String:[String:Any]], keys = options["publicKeys"] as! [String:String]
        var template = expected["RELEASE_RECEIPT"]!, payload = template["payload"] as! [String:Any]
        payload["issuedAt"] = 0; payload["expiresAt"] = 1; payload["keyId"] = String(repeating:"0",count:64); payload["signature"] = String(repeating:"0",count:128); template["payload"] = payload
        var candidate = try BrokerTests.candidate(fixture)
        if signatureTampered { var obj = try JSONSerialization.jsonObject(with:candidate) as! [String:Any], p = obj["payload"] as! [String:Any]; p["signature"] = String(repeating:"0",count:128); obj["payload"] = p; candidate = try JSONSerialization.data(withJSONObject:obj) }
        func record(_ data:Data) -> Data { Data([UInt8(data.count >> 8),UInt8(data.count & 255)]) + data }
        var bytes = Data("ABR1".utf8) + record(try JSONSerialization.data(withJSONObject:template)) + record(candidate)
        bytes += BrokerTests.hex(keys["RELEASE_RECEIPT"]!); bytes += Data(repeating:0x11,count:16); bytes += Data(repeating:7,count:32)
        bytes += BrokerTests.hex(manifestDigest ?? appliance.manifest.digest); bytes += Data(repeating:0xaa,count:32)
        for value in [100,0,300,190,10000,20,30,1] { let n = UInt64(value).bigEndian; bytes.append(withUnsafeBytes(of:n) { Data($0) }) }
        let facts:[DescriptorFacts] = (0...35).map { n in
            let kind:DescriptorFacts.Kind = n < 3 ? .null:.pipe
            let direction:Int32 = n == 3 || n % 2 == 0 ? 0:1
            return DescriptorFacts(fd:Int32(n),kind:kind,direction:direction,uid:501,device:1,inode:UInt64(n),tty:false)
        }
        var owned:[OwnedVMChannel] = [], counters:[VMCount] = []
        for n in 3...35 { let count = VMCount(); counters.append(count); owned.append(OwnedVMChannel(purpose:n == 3 ? .bootstrap:.relay((n-4)/2,n % 2 == 0),facts:facts[n],dispose:{ count.add() })) }
        let purposes:[OwnedVMChannel.Purpose] = [.serialInput,.serialOutput,.terminal]
        var console:[OwnedVMChannel] = []
        for (i,purpose) in purposes.enumerated() { let count = VMCount(); counters.append(count); console.append(OwnedVMChannel(purpose:purpose,facts:DescriptorFacts(fd:Int32(100+i),kind:.pipe,direction:i == 1 ? 1:0,uid:501,device:1,inode:UInt64(100+i),tty:false),dispose:{ count.add() })) }
        counts = counters
        run = RunConfiguration(appliance:appliance,bootstrap:try BootstrapConfiguration.decode(bytes),channels:VMChannelSet(brokerFacts:facts,broker:owned,console:console,uid:501),capability:capability)
    }
}

extension VMConfigurationTests {
    @Test func manifest_plan_has_readonly_base_private_serial_and_no_admin_or_state_export() throws {
        let p = try ApplianceFixture().verified().plan
        #expect(p.readOnlyBase); #expect(p.privateSerial); #expect(p.socketPort == 4050); #expect(p.hostCID == 2)
        #expect(p.writableDisks == 0); #expect(p.networkDevices == 0); #expect(p.hostTCPListeners == 0); #expect(!p.saveRestore)
    }
    @Test func missing_invalid_proofs_block_before_effects() async throws {
        for proof in [OfflineProof.missing,.invalid] {
            for which in 0...2 {
                let h = try VMHarness(), e = VMFakeEffects(), c = VMTestClock()
                let admission = OfflineAdmission(signature:which == 0 ? proof:.accepted,entitlement:which == 1 ? proof:.accepted,qualification:which == 2 ? proof:.accepted)
                do { let result = try await OfflineVMHost.start(run:h.run,admission:admission,effects:e,clock:c); Issue.record("Missing/invalid proof admitted"); _ = await result.stop(deadline:20) } catch {}
                #expect(e.starts.value == 0); #expect(h.counts.allSatisfy { $0.value == 1 })
            }
        }
    }
    @Test func native_start_is_closed_even_for_offline_integrity() async throws {
        let h = try VMHarness()
        do { _ = try await VMHost.start(run:h.run); Issue.record("Native start admitted") }
        catch { #expect(error as? VMFailure == .signatureUnavailable) }
        #expect(h.counts.allSatisfy { $0.value == 1 })
    }
    @Test func real_release_manifest_capability_binding_denied() async throws {
        for h in [try VMHarness(manifestDigest:String(repeating:"0",count:64)),try VMHarness(capability:Data(repeating:8,count:32)),try VMHarness(signatureTampered:true)] {
            let e = VMFakeEffects()
            do { let result = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:VMTestClock()); Issue.record("Invalid run binding admitted"); _ = await result.stop(deadline:20) } catch {}
            #expect(e.starts.value == 0); #expect(h.counts.allSatisfy { $0.value == 1 })
        }
    }
    @Test func descriptor_inventory_and_purpose_provenance_rejected() throws {
        let h = try VMHarness(), c = h.run.channels
        try c.validate()
        #expect(throws:VMFailure.descriptor) { try VMChannelSet(brokerFacts:Array(c.brokerFacts.dropLast()),broker:c.broker,console:c.console,uid:c.uid).validate() }
        var wrong = c.broker; wrong[0] = c.console[0]
        #expect(throws:VMFailure.descriptor) { try VMChannelSet(brokerFacts:c.brokerFacts,broker:wrong,console:c.console,uid:c.uid).validate() }
        let original = c.broker[0]
        wrong = c.broker; wrong[0] = OwnedVMChannel(purpose:.serialInput,facts:original.facts,dispose:{})
        #expect(throws:VMFailure.descriptor) { try VMChannelSet(brokerFacts:c.brokerFacts,broker:wrong,console:c.console,uid:c.uid).validate() }
        c.close(); c.close(); #expect(h.counts.allSatisfy { $0.value == 1 })
    }
    @Test func terminal_channel_loss_only_stops_owned_once() async throws {
        let h = try VMHarness(), e = VMFakeEffects(), foreign = VMFakeInstance()
        let result = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:VMTestClock())
        #expect(e.plan == h.run.appliance.plan)
        await result.terminalLost(); await result.channelLost(); _ = await result.stop(deadline:20)
        #expect(e.instance.stops.value == 1); #expect(e.instance.disposals.value == 1); #expect(h.counts.allSatisfy { $0.value == 1 })
        #expect(foreign.stops.value == 0); #expect(foreign.disposals.value == 0)
    }
    @Test func cancellation_before_late_start_cannot_publish_handle() async throws {
        let h = try VMHarness(), gate = VMGate<any OfflineVMInstance>(), e = VMFakeEffects(gate:gate), c = VMTestClock()
        let task = Task { try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c) }
        await gate.entered.wait(); task.cancel(); await gate.finish(e.instance)
        do { let handle = try await task.value; Issue.record("Cancelled start published a handle"); _ = await handle.stop(deadline:20) }
        catch { #expect(error as? VMFailure == .cancelled) }
        await e.instance.disposed.wait(); await e.instance.stopping.wait(); #expect(h.counts.allSatisfy { $0.value == 1 }); #expect(e.instance.stops.value == 1)
    }
    @Test func expiry_during_late_start_cannot_publish_handle() async throws {
        let h = try VMHarness(), gate = VMGate<any OfflineVMInstance>(), e = VMFakeEffects(gate:gate), c = VMTestClock()
        let task = Task { try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c) }
        await gate.entered.wait(); c.advance(wall:190,mono:40); await gate.finish(e.instance)
        do { let handle = try await task.value; Issue.record("Expired start published a handle"); _ = await handle.stop(deadline:50) } catch { #expect(error as? VMFailure == .expired) }
        await e.instance.disposed.wait(); #expect(h.counts.allSatisfy { $0.value == 1 })
    }
    @Test func stop_deadline_is_not_stopped_proof() async throws {
        let h = try VMHarness(), e = VMFakeEffects(), c = VMTestClock()
        let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c)
        #expect(await handle.stop(deadline:10) == .deadlineExceeded)
        await e.instance.disposed.wait(); #expect(h.counts.allSatisfy { $0.value == 1 })
    }
    @Test func finite_cli_and_unavailable_modes_have_no_validation_effect() throws {
        #expect(try HostDispatch.parse(["bootstrap-check"]) == .bootstrapCheck)
        #expect(try HostDispatch.parse(["run-synthetic"]) == .runSynthetic)
        for args in [[String](),["run"],["real-session"],["qualify","--force"],["restore","state"]] { #expect(throws:VMFailure.usage) { _ = try HostDispatch.parse(args) } }
        let calls = VMCount()
        for command in [HostCommand.bootstrapCheck,.qualify,.runSynthetic] { #expect(throws:VMFailure.unavailable) { _ = try HostDispatch.execute(command) { _,_,_,_,_ in calls.add(); return [] } } }
        #expect(calls.value == 0)
        let parsed = try HostDispatch.parse(["validate-appliance","--manifest","M","--expected-digest","D","--base","B","--kernel","K","--initramfs","I"])
        #expect(parsed == .validateAppliance(manifest:"M",expected:"D",base:"B",kernel:"K",initramfs:"I"))
        let blockers = try HostDispatch.execute(parsed) { m,d,b,k,i in #expect([m,d,b,k,i] == ["M","D","B","K","I"]); return [.signingUnavailable,.qualificationUnavailable] }
        #expect(blockers == [.signingUnavailable,.qualificationUnavailable])
    }
    @Test func late_cancelled_result_disposes_even_when_stop_ignores_cancellation() async throws {
        let h = try VMHarness(), startGate = VMGate<any OfflineVMInstance>(), stopGate = VMGate<Void>()
        let instance = VMFakeInstance(gate:stopGate), effects = VMFakeEffects(instance:instance,gate:startGate), clock = VMTestClock()
        let task = Task { try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:effects,clock:clock) }
        await startGate.entered.wait(); task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled waiter retained") } catch { #expect(error as? VMFailure == .cancelled) }
        #expect(h.counts.allSatisfy { $0.value == 1 })
        await startGate.finish(instance); await stopGate.entered.wait()
        #expect(instance.disposals.value == 1)
        await stopGate.finish(()); await instance.disposed.wait()
    }
    @Test func invalid_sdk_memory_alignment_blocks_before_fake_effect() async throws {
        let f = try ApplianceFixture(), m = try ApplianceManifest.decode(f.wire(f.policy("resources","memoryBytes",2147483649)))
        let appliance = try m.verifyArtifacts(locations:f.locations,expectedManifestDigest:m.digest), h = try VMHarness(appliance:appliance), e = VMFakeEffects()
        #expect(throws:ApplianceFailure.policy) { _ = try appliance.inspectionConfiguration() }
        do { let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:VMTestClock()); Issue.record("Invalid resource plan reached lifecycle"); _ = await handle.stop(deadline:20) } catch {}
        #expect(e.starts.value == 0)
    }
}

extension VMConfigurationTests {
    @Test func document_helper_bounds_recursion_and_receipt_domain_are_separate() throws {
        let rule:[String:Any] = ["type":"object","fields":["n":["type":"integer","min":Int64(0),"max":Int64(2)]]]
        #expect(try Contracts.decodeDocument(Data("{\"n\":1}".utf8),rule:rule,definitions:[:],maxBytes:65536)["n"] as? Int == 1)
        for limit in [0,-1,65537] {
            #expect(throws:(any Error).self) { _ = try Contracts.decodeDocument(Data("{\"n\":1}".utf8),rule:rule,definitions:[:],maxBytes:limit) }
            #expect(throws:(any Error).self) { _ = try Contracts.canonicalDocument(["n":1],rule:rule,definitions:[:],maxBytes:limit) }
        }
        #expect(throws:(any Error).self) { _ = try Contracts.decodeDocument(Data("{}".utf8),rule:["ref":"cycle"],definitions:["cycle":["ref":"cycle"]],maxBytes:10) }
        for raw in ["{\"n\":true}","{\"n\":1.0}","{\"n\":1e0}","{\"n\":-0}","{\"n\":1,\"\\u006e\":1}","{\"n\":9007199254740992}"] {
            #expect(throws:(any Error).self) { _ = try Contracts.decodeDocument(Data(raw.utf8),rule:rule,definitions:[:],maxBytes:65536) }
        }
        #expect(throws:ContractError.invalidFrame) { _ = try Contracts.decode(try ApplianceFixture().wire(),kind:.releaseReceipt) }
    }
    @Test func every_permitted_object_shape_is_checked_for_drift() throws {
        let a = try ApplianceFixture().verified()
        let mutations:[(VZVirtualMachineConfiguration)->Void] = [
            { $0.entropyDevices = [] }, { $0.entropyDevices.append(VZVirtioEntropyDeviceConfiguration()) },
            { $0.serialPorts = [] }, { $0.socketDevices.append(VZVirtioSocketDeviceConfiguration()) },
            { $0.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()] },
            { ($0.bootLoader as? VZLinuxBootLoader)?.commandLine = "rw" },
            { ($0.bootLoader as? VZLinuxBootLoader)?.initialRamdiskURL = URL(fileURLWithPath:"/unverified") },
            { $0.memorySize *= 2 }
        ]
        for mutate in mutations { let c = try a.inspectionConfiguration(); mutate(c); #expect(throws:ApplianceFailure.policy) { try a.inspect(c) } }
        if #available(macOS 15,*) { let c = try a.inspectionConfiguration(); c.usbControllers = [VZXHCIControllerConfiguration()]; #expect(throws:ApplianceFailure.policy) { try a.inspect(c) } }
        if #available(macOS 27,*) { let c = try a.inspectionConfiguration(); c.label = "drift"; #expect(throws:ApplianceFailure.policy) { try a.inspect(c) } }
    }
    @Test func synthetic_complete_and_declared_native_do_not_acquire_runtime_proof() throws {
        let f = try ApplianceFixture(); var x = f.object, rows = x["components"] as! [[String:Any]]
        for id in x["missingPayload"] as! [String] { let bytes = Data(("synthetic:"+id).utf8); rows.append(["id":id,"sizeBytes":bytes.count,"sha256":applianceHash(bytes),"version":"synthetic","sourceId":"synthetic"]) }
        x["components"] = rows.sorted { ($0["id"] as! String) < ($1["id"] as! String) }; x["missingPayload"] = []; x["payloadState"] = "COMPLETE"
        let complete = try ApplianceManifest.decode(f.wire(x))
        #expect(!complete.runtimeBlockers.contains(.payloadIncomplete)); #expect(complete.runtimeBlockers.contains(.syntheticOnly)); #expect(complete.runtimeBlockers.contains(.signingUnavailable))
        var p = x["provenance"] as! [String:Any]; p["assemblyMode"] = "NATIVE_ARM64_LINUX"; x["provenance"] = p
        let claimed = try ApplianceManifest.decode(f.wire(x)); #expect(claimed.runtimeBlockers == [.signingUnavailable,.qualificationUnavailable])
        x["manifestSigning"] = "PERFORMED"; #expect(throws:ApplianceFailure.invalidManifest) { _ = try ApplianceManifest.decode(f.wire(x)) }
    }
    @Test func symlink_hardlink_and_path_replacement_artifacts_denied() throws {
        let f = try ApplianceFixture(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:directory) }
        let original = directory.appendingPathComponent("original"), link = directory.appendingPathComponent("link")
        try FileManager.default.copyItem(at:f.locations["base"]!,to:original)
        try FileManager.default.createSymbolicLink(at:link,withDestinationURL:original)
        var paths = f.locations; paths["base"] = link
        #expect(throws:ApplianceFailure.artifactMismatch) { _ = try f.manifest().verifyArtifacts(locations:paths,expectedManifestDigest:f.expected) }
        try FileManager.default.removeItem(at:link); try FileManager.default.linkItem(at:original,to:link); paths["base"] = original
        #expect(throws:ApplianceFailure.artifactMismatch) { _ = try f.manifest().verifyArtifacts(locations:paths,expectedManifestDigest:f.expected) }
        try FileManager.default.removeItem(at:link)
        let a = try f.manifest().verifyArtifacts(locations:paths,expectedManifestDigest:f.expected)
        try FileManager.default.moveItem(at:original,to:link); try FileManager.default.copyItem(at:f.locations["base"]!,to:original)
        #expect(throws:ApplianceFailure.inputChanged) { _ = try a.artifactBytes("base") }
    }
    @Test func automatic_expiry_and_clock_rollback_dispose_owned_resources() async throws {
        for (wall,mono) in [(190,40),(159,11),(161,9)] {
            let h = try VMHarness(), c = VMTestClock(), e = VMFakeEffects()
            let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c)
            await c.waiting.wait(); c.advance(wall:wall,mono:mono)
            await e.instance.disposed.wait(); #expect(e.instance.stops.value == 1); #expect(h.counts.allSatisfy { $0.value == 1 })
            _ = await handle.stop(deadline:50); #expect(e.instance.disposals.value == 1)
        }
    }
    @Test func pending_stop_deadline_cannot_be_replaced_by_late_success() async throws {
        let h = try VMHarness(), c = VMCompletionClock(), gate = VMGate<Void>(), instance = VMFakeInstance(gate:gate), e = VMFakeEffects(instance:instance)
        let handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c)
        let stop = Task { await handle.stop(deadline:20) }
        await gate.entered.wait(); await c.stopTimerWaiting.wait()
        c.set(.success(ClockSample(wall:170,monotonic:20))); c.wakeStopTimer()
        #expect(await stop.value == .deadlineExceeded); #expect(instance.disposals.value == 1); #expect(h.counts.allSatisfy { $0.value == 1 })
        await gate.finish(()); #expect(await handle.stop(deadline:100) == .deadlineExceeded)
    }
    @Test func pre_cancelled_start_has_no_effect_and_disposes_once() async throws {
        let h = try VMHarness(), c = VMTestClock(), e = VMFakeEffects(), ready = VMGate<Void>()
        let task = Task { try await ready.get(); return try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:c) }
        await ready.entered.wait(); task.cancel(); await ready.finish(())
        do { _ = try await task.value; Issue.record("Precancelled start succeeded") } catch { #expect(error as? VMFailure == .cancelled) }
        #expect(e.starts.value == 0); #expect(h.counts.allSatisfy { $0.value == 1 })
    }
    @Test func empty_injected_cli_validation_cannot_qualify_runtime() throws {
        let result = try HostDispatch.execute(.validateAppliance(manifest:"m",expected:"d",base:"b",kernel:"k",initramfs:"i")) { _,_,_,_,_ in [] }
        #expect(result == [.signingUnavailable,.qualificationUnavailable])
    }
}

extension VMConfigurationTests {
    @Test func stop_rejects_out_of_safe_range_deadline() async throws {
        for deadline in [Int.max,Int.min,120011] {
            let h = try VMHarness(), e = VMFakeEffects(), handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:VMTestClock())
            #expect(await handle.stop(deadline:deadline) == .failed)
            await e.instance.stopping.wait(); #expect(h.counts.allSatisfy { $0.value == 1 })
        }
    }
    @Test func precancelled_stop_still_closes_channels_and_requests_owned_stop() async throws {
        let h = try VMHarness(), e = VMFakeEffects(), handle = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:e,clock:VMTestClock()), gate = VMGate<Void>()
        let task = Task { try await gate.get(); return await handle.stop(deadline:20) }
        await gate.entered.wait(); task.cancel(); await gate.finish(())
        #expect(try await task.value == .failed)
        #expect(h.counts.allSatisfy { $0.value == 1 })
        await e.instance.stopping.wait(); #expect(e.instance.stops.value == 1)
        await handle.terminalLost(); #expect(e.instance.disposals.value == 1)
    }
}

extension VMConfigurationTests {
    @Test func concurrent_duplicate_and_completed_run_cannot_reclaim_channels() async throws {
        let h = try VMHarness(), clock = VMTestClock(), first = VMFakeEffects(), duplicate = VMFakeEffects()
        let active = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:first,clock:clock)
        do { let other = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:duplicate,clock:clock); Issue.record("Concurrent duplicate run admitted"); _ = await other.stop(deadline:20) } catch { #expect(error as? VMFailure == .terminal) }
        #expect(duplicate.starts.value == 0); #expect(first.instance.stops.value == 0); #expect(h.counts.allSatisfy { $0.value == 0 })
        _ = await active.stop(deadline:20)
        let replay = VMFakeEffects()
        do { let other = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:replay,clock:clock); Issue.record("Completed run admitted again"); _ = await other.stop(deadline:20) } catch { #expect(error as? VMFailure == .terminal) }
        #expect(replay.starts.value == 0); #expect(h.counts.allSatisfy { $0.value == 1 }); #expect(first.instance.stops.value == 1)
    }
    @Test func rewrapped_owner_objects_cannot_bypass_single_use_claim() async throws {
        let h = try VMHarness(), clock = VMTestClock(), first = VMFakeEffects(), duplicate = VMFakeEffects(), c = h.run.channels
        let active = try await OfflineVMHost.start(run:h.run,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:first,clock:clock)
        let rewrapped = VMChannelSet(brokerFacts:c.brokerFacts,broker:c.broker,console:c.console,uid:c.uid)
        let alias = RunConfiguration(appliance:h.run.appliance,bootstrap:h.run.bootstrap,channels:rewrapped,capability:h.run.capability)
        do { let other = try await OfflineVMHost.start(run:alias,admission:.init(signature:.accepted,entitlement:.accepted,qualification:.accepted),effects:duplicate,clock:clock); Issue.record("Rewrapped owners admitted"); _ = await other.stop(deadline:20) } catch { #expect(error as? VMFailure == .terminal) }
        #expect(duplicate.starts.value == 0); #expect(h.counts.allSatisfy { $0.value == 0 }); #expect(first.instance.stops.value == 0)
        _ = await active.stop(deadline:20); #expect(h.counts.allSatisfy { $0.value == 1 })
    }
}
