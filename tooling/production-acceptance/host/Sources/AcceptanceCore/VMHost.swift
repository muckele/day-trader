import Foundation
import Darwin

public enum VMFailure: String, Error, Sendable { case signatureUnavailable, invalidSignature, entitlementMissing, invalidEntitlement, admissionUnavailable, binding, descriptor, expired, cancelled, terminal, clock, start, stop, unavailable, usage }
public enum StopOutcome: Sendable, Equatable { case stopped, deadlineExceeded, failed }
// These observations belong only to the injected offline path. No native admission
// proof has an initializer in this milestone; accepted fakes cannot authorize VZ.
enum OfflineProof: Sendable { case missing, invalid, accepted }
struct OfflineAdmission: Sendable {
    let signature:OfflineProof, entitlement:OfflineProof, qualification:OfflineProof
    func check() throws {
        switch signature { case .missing: throw VMFailure.signatureUnavailable; case .invalid: throw VMFailure.invalidSignature; case .accepted: break }
        switch entitlement { case .missing: throw VMFailure.entitlementMissing; case .invalid: throw VMFailure.invalidEntitlement; case .accepted: break }
        guard qualification == .accepted else { throw VMFailure.admissionUnavailable }
    }
}
// Nominal object ownership and purpose are separate from inspectable descriptor facts.
// These injected owners model future private channel acquisition, not OS provenance.
final class OwnedVMChannel: @unchecked Sendable {
    enum Purpose: Equatable, Sendable { case bootstrap, relay(Int, Bool), serialInput, serialOutput, terminal }
    let id:UUID, purpose:Purpose, facts:DescriptorFacts
    private let dispose:@Sendable () -> Void, lock = NSLock()
    private var closed = false, claimed = false
    init(id:UUID = UUID(),purpose:Purpose,facts:DescriptorFacts,dispose:@escaping @Sendable () -> Void) { self.id = id; self.purpose = purpose; self.facts = facts; self.dispose = dispose }
    func close() { let first = lock.withLock { if closed { return false }; closed = true; return true }; if first { dispose() } }
    fileprivate func claim() -> Bool { lock.withLock { guard !closed, !claimed else { return false }; claimed = true; return true } }
    fileprivate func undoUncommittedClaim() { lock.withLock { claimed = false } }
}
private enum VMChannelClaim {
    // Serialize group acquisition across differently wrapped sets of the same owners.
    static let lock = NSLock()
}
struct VMChannelSet: Sendable {
    let brokerFacts:[DescriptorFacts], broker:[OwnedVMChannel], console:[OwnedVMChannel], uid:UInt32
    // Claim the actual owner objects, not a caller flag or newly constructed wrapper.
    // A rejected overlapping set releases only its uncommitted claims and closes none
    // of the resources that may belong to an active run.
    func claim() throws {
        try VMChannelClaim.lock.withLock {
            var acquired:[OwnedVMChannel] = []
            for owner in broker+console {
                guard owner.claim() else { acquired.forEach { $0.undoUncommittedClaim() }; throw VMFailure.terminal }
                acquired.append(owner)
            }
        }
    }
    func validate() throws {
        do { try BrokerBootstrap.auditFacts(brokerFacts,uid:uid,arguments:[],environment:[:]) } catch { throw VMFailure.descriptor }
        guard broker.count == 33, console.count == 3 else { throw VMFailure.descriptor }
        let all = broker+console
        guard Set(all.map(\.id)).count == all.count, Set(all.map { ObjectIdentifier($0) }).count == all.count,
              Set(all.map { $0.facts.fd }).count == all.count,
              Set(all.map { "\($0.facts.device):\($0.facts.inode)" }).count == all.count else { throw VMFailure.descriptor }
        for (index,owner) in broker.enumerated() {
            let fd = Int32(index+3), expected:OwnedVMChannel.Purpose = index == 0 ? .bootstrap:.relay((index-1)/2,fd % 2 == 0)
            guard owner.purpose == expected, let fact = brokerFacts.first(where:{ $0.fd == fd }),
                  owner.facts.fd == fd, owner.facts.kind == fact.kind, owner.facts.direction == fact.direction,
                  owner.facts.uid == fact.uid, owner.facts.device == fact.device, owner.facts.inode == fact.inode, owner.facts.tty == fact.tty else { throw VMFailure.descriptor }
        }
        for (index,purpose) in [OwnedVMChannel.Purpose.serialInput,.serialOutput,.terminal].enumerated() {
            let owner = console[index], fact = owner.facts
            guard owner.purpose == purpose, fact.fd > 35, fact.kind == .pipe, fact.uid == uid, !fact.tty,
                  fact.direction == (index == 1 ? O_WRONLY:O_RDONLY) else { throw VMFailure.descriptor }
        }
    }
    func close() { (broker+console).forEach { $0.close() } }
}
public struct RunConfiguration: Sendable {
    let appliance:ArtifactVerifiedAppliance, bootstrap:BootstrapConfiguration, channels:VMChannelSet, capability:Data
    var binding:RunBinding { bootstrap.binding }
}
enum BootstrapProbeID: String, CaseIterable, Sendable {
    case browserFdDonor = "BROWSER_FD_DONOR"
    case browserHelperIPv4 = "BROWSER_HELPER_IPV4"
    case browserHelperIPv6 = "BROWSER_HELPER_IPV6"
    case browserIOUring = "BROWSER_IO_URING"
    case browserIPv4TCP = "BROWSER_IPV4_TCP"
    case browserIPv6TCP = "BROWSER_IPV6_TCP"
    case browserUDP = "BROWSER_UDP"
    case browserVsock = "BROWSER_VSOCK"
    case controllerDNSTCP = "CONTROLLER_DNS_TCP"
    case controllerDNSUDP = "CONTROLLER_DNS_UDP"
    case proxyVsockControl = "PROXY_VSOCK_CONTROL"
    case verifierIPv4TCP = "VERIFIER_IPV4_TCP"
}
enum BootstrapHostDevice: String, Sendable { case linuxBoot, readOnlyBlock, entropy, privateSerial, vsock }
enum BootstrapNetworkNamespace: String, Sendable { case guest, host }
enum BootstrapTransport: String, Sendable { case tcp, udp }
enum BootstrapProbeOutcome: String, Sendable { case denied, allowed, failed }
struct BootstrapEndpoint: Sendable, Equatable {
    let namespace:BootstrapNetworkNamespace, transport:BootstrapTransport, address:String, port:Int, uid:Int
}
struct BootstrapProbeResult: Sendable, Equatable {
    let id:BootstrapProbeID, attempted:Bool, outcome:BootstrapProbeOutcome, ownedReceiverCount:Int
}
struct BootstrapSnapshot: Sendable {
    let runID:String, manifestIdentity:String, roleInventoryDigest:String, deviceInventoryDigest:String, topologyDigest:String
    let observedAt:Int, expiresAt:Int, hostDevices:[BootstrapHostDevice], proxy:BootstrapEndpoint, probes:[BootstrapProbeResult]
}
protocol BootstrapProbePort: Sendable { func capture(ids:[BootstrapProbeID]) throws -> BootstrapSnapshot }
protocol BootstrapLifecyclePort: Sendable { func begin(snapshot:BootstrapSnapshot,onDrift:@escaping @Sendable () -> Void) throws }
public struct AdmissionProof: Sendable {
    public let runID:String, manifestIdentity:String, roleInventoryDigest:String, deviceInventoryDigest:String, topologyDigest:String, expiresAt:Int
}
public final class BootstrapQualification: @unchecked Sendable {
    private let proof:AdmissionProof, lock = NSLock()
    private var failed = false
    init(_ proof:AdmissionProof) { self.proof = proof }
    public func requireBrowserAdmission() throws -> AdmissionProof {
        try lock.withLock { guard !failed else { throw VMFailure.terminal }; return proof }
    }
    fileprivate func topologyDrifted() { lock.withLock { failed = true } }
}
private final class RunAuthority: @unchecked Sendable {
    let run:RunConfiguration, release:VerifiedRelease, authority:ReleaseAuthority, runEnd:Int
    private let lock = NSLock(); private var last:ClockSample
    init(run:RunConfiguration,sample:ClockSample) throws {
        self.run = run; last = sample
        guard sample.wall >= 0, sample.monotonic >= 0, sample.wall <= 9007199254740991, sample.monotonic <= 9007199254740991 - 1200000 else { throw VMFailure.clock }
        let b = run.binding, limits = run.appliance.manifest.resources
        guard b.manifest.identity == run.appliance.manifest.digest, b.manifest.limits == run.bootstrap.limits,
              b.manifest.limits.bytes > 0, b.manifest.limits.bytes <= limits["aggregateTunnelBytes"]!,
              b.manifest.limits.idleMs > 0, b.manifest.limits.idleMs <= limits["idleTimeoutMs"]!,
              b.durationMs > 0, b.durationMs <= limits["runTimeoutMs"]!, b.expiresAt > sample.wall,
              b.expiresAt - sample.wall <= limits["runTimeoutMs"]!, b.capability.count == 32, run.capability.count == 32,
              zip(b.capability,run.capability).reduce(UInt8(0),{ $0 | ($1.0 ^ $1.1) }) == 0 else { throw VMFailure.binding }
        runEnd = sample.monotonic + b.durationMs
        try run.channels.validate(); try run.appliance.recheck(); try run.appliance.plan.validateResources()
        do {
            authority = try ReleaseAuthority(expectedRelease:run.bootstrap.expectedRelease,publicKey:run.bootstrap.publicKey,maxAgeMs:run.bootstrap.maxAgeMs,notBefore:run.bootstrap.notBefore,deadline:run.bootstrap.releaseDeadline)
            release = try ReceiptVerifier.verifyRelease(run.bootstrap.candidateRelease,authority:authority,atWallTime:sample.wall)
        } catch { throw VMFailure.invalidSignature }
        _ = try check(sample)
    }
    // Returns the remaining authority interval from one checked clock sample.
    func check(_ sample:ClockSample) throws -> Int {
        try lock.withLock {
            guard sample.wall >= last.wall, sample.monotonic >= last.monotonic,
                  sample.wall <= 9007199254740991, sample.monotonic <= 9007199254740991 else { throw VMFailure.clock }
            last = sample
            let b = run.binding
            guard sample.wall < b.expiresAt, sample.monotonic < runEnd,
                  let r = ReceiptVerifier.inspectRelease(release,authority:authority,atWallTime:sample.wall),
                  let releaseEnd = ReceiptVerifier.releaseUseDeadline(release,authority:authority,atWallTime:sample.wall), releaseEnd > sample.wall else { throw VMFailure.expired }
            guard r["runId"] as? String == b.runID, r["configIdentity"] as? String == b.configIdentity,
                  let origins = r["origins"] as? [String:String], b.origins.count == 2,
                  b.origins[.frontend] == origins["FRONTEND"], b.origins[.backend] == origins["BACKEND"] else { throw VMFailure.binding }
            return min(runEnd-sample.monotonic,b.expiresAt-sample.wall,releaseEnd-sample.wall)
        }
    }
}
// dispose invalidates owned channel resources independently of stop acknowledgement;
// it must not prevent an already-issued/retired owner's stop request. Fake-only seam.
protocol OfflineVMInstance: Sendable { func stop() async throws; func dispose() }
protocol OfflineVMEffects: Sendable { func start(plan:VMConfigurationPlan) async throws -> any OfflineVMInstance }
public enum VMHost {
    // No native signature/entitlement/guest/terminal proof implementation exists yet.
    // Do not construct a VM, disk/serial attachment or listener before those gates.
    public static func start(run:RunConfiguration) async throws -> VMHandle {
        try run.channels.claim()
        run.channels.close(); throw VMFailure.signatureUnavailable
    }
    // No native probe/lifecycle construction exists in M4. A nominal success
    // value, caller boolean, or unsigned document can never enter this path.
    public static func bootstrapCheck(run:RunConfiguration) throws -> BootstrapQualification {
        throw VMFailure.admissionUnavailable
    }
}
enum OfflineVMHost {
    static func start(run:RunConfiguration,admission:OfflineAdmission,effects:any OfflineVMEffects,clock:any BrokerClock) async throws -> VMHandle {
        // Duplicate callers acquire no ownership and must not close an active run.
        try run.channels.claim()
        do {
            try admission.check()
            let authority = try RunAuthority(run:run,sample:clock.sample())
            let handle = VMHandle(run:run,authority:authority,clock:clock)
            try await handle.begin(effects:effects)
            return handle
        } catch { run.channels.close(); throw error }
    }
    static func bootstrapCheck(run:RunConfiguration,probe:any BootstrapProbePort,lifecycle:any BootstrapLifecyclePort,clock:any BrokerClock) throws -> BootstrapQualification {
        do {
            let sample = try clock.sample(), authority = try RunAuthority(run:run,sample:sample)
            _ = try authority.check(sample)
            try run.appliance.recheck(); try run.appliance.plan.validateResources()
            let ids = BootstrapProbeID.allCases
            let snapshot = try probe.capture(ids:ids)
            let digest = { (value:String) in value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
            guard sample.wall >= 0, snapshot.observedAt == sample.wall,
                  snapshot.runID == run.binding.runID,
                  snapshot.manifestIdentity == run.appliance.manifest.digest,
                  snapshot.expiresAt == run.binding.expiresAt,
                  snapshot.observedAt < snapshot.expiresAt,
                  digest(snapshot.roleInventoryDigest), digest(snapshot.deviceInventoryDigest), digest(snapshot.topologyDigest),
                  snapshot.hostDevices == [.linuxBoot,.readOnlyBlock,.entropy,.privateSerial,.vsock],
                  snapshot.proxy == BootstrapEndpoint(namespace:.guest,transport:.tcp,address:"127.0.0.1",port:3128,uid:10004),
                  snapshot.probes.map(\.id) == ids else { throw VMFailure.admissionUnavailable }
            for result in snapshot.probes {
                let positive = result.id == .proxyVsockControl
                guard result.attempted,
                      result.outcome == (positive ? .allowed:.denied),
                      result.ownedReceiverCount == (positive ? 1:0) else { throw VMFailure.admissionUnavailable }
            }
            let proof = AdmissionProof(runID:snapshot.runID,manifestIdentity:snapshot.manifestIdentity,
                roleInventoryDigest:snapshot.roleInventoryDigest,deviceInventoryDigest:snapshot.deviceInventoryDigest,
                topologyDigest:snapshot.topologyDigest,expiresAt:snapshot.expiresAt)
            let qualification = BootstrapQualification(proof)
            try lifecycle.begin(snapshot:snapshot,onDrift:{ qualification.topologyDrifted() })
            return qualification
        } catch let error as VMFailure {
            if error == .terminal { throw error }
            throw VMFailure.admissionUnavailable
        } catch {
            throw VMFailure.admissionUnavailable
        }
    }
}
private final class OwnedVMInstance: @unchecked Sendable {
    let instance:any OfflineVMInstance
    private let lock = NSLock(); private var disposed = false
    init(_ instance:any OfflineVMInstance) { self.instance = instance }
    func dispose() { let first = lock.withLock { if disposed { return false }; disposed = true; return true }; if first { instance.dispose() } }
}

// Lock-serialized ownership; no task-group join can hold a cancelled waiter hostage
// to an adapter that ignores cancellation. Late results remain owned and retired.
public final class VMHandle: @unchecked Sendable {
    private let run:RunConfiguration, authority:RunAuthority, clock:any BrokerClock, lock = NSLock()
    private var failure:VMFailure?, started = false, instance:OwnedVMInstance?
    private var startWaiter:CheckedContinuation<Void,any Error>?
    private var startTask:Task<Void,Never>?, watchTask:Task<Void,Never>?, stopTimer:Task<Void,Never>?
    private var stopping = false, stopResult:StopOutcome?, stopWaiters:[CheckedContinuation<StopOutcome,Never>] = []
    private var lastStopSample:ClockSample?
    fileprivate init(run:RunConfiguration,authority:RunAuthority,clock:any BrokerClock) { self.run = run; self.authority = authority; self.clock = clock }
    fileprivate func begin(effects:any OfflineVMEffects) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c:CheckedContinuation<Void,any Error>) in
                lock.withLock {
                    if Task.isCancelled || failure != nil { c.resume(throwing:failure ?? .cancelled); return }
                    startWaiter = c
                    startTask = Task { [self] in
                        do {
                            guard lock.withLock({ failure == nil }) else { return }
                            _ = try authority.check(clock.sample()); try run.appliance.recheck()
                            guard lock.withLock({ failure == nil }) else { return }
                            let result = try await effects.start(plan:run.appliance.plan)
                            receive(result)
                        } catch { abort(error as? VMFailure ?? .start) }
                    }
                    watchTask = Task { [self] in
                        do {
                            while !Task.isCancelled {
                                let delay = try authority.check(clock.sample())
                                try await clock.wait(milliseconds:delay)
                            }
                        } catch { if !Task.isCancelled { abort(error as? VMFailure ?? .clock) } }
                    }
                }
            }
            if Task.isCancelled { abort(.cancelled); throw VMFailure.cancelled }
        } onCancel: { self.abort(.cancelled) }
    }
    private func receive(_ result:any OfflineVMInstance) {
        let owned = OwnedVMInstance(result)
        let publish:Bool = lock.withLock {
            do { _ = try authority.check(clock.sample()); try run.appliance.recheck() }
            catch { if failure == nil { failure = error as? VMFailure ?? .binding } }
            guard failure == nil else { return false }
            instance = owned; started = true
            let waiter = startWaiter; startWaiter = nil; waiter?.resume(); return true
        }
        if !publish {
            abort(lock.withLock { failure ?? .terminal })
            // A retired result cannot publish a handle. Disposal is not stopped proof.
            owned.dispose()
            Task { try? await owned.instance.stop() }
        }
    }
    private func abort(_ reason:VMFailure) {
        let hasInstance = lock.withLock {
            if failure == nil { failure = reason }
            let waiter = startWaiter; startWaiter = nil; waiter?.resume(throwing:failure!)
            startTask?.cancel(); watchTask?.cancel()
            return instance != nil
        }
        run.channels.close()
        if hasInstance { Task { _ = await stop(deadline:cleanupDeadline()) } }
    }
    private func cleanupDeadline() -> Int {
        guard let sample = try? clock.sample(), sample.monotonic >= 0, sample.monotonic <= 9007199254739991 else { return 0 }
        return sample.monotonic + 1000
    }
    private func prepareStop(deadline:Int) {
        lock.withLock {
            guard !stopping else { return }
            stopping = true; if failure == nil { failure = .terminal }
            let waiter = startWaiter; startWaiter = nil; waiter?.resume(throwing:failure!)
            startTask?.cancel(); watchTask?.cancel(); run.channels.close()
            guard let owned = instance, started else { finishStopLocked(.failed); return }
            if Task.isCancelled { finishStopLocked(.failed) }
            let sample = try? clock.sample()
            let valid = deadline >= 0 && deadline <= 9007199254740991 && sample != nil && sample!.monotonic >= 0 && sample!.monotonic <= 9007199254740991 && sample!.wall >= 0 && sample!.wall <= 9007199254740991
            if valid { lastStopSample = sample }
            let remaining = valid && deadline > sample!.monotonic ? deadline - sample!.monotonic : 0
            if !valid || remaining > 120000 { finishStopLocked(.failed) }
            else if remaining == 0 { finishStopLocked(.deadlineExceeded) }
            Task {
                do { try await owned.instance.stop(); finishSuccessfulStop(deadline:deadline) }
                catch { finishStop(.failed) }
                owned.dispose()
            }
            if stopResult == nil {
                stopTimer = Task {
                    do {
                        var sample = try lock.withLock { try observeStopClockLocked(deadline:deadline) }
                        while sample.monotonic < deadline {
                            try await clock.wait(milliseconds:deadline-sample.monotonic)
                            sample = try lock.withLock { try observeStopClockLocked(deadline:deadline) }
                        }
                        finishStop(.deadlineExceeded)
                    } catch { if !Task.isCancelled { finishStop(.failed) } }
                }
            }
        }
    }
    public func stop(deadline:Int) async -> StopOutcome {
        // Claim teardown before installing the cancellation handler: a caller already
        // cancelled must still close channels and dispatch the one owned stop request.
        prepareStop(deadline:deadline)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { c in
                lock.withLock {
                    if let result = stopResult { c.resume(returning:result) }
                    else { stopWaiters.append(c) }
                }
            }
        } onCancel: { self.finishStop(.failed) }
    }
    private func finishStopLocked(_ outcome:StopOutcome) {
        guard stopResult == nil else { return }; stopResult = outcome; stopTimer?.cancel(); instance?.dispose()
        let waiters = stopWaiters; stopWaiters = []; waiters.forEach { $0.resume(returning:outcome) }
    }
    // Both timer and completion share the latest observation. Check and publication
    // are serialized so a late success cannot beat a timer through scheduling order.
    private func observeStopClockLocked(deadline:Int) throws -> ClockSample {
        do {
            let sample = try clock.sample()
            guard let previous = lastStopSample, sample.monotonic >= previous.monotonic, sample.wall >= previous.wall,
                  sample.monotonic <= 9007199254740991, sample.wall <= 9007199254740991 else { throw VMFailure.clock }
            lastStopSample = sample
            if sample.monotonic >= deadline { finishStopLocked(.deadlineExceeded) }
            return sample
        } catch {
            // Latch before releasing the observer's lock: a recovered clock in a
            // concurrent completion must not turn an observed failure into success.
            finishStopLocked(.failed)
            throw error
        }
    }
    private func finishSuccessfulStop(deadline:Int) {
        lock.withLock {
            guard stopResult == nil else { return }
            do { _ = try observeStopClockLocked(deadline:deadline); finishStopLocked(.stopped) }
            catch { finishStopLocked(.failed) }
        }
    }
    private func finishStop(_ outcome:StopOutcome) { lock.withLock { finishStopLocked(outcome) } }
    public func terminalLost() async { abort(.terminal); _ = await stop(deadline:cleanupDeadline()) }
    public func channelLost() async { abort(.terminal); _ = await stop(deadline:cleanupDeadline()) }
}

