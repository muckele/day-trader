import Foundation
import Darwin
import CryptoKit

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
protocol BootstrapProbePort: Sendable { func capture(ids:[BootstrapProbeID]) throws -> Data }
protocol BootstrapLifecyclePort: Sendable { func begin(handoff:Data,onDrift:@escaping @Sendable () -> Void) throws }
protocol BootstrapActivationPort: Sendable { func activateBrowser(proof:AdmissionProof) throws }
public struct AdmissionProof: Sendable {
    public let runID:String, manifestIdentity:String, roleInventoryDigest:String, deviceInventoryDigest:String, topologyDigest:String, expiresAt:Int
    public let sequence:Int, observedWall:Int, observedMonotonic:Int
}

enum BootstrapHandoff {
    private static let maxBytes = 131072
    private static let devices = ["LINUX_BOOT","VIRTIO_BLOCK_READ_ONLY","VIRTIO_ENTROPY","VIRTIO_SERIAL_PRIVATE_PIPE","VIRTIO_VSOCK_CID2_PORT4050"]
    private static let roles:[(String,Int,String)] = [
        ("CONTROLLER",10001,"294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3"),
        ("BROWSER",10002,"294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3"),
        ("VERIFIER",10003,"294f083482eb1caa13cd40ddb98489acd0712b2bd1a6e1d634622a24ed18d7b3"),
        ("PROXY",10004,"01e3ec748fdbadb0a0ac195855506cc19680fcc5aa3c6289d2c15e15ec981d7d"),
    ]
    private static let programs = ["/opt/acceptance/guest/browser-worker.cjs","/opt/acceptance/guest/controller.cjs","/opt/acceptance/guest/proxy.py","/opt/acceptance/guest/verifier.cjs","/opt/acceptance/runtime/chromium/chrome","/opt/acceptance/runtime/node/bin/node","/opt/acceptance/runtime/python/bin/python3"]
    private static func hex(_ value:String,count:Int) -> Bool { value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private static func integer(_ value:Any?,_ lower:Int = 0,_ upper:Int = 9007199254740991) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(lower), number.doubleValue <= Double(upper) else { return nil }
        return number.intValue
    }
    private static func object(_ value:Any?) throws -> [String:Any] { guard let value = value as? [String:Any] else { throw VMFailure.admissionUnavailable }; return value }
    private static func array(_ value:Any?) throws -> [Any] { guard let value = value as? [Any] else { throw VMFailure.admissionUnavailable }; return value }
    private static func string(_ value:Any?) throws -> String { guard let value = value as? String, !value.isEmpty, value.utf8.count <= 512, value.canBeConverted(to:.ascii) else { throw VMFailure.admissionUnavailable }; return value }
    private static func canonical(_ value:Any) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]) }
    private static func digest(_ value:Any) throws -> String { SHA256.hash(data:try canonical(value)).map { String(format:"%02x",$0) }.joined() }
    private static func equalMAC(_ lhs:Data,_ rhs:Data) -> Bool { lhs.count == rhs.count && zip(lhs,rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0 }
    private static func exactStrings(_ value:Any?,_ expected:[String]) throws {
        let rows = try array(value); guard rows.count == expected.count else { throw VMFailure.admissionUnavailable }
        for (row,wanted) in zip(rows,expected) { guard try string(row) == wanted else { throw VMFailure.admissionUnavailable } }
    }
    private static func validateDevices(_ value:[String:Any]) throws {
        guard Set(value.keys) == ["abstractUnix","dnsServers","hostDevices","interfaces","listeners","routes"] else { throw VMFailure.admissionUnavailable }
        try exactStrings(value["hostDevices"],devices); try exactStrings(value["interfaces"],["lo"])
        for key in ["routes","dnsServers","abstractUnix"] { guard try array(value[key]).isEmpty else { throw VMFailure.admissionUnavailable } }
        let listeners = try array(value["listeners"]); guard listeners.count == 1 else { throw VMFailure.admissionUnavailable }
        let listener = try object(listeners[0]); guard Set(listener.keys) == ["namespace","transport","address","port","uid"],
              try string(listener["namespace"]) == "GUEST", try string(listener["transport"]) == "TCP",
              try string(listener["address"]) == "127.0.0.1", integer(listener["port"],1,65535) == 3128,
              integer(listener["uid"],1,Int(UInt32.max)) == 10004 else { throw VMFailure.admissionUnavailable }
    }
    private static func validateRoles(_ value:Any?,runID:String) throws {
        let rows = try array(value); guard rows.count == roles.count else { throw VMFailure.admissionUnavailable }
        var pids = Set<Int>()
        for (raw,expected) in zip(rows,roles) {
            let row = try object(raw), pid = integer(row["pid"],1,Int(Int32.max))
            guard Set(row.keys) == ["pid","runId","role","uids","gids","groups","capabilities","noNewPrivs","seccomp","filterDigest","fds","views","waiting","programs"],
                  try string(row["role"]) == expected.0, try string(row["runId"]) == runID,
                  let pid, pids.insert(pid).inserted, try string(row["filterDigest"]) == expected.2,
                  integer(row["noNewPrivs"]) == 1, integer(row["seccomp"]) == 2,
                  (row["waiting"] as? Bool) == true else { throw VMFailure.admissionUnavailable }
            for key in ["uids","gids"] { let values = try array(row[key]); guard values.count == 3 && values.allSatisfy({ integer($0,1,Int(UInt32.max)) == expected.1 }) else { throw VMFailure.admissionUnavailable } }
            guard try array(row["groups"]).isEmpty else { throw VMFailure.admissionUnavailable }
            let capabilities = try array(row["capabilities"]); guard capabilities.count == 5 && capabilities.allSatisfy({ integer($0,0,Int(UInt32.max)) == 0 }) else { throw VMFailure.admissionUnavailable }
            let fds = try array(row["fds"]), peer = expected.0 == "CONTROLLER" ? "BOOTSTRAP":"CONTROLLER"
            guard fds.count == 5 else { throw VMFailure.admissionUnavailable }
            for (index,rawFD) in fds.enumerated() {
                let fd = try object(rawFD), purpose = ["stdin","stdout","stderr","command","result"][index]
                guard Set(fd.keys) == ["fd","kind","purpose","peer","runId"], integer(fd["fd"],0,1024) == index, try string(fd["kind"]) == (index < 3 ? "null":"pipe"),
                      try string(fd["purpose"]) == purpose, try string(fd["peer"]) == peer,
                      try string(fd["runId"]) == runID else { throw VMFailure.admissionUnavailable }
            }
            let views = try object(row["views"])
            guard Set(views.keys) == ["role","root","visibleRoles","privateMode","console","separatePid","separateMount","initialUserNamespace","controllingTty","readOnlyBase","deviceNodes","privateTmpfs","noExternalIpInterface","noFdDonor"],
                  try string(views["role"]) == expected.0,
                  try string(views["root"]) == "/run/acceptance/\(expected.0.lowercased())",
                  integer(views["privateMode"],0,4095) == 448 else { throw VMFailure.admissionUnavailable }
            try exactStrings(views["visibleRoles"],[expected.0]); try exactStrings(views["deviceNodes"],["/dev/null"])
            for key in ["separatePid","separateMount","initialUserNamespace","readOnlyBase","privateTmpfs","noExternalIpInterface","noFdDonor"] { guard (views[key] as? Bool) == true else { throw VMFailure.admissionUnavailable } }
            for key in ["console","controllingTty"] { guard (views[key] as? Bool) == false else { throw VMFailure.admissionUnavailable } }
            let pins = try array(row["programs"]); guard pins.count == programs.count else { throw VMFailure.admissionUnavailable }
            for (rawPin,path) in zip(pins,programs) { let pin = try object(rawPin); guard Set(pin.keys) == ["path","sha256"], try string(pin["path"]) == path, hex(try string(pin["sha256"]),count:64) else { throw VMFailure.admissionUnavailable } }
        }
    }
    private static func validateProbes(_ value:Any?) throws {
        let rows = try array(value), expected = BootstrapProbeID.allCases; guard rows.count == expected.count else { throw VMFailure.admissionUnavailable }
        for (raw,id) in zip(rows,expected) { let row = try object(raw), positive = id == .proxyVsockControl
            guard Set(row.keys) == ["attempted","identifier","outcome","ownedReceiverCount"], try string(row["identifier"]) == id.rawValue, (row["attempted"] as? Bool) == true,
                  try string(row["outcome"]) == (positive ? "ALLOWED":"DENIED"),
                  integer(row["ownedReceiverCount"],0,1) == (positive ? 1:0) else { throw VMFailure.admissionUnavailable } }
    }
    static func verify(data:Data,expectedRunID:String,manifestIdentity:String,configIdentity:String,expiresAt:Int,capability:Data) throws -> AdmissionProof {
        do {
            guard data.count <= maxBytes, capability.count == 32 else { throw VMFailure.admissionUnavailable }
            let raw = try JSONSerialization.jsonObject(with:data,options:[]), envelope = try object(raw)
            guard Set(envelope.keys) == ["mac","payload","version"], integer(envelope["version"]) == 1,
                  try canonical(envelope) == data else { throw VMFailure.admissionUnavailable }
            let payload = try object(envelope["payload"]), supplied = try string(envelope["mac"])
            guard Set(payload.keys) == ["configIdentity","devices","expiresAt","manifestIdentity","observedMonotonic","observedWall","probes","proxy","roles","runId","sequence"] else { throw VMFailure.admissionUnavailable }
            guard hex(supplied,count:64), let suppliedData = Data(hexString:supplied) else { throw VMFailure.admissionUnavailable }
            let bytes = try canonical(payload), calculated = Data(HMAC<SHA256>.authenticationCode(for:bytes,using:SymmetricKey(data:capability)))
            guard equalMAC(suppliedData,calculated), try string(payload["runId"]) == expectedRunID,
                  try string(payload["manifestIdentity"]) == manifestIdentity,
                  try string(payload["configIdentity"]) == configIdentity,
                  integer(payload["expiresAt"],1) == expiresAt,
                  let sequence = integer(payload["sequence"],1), let observedWall = integer(payload["observedWall"]),
                  let observedMonotonic = integer(payload["observedMonotonic"]) else { throw VMFailure.admissionUnavailable }
            let deviceObject = try object(payload["devices"]); try validateDevices(deviceObject)
            try validateRoles(payload["roles"],runID:expectedRunID); try validateProbes(payload["probes"])
            let proxy = try object(payload["proxy"])
            guard Set(proxy.keys) == ["configIdentity","expiresAt","hostCid","listenAddress","listenPort","manifestIdentity","runId","servicePort","uid"],
                  try string(proxy["runId"]) == expectedRunID, try string(proxy["manifestIdentity"]) == manifestIdentity,
                  try string(proxy["configIdentity"]) == configIdentity, integer(proxy["expiresAt"],1) == expiresAt,
                  try string(proxy["listenAddress"]) == "127.0.0.1", integer(proxy["listenPort"],1,65535) == 3128,
                  integer(proxy["hostCid"],1,Int(UInt32.max)) == 2,
                  integer(proxy["servicePort"],1,65535) == 4050, integer(proxy["uid"],1,Int(UInt32.max)) == 10004 else { throw VMFailure.admissionUnavailable }
            var stable = payload; stable.removeValue(forKey:"sequence"); stable.removeValue(forKey:"observedWall"); stable.removeValue(forKey:"observedMonotonic")
            return AdmissionProof(runID:expectedRunID,manifestIdentity:manifestIdentity,
                roleInventoryDigest:try digest(payload["roles"]!),deviceInventoryDigest:try digest(deviceObject),
                topologyDigest:try digest(stable),expiresAt:expiresAt,sequence:sequence,
                observedWall:observedWall,observedMonotonic:observedMonotonic)
        } catch { throw VMFailure.admissionUnavailable }
    }
}

