import Foundation
import Testing
@testable import AcceptanceCore

private final class BootstrapTestClock: BrokerClock, @unchecked Sendable {
    func sample() throws -> ClockSample { ClockSample(wall:100,monotonic:10) }
    func wait(milliseconds:Int) async throws {}
}

private final class BootstrapProbeFake: BootstrapProbePort, @unchecked Sendable {
    var requested = [BootstrapProbeID]()
    var snapshot:BootstrapSnapshot
    init(_ snapshot:BootstrapSnapshot) { self.snapshot = snapshot }
    func capture(ids:[BootstrapProbeID]) throws -> BootstrapSnapshot {
        requested = ids
        return snapshot
    }
}

private final class BootstrapLifecycleFake: BootstrapLifecyclePort, @unchecked Sendable {
    private var drift:(@Sendable () -> Void)?
    var starts = 0
    func begin(snapshot:BootstrapSnapshot,onDrift:@escaping @Sendable () -> Void) throws {
        starts += 1
        drift = onDrift
    }
    func triggerDrift() { drift?() }
}

private struct BootstrapRunFixture {
    let run:RunConfiguration
    init() throws {
        let appliance = try ApplianceFixture().verified(), fixture = try BrokerTests.fixture()
        let options = fixture["options"] as! [String:Any]
        let expected = options["expected"] as! [String:[String:Any]]
        let keys = options["publicKeys"] as! [String:String]
        var template = expected["RELEASE_RECEIPT"]!, payload = template["payload"] as! [String:Any]
        payload["issuedAt"] = 0; payload["expiresAt"] = 1
        payload["keyId"] = String(repeating:"0",count:64)
        payload["signature"] = String(repeating:"0",count:128)
        template["payload"] = payload
        func record(_ data:Data) -> Data { Data([UInt8(data.count >> 8),UInt8(data.count & 255)]) + data }
        var bytes = Data("ABR1".utf8)
        bytes += record(try JSONSerialization.data(withJSONObject:template))
        bytes += record(try BrokerTests.candidate(fixture))
        bytes += BrokerTests.hex(keys["RELEASE_RECEIPT"]!)
        bytes += Data(repeating:0x11,count:16) + Data(repeating:7,count:32)
        bytes += BrokerTests.hex(appliance.manifest.digest) + Data(repeating:0xaa,count:32)
        for value in [100,0,300,190,10000,20,30,1] {
            var number = UInt64(value).bigEndian
            bytes.append(withUnsafeBytes(of:&number) { Data($0) })
        }
        var facts = [DescriptorFacts]()
        for descriptor in 0...35 {
            let kind:DescriptorFacts.Kind = descriptor < 3 ? .null:.pipe
            let direction:Int32 = descriptor == 3 || descriptor % 2 == 0 ? 0:1
            facts.append(DescriptorFacts(fd:Int32(descriptor),kind:kind,direction:direction,
                uid:501,device:1,inode:UInt64(descriptor),tty:false))
        }
        let broker = (3...35).map { descriptor in
            OwnedVMChannel(purpose:descriptor == 3 ? .bootstrap:.relay((descriptor-4)/2,descriptor % 2 == 0),
                           facts:facts[descriptor],dispose:{})
        }
        let console = [OwnedVMChannel.Purpose.serialInput,.serialOutput,.terminal].enumerated().map { index,purpose in
            OwnedVMChannel(purpose:purpose,
                           facts:DescriptorFacts(fd:Int32(100+index),kind:.pipe,
                               direction:index == 1 ? 1:0,uid:501,device:1,
                               inode:UInt64(100+index),tty:false),dispose:{})
        }
        run = RunConfiguration(appliance:appliance,bootstrap:try BootstrapConfiguration.decode(bytes),
            channels:VMChannelSet(brokerFacts:facts,broker:broker,console:console,uid:501),
            capability:Data(repeating:7,count:32))
    }
}

private func bootstrapSnapshot(_ run:RunConfiguration,
                               namespace:BootstrapNetworkNamespace = .guest,
                               results:[BootstrapProbeResult]? = nil,
                               runID:String? = nil,
                               manifest:String? = nil,
                               expiresAt:Int = 190) -> BootstrapSnapshot {
    let probeResults = results ?? BootstrapProbeID.allCases.map {
        BootstrapProbeResult(id:$0,attempted:true,
            outcome:$0 == .proxyVsockControl ? .allowed:.denied,
            ownedReceiverCount:$0 == .proxyVsockControl ? 1:0)
    }
    return BootstrapSnapshot(
        runID:runID ?? run.binding.runID,
        manifestIdentity:manifest ?? run.appliance.manifest.digest,
        roleInventoryDigest:String(repeating:"c",count:64),
        deviceInventoryDigest:String(repeating:"d",count:64),
        topologyDigest:String(repeating:"e",count:64),
        observedAt:100,expiresAt:expiresAt,
        hostDevices:[.linuxBoot,.readOnlyBlock,.entropy,.privateSerial,.vsock],
        proxy:BootstrapEndpoint(namespace:namespace,transport:.tcp,address:"127.0.0.1",port:3128,uid:10004),
        probes:probeResults)
}