public enum HostCommand: Equatable, Sendable { case validateAppliance(manifest:String, expected:String, base:String, kernel:String, initramfs:String), bootstrapCheck, qualify, runSynthetic }
public enum HostDispatch {
    public static func parse(_ args:[String]) throws -> HostCommand {
        if args == ["bootstrap-check"] { return .bootstrapCheck }
        if args == ["qualify"] { return .qualify }
        if args == ["run-synthetic"] { return .runSynthetic }
        guard args.count == 11, args[0] == "validate-appliance", [args[1],args[3],args[5],args[7],args[9]] == ["--manifest","--expected-digest","--base","--kernel","--initramfs"], [2,4,6,8,10].allSatisfy({ !args[$0].isEmpty }) else { throw VMFailure.usage }
        return .validateAppliance(manifest:args[2],expected:args[4],base:args[6],kernel:args[8],initramfs:args[10])
    }
    public static func execute(_ command:HostCommand,validate:(String,String,String,String,String) throws -> [ApplianceFailure]) throws -> [ApplianceFailure] {
        switch command {
        case let .validateAppliance(manifest,expected,base,kernel,initramfs):
            let result = try validate(manifest,expected,base,kernel,initramfs)
            // Even an incorrectly permissive injected validator cannot qualify runtime.
            return result + [.signingUnavailable,.qualificationUnavailable].filter { !result.contains($0) }
        case .bootstrapCheck,.qualify,.runSynthetic: throw VMFailure.unavailable
        }
    }
}