private extension Data {
    init?(hexString:String) { var bytes = [UInt8](), index = hexString.startIndex
        while index < hexString.endIndex { let next = hexString.index(index,offsetBy:2); guard let byte = UInt8(hexString[index..<next],radix:16) else { return nil }; bytes.append(byte); index = next }
        self.init(bytes) }
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

public final class BootstrapQualification: @unchecked Sendable {
    private let run:RunConfiguration, authority:RunAuthority, clock:any BrokerClock
    private let probe:any BootstrapProbePort
    private let lock = NSLock()
    private var proof:AdmissionProof, lastClock:ClockSample, failed = false, activated = false
    fileprivate init(run:RunConfiguration,authority:RunAuthority,clock:any BrokerClock,probe:any BootstrapProbePort,
         proof:AdmissionProof,lastClock:ClockSample) {
        self.run=run; self.authority=authority; self.clock=clock; self.probe=probe
        self.proof=proof; self.lastClock=lastClock
    }
    private func checkedSample() throws -> ClockSample {
        let sample = try clock.sample()
        guard sample.wall >= lastClock.wall, sample.monotonic >= lastClock.monotonic else { throw VMFailure.clock }
        _ = try authority.check(sample); lastClock = sample; return sample
    }
    private func latch<T>(_ body:() throws -> T) throws -> T {
        try lock.withLock {
            guard !failed else { throw VMFailure.terminal }
            do { return try body() }
            catch let error as VMFailure { failed = true; throw error }
            catch { failed = true; throw VMFailure.admissionUnavailable }
        }
    }
    private func resample() throws -> AdmissionProof {
        let before = try checkedSample(); try run.appliance.recheck()
        let data = try probe.capture(ids:BootstrapProbeID.allCases)
        let after = try checkedSample(); try run.appliance.recheck()
        let current = try BootstrapHandoff.verify(data:data,expectedRunID:run.binding.runID,
            manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
            expiresAt:run.binding.expiresAt,capability:run.capability)
        guard current.sequence == proof.sequence + 1,
              current.topologyDigest == proof.topologyDigest,
              current.roleInventoryDigest == proof.roleInventoryDigest,
              current.deviceInventoryDigest == proof.deviceInventoryDigest,
              before.wall <= current.observedWall, current.observedWall <= after.wall,
              before.monotonic <= current.observedMonotonic, current.observedMonotonic <= after.monotonic,
              after.wall-current.observedWall <= 1, after.monotonic-current.observedMonotonic <= 1 else { throw VMFailure.admissionUnavailable }
        proof=current; return current
    }
    func currentProofWithoutActivation() throws -> AdmissionProof { try lock.withLock { guard !failed else { throw VMFailure.terminal }; return proof } }
    public func requireBrowserAdmission() throws -> AdmissionProof { try latch { try resample() } }
    func activateBrowser(_ activation:any BootstrapActivationPort) throws {
        try latch {
            guard !activated else { throw VMFailure.terminal }
            let current = try resample()
            try activation.activateBrowser(proof:current); proof=current; activated=true
        }
    }
    fileprivate func topologyDrifted() { lock.withLock { failed = true } }
}

struct NativeBootstrapComposition: Sendable {
    let manifestPath:String, releasePath:String
    static func select(manifestPath:String,releasePath:String,platform:String,machine:String) throws -> Self {
        guard platform == "linux", machine == "arm64", !manifestPath.isEmpty, !releasePath.isEmpty,
              manifestPath.utf8.count <= 4096, releasePath.utf8.count <= 4096,
              manifestPath.first == "/", releasePath.first == "/" else { throw VMFailure.admissionUnavailable }
        return Self(manifestPath:manifestPath,releasePath:releasePath)
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
    // The CLI may parse only these two explicit signed-input locations. Until a
    // future signed/native constructor produces RunConfiguration plus the fixed
    // probe/lifecycle ports above, even a well-formed invocation remains closed.
    public static func bootstrapCheck(invocation:BootstrapInvocation) throws -> BootstrapQualification {
        guard invocation.manifest.first == "/", invocation.release.first == "/" else { throw VMFailure.usage }
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
            let before = try clock.sample(), authority = try RunAuthority(run:run,sample:before)
            _ = try authority.check(before)
            try run.appliance.recheck(); try run.appliance.plan.validateResources()
            let ids = BootstrapProbeID.allCases
            let handoff = try probe.capture(ids:ids)
            let after = try clock.sample(); _ = try authority.check(after); try run.appliance.recheck()
            guard after.wall >= before.wall, after.monotonic >= before.monotonic else { throw VMFailure.clock }
            let proof = try BootstrapHandoff.verify(data:handoff,expectedRunID:run.binding.runID,
                manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
                expiresAt:run.binding.expiresAt,capability:run.capability)
            guard proof.sequence == 1, before.wall <= proof.observedWall, proof.observedWall <= after.wall,
                  before.monotonic <= proof.observedMonotonic, proof.observedMonotonic <= after.monotonic,
                  after.wall-proof.observedWall <= 1, after.monotonic-proof.observedMonotonic <= 1 else { throw VMFailure.admissionUnavailable }
            let qualification = BootstrapQualification(run:run,authority:authority,clock:clock,
                probe:probe,proof:proof,lastClock:after)
            try lifecycle.begin(handoff:handoff,onDrift:{ qualification.topologyDrifted() })
            let final = try clock.sample(); _ = try authority.check(final); try run.appliance.recheck()
            guard final.wall >= after.wall, final.monotonic >= after.monotonic else { throw VMFailure.clock }
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

public struct BootstrapInvocation: Equatable, Sendable { public let manifest:String, release:String }
public enum HostCommand: Equatable, Sendable { case validateAppliance(manifest:String, expected:String, base:String, kernel:String, initramfs:String), bootstrapCheck, qualify, runSynthetic }
public enum HostDispatch {
    public static func bootstrapInvocation(_ args:[String]) throws -> BootstrapInvocation? {
        guard args.first == "bootstrap-check" else { return nil }
        guard args.count == 5, [args[1],args[3]] == ["--manifest","--release"],
              !args[2].isEmpty, !args[4].isEmpty else {
            if args == ["bootstrap-check"] { return nil }
            throw VMFailure.usage
        }
        return BootstrapInvocation(manifest:args[2],release:args[4])
    }
    public static func parse(_ args:[String]) throws -> HostCommand {
        if args == ["bootstrap-check"] { return .bootstrapCheck }
        if args.count == 5, args[0] == "bootstrap-check",
           [args[1],args[3]] == ["--manifest","--release"],
           !args[2].isEmpty, !args[4].isEmpty { return .bootstrapCheck }
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