@Suite(.serialized) struct BootstrapGateTests {
    // Break: a fake success value reaches the native operational entry.
    @Test func native_bootstrap_check_fails_closed_without_signed_native_ports() throws {
        let run = try BootstrapRunFixture().run
        #expect(throws:VMFailure.admissionUnavailable) { _ = try VMHost.bootstrapCheck(run:run) }
    }

    // Break: bootstrap asks for caller-selected probes or drops proof bindings.
    @Test func fixed_probe_ids_and_independent_bindings_admit_injected_path() throws {
        let run = try BootstrapRunFixture().run, probe = BootstrapProbeFake(bootstrapSnapshot(run))
        let lifecycle = BootstrapLifecycleFake()
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:lifecycle,clock:BootstrapTestClock())
        #expect(probe.requested == BootstrapProbeID.allCases)
        #expect(lifecycle.starts == 1)
        let proof = try qualification.requireBrowserAdmission()
        #expect(proof.runID == run.binding.runID)
        #expect(proof.manifestIdentity == run.appliance.manifest.digest)
        #expect(proof.roleInventoryDigest == String(repeating:"c",count:64))
        #expect(proof.deviceInventoryDigest == String(repeating:"d",count:64))
        #expect(proof.expiresAt == 190)
    }

    // Break: host loopback is accepted as evidence for the guest-loopback proxy.
    @Test func host_listener_not_guest_loopback() throws {
        let run = try BootstrapRunFixture().run
        let probe = BootstrapProbeFake(bootstrapSnapshot(run,namespace:.host))
        #expect(throws:VMFailure.admissionUnavailable) {
            _ = try OfflineVMHost.bootstrapCheck(run:run,probe:probe,lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock())
        }
    }

    // Break: skipped/failed/duplicate evidence or a forbidden delivery qualifies.
    @Test func failed_skipped_duplicate_or_received_probe_result_rejects() throws {
        let run = try BootstrapRunFixture().run, base = bootstrapSnapshot(run).probes
        let first = base[0]
        let mutations = [
            [BootstrapProbeResult(id:first.id,attempted:false,outcome:.denied,ownedReceiverCount:0)] + Array(base.dropFirst()),
            [BootstrapProbeResult(id:first.id,attempted:true,outcome:.failed,ownedReceiverCount:0)] + Array(base.dropFirst()),
            [BootstrapProbeResult(id:first.id,attempted:true,outcome:.denied,ownedReceiverCount:1)] + Array(base.dropFirst()),
            Array(base.dropLast()), base + [first],
        ]
        for results in mutations {
            #expect(throws:VMFailure.admissionUnavailable) {
                _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake(bootstrapSnapshot(run,results:results)),lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock())
            }
        }
    }

    // Break: run, manifest, expiry, or inventory digest substitutions qualify.
    @Test func run_manifest_inventory_and_expiry_binding_rejects() throws {
        let run = try BootstrapRunFixture().run
        var snapshots = [bootstrapSnapshot(run,runID:String(repeating:"2",count:32)),
                         bootstrapSnapshot(run,manifest:String(repeating:"a",count:64)),
                         bootstrapSnapshot(run,expiresAt:191), bootstrapSnapshot(run,expiresAt:100)]
        let base = bootstrapSnapshot(run)
        snapshots.append(BootstrapSnapshot(runID:base.runID,manifestIdentity:base.manifestIdentity,
            roleInventoryDigest:"",deviceInventoryDigest:base.deviceInventoryDigest,
            topologyDigest:base.topologyDigest,observedAt:base.observedAt,expiresAt:base.expiresAt,
            hostDevices:base.hostDevices,proxy:base.proxy,probes:base.probes))
        for value in snapshots {
            #expect(throws:VMFailure.admissionUnavailable) {
                _ = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake(value),lifecycle:BootstrapLifecycleFake(),clock:BootstrapTestClock())
            }
        }
    }

    // Break: a drifted run can later regain authority from a healthy observation.
    @Test func topology_drift_latches_failure() throws {
        let run = try BootstrapRunFixture().run, lifecycle = BootstrapLifecycleFake()
        let qualification = try OfflineVMHost.bootstrapCheck(run:run,probe:BootstrapProbeFake(bootstrapSnapshot(run)),lifecycle:lifecycle,clock:BootstrapTestClock())
        _ = try qualification.requireBrowserAdmission()
        lifecycle.triggerDrift()
        #expect(throws:VMFailure.terminal) { _ = try qualification.requireBrowserAdmission() }
        #expect(throws:VMFailure.terminal) { _ = try qualification.requireBrowserAdmission() }
    }
}
