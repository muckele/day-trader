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
protocol BootstrapOwnedLifecycle: Sendable { func stopOwned(deadline:Int) throws -> BootstrapStopOutcome }
protocol BootstrapLifecyclePort: Sendable { func begin(handoff:Data,onDrift:@escaping @Sendable () -> Void) throws -> any BootstrapOwnedLifecycle }
enum BootstrapStopOutcome: Sendable { case stopped, uncertain }
protocol BootstrapActivationTransaction: AnyObject, Sendable {
    func activate(authorize:@escaping @Sendable () throws -> Void) throws
    func stopOwned(deadline:Int) throws -> BootstrapStopOutcome
}
protocol BootstrapActivationPort: Sendable {
    // Exists before preparation: every preparation effect belongs to this exact
    // transaction. Returning another transaction is a terminal protocol failure.
    var cleanup:any BootstrapActivationTransaction { get }
    func prepareBrowser(proof:AdmissionProof) throws -> any BootstrapActivationTransaction
}
struct BootstrapExecutableMember: Hashable, Sendable {
    let path:String, componentID:String, memberPath:String
}
struct BootstrapExecutableAuthority: Sendable {
    let pins:[String:String], manifestIdentity:String?
    static let requiredPaths = [
        "/opt/acceptance/guest/browser-worker.cjs", "/opt/acceptance/guest/controller.cjs",
        "/opt/acceptance/guest/proxy.py", "/opt/acceptance/guest/verifier.cjs",
        "/opt/acceptance/runtime/chromium/chrome", "/opt/acceptance/runtime/node/bin/node",
        "/opt/acceptance/runtime/python/bin/python3",
    ]
    private static func valid(_ pins:[String:String]) -> Bool {
        Set(pins.keys) == Set(requiredPaths) && pins.values.allSatisfy {
            $0.utf8.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
    }
    static func qualify(manifest:ApplianceManifest,inventory:InstalledExecutableInventory) throws -> Self {
        do {
            let pins=try inventory.pins(manifest:manifest)
            guard valid(pins) else { throw VMFailure.admissionUnavailable }
            return Self(pins:pins,manifestIdentity:manifest.digest)
        } catch { throw VMFailure.admissionUnavailable }
    }
    // Only the explicitly offline model consumes these literal vector pins.
    static func offlineLiteral(pins:[String:String]) throws -> Self {
        guard valid(pins) else { throw VMFailure.admissionUnavailable }
        return Self(pins:pins,manifestIdentity:nil)
    }
}

private final class BootstrapCleanupBudget: @unchecked Sendable {
    private let clock:any BrokerClock, lock = NSLock()
    private var end:Int?, last:Int?, realEnd:UInt64?
    init(clock:any BrokerClock) { self.clock=clock }
    func remaining() -> Int {
        lock.withLock {
            let real = DispatchTime.now().uptimeNanoseconds / 1_000_000
            guard let sample = try? clock.sample(), sample.monotonic >= 0,
                  sample.monotonic <= 9007199254680991,
                  last == nil || sample.monotonic >= last! else { end=0; return 0 }
            last=sample.monotonic
            if end == nil { end=sample.monotonic + 60000; realEnd=real + 60000 }
            guard let realEnd, real < realEnd else { return 0 }
            return max(0,min(end! - sample.monotonic,Int(realEnd - real)))
        }
    }
    private final class ResultBox: @unchecked Sendable {
        let done=DispatchSemaphore(value:0)
        var outcome:Result<BootstrapStopOutcome,Error> = .success(.uncertain)
    }
    func stop(_ operation:@escaping @Sendable (Int) throws -> BootstrapStopOutcome) throws -> BootstrapStopOutcome {
        guard remaining() > 0 else { return .uncertain }
        let box=ResultBox()
        DispatchQueue.global().async { [self] in
            let allowance=remaining()
            if allowance > 0 { box.outcome=Result { try operation(allowance) } }
            box.done.signal()
        }
        while true {
            let allowance=remaining()
            guard allowance > 0 else { return .uncertain }
            if box.done.wait(timeout:.now() + .milliseconds(min(allowance,10))) == .success {
                let outcome = try box.outcome.get()
                return remaining() > 0 ? outcome:.uncertain
            }
        }
    }
}
struct BootstrapCleanupFailure: Error, Sendable {
    let cleanup:BootstrapQualification
}
public struct AdmissionProof: Sendable {
    public let runID:String, manifestIdentity:String, roleInventoryDigest:String, deviceInventoryDigest:String, topologyDigest:String, expiresAt:Int
    public let sequence:Int, observedWall:Int, observedMonotonic:Int
}

struct BootstrapCompositionExpectation: @unchecked Sendable {
    let rolePolicyDigest:String, epoch:Int, generation:Int
    let probeEpochDigest:String, fixtureInventoryDigest:String
    let eventSourceID:String, proxyRuntimeID:String
    let originalRoleRuntime:[[String:Any]]
}

enum BootstrapHandoff {
    static func validateRolesV2(_ value:Any,runID:String,programPins:[String:String],runtime:Any,originals:[[String:Any]],generation:Int) throws {
        try validateRoleRuntimeV1(runtime,originals:originals,generation:generation)
        // The base inventory is the immutable original launch attestation: all
        // four children were captured WAITING. The separate current roleRuntime
        // proves CONTROLLER/PROXY have since entered their fixed SERVICE state.
        try validateRoles(value,runID:runID,programPins:programPins)
    }
    // Pure v2 evidence comparison, not an authority constructor. `originals` must
    // come from the composition's retained original observer/serving owners. The
    // native composition constructor remains unavailable; literal test rows do
    // not acquire child, pipe, runtime or launch authority by passing this check.
    static func validateRoleRuntimeV1(_ value:Any, originals:[[String:Any]], generation:Int) throws {
        guard generation > 0, generation <= 9007199254740991 else { throw VMFailure.admissionUnavailable }
        let rows = try array(value)
        guard rows.count == roles.count, originals.count == roles.count else { throw VMFailure.admissionUnavailable }
        var childIDs = Set<String>(), pipeIDs = Set<String>()
        let limits = ["PROXY_LISTENER":1,"PROXY_STOP_SELECTOR":1,"PROXY_ACCEPTED_STREAM":16,
                      "PROXY_VSOCK_STREAM":16,"PROXY_CONNECT_SELECTOR":16]
        func exactInteger(_ value:Any?,_ lower:Int = 0,_ upper:Int = 9007199254740991) -> Int? {
            guard let number=value as? NSNumber,
                  !["d","f"].contains(String(cString:number.objCType)) else { return nil }
            return integer(value,lower,upper)
        }
        func decimal(_ value:Any?) -> Bool {
            guard let text = value as? String, !text.isEmpty, text.utf8.count <= 20,
                  text == "0" || text.first != "0", text.utf8.allSatisfy({ (48...57).contains($0) }) else { return false }
            return UInt64(text) != nil
        }
        for (index,raw) in rows.enumerated() {
            let row = try object(raw), role = roles[index].0
            let child = try string(row["childId"]), pipe = try string(row["pipeId"])
            guard Set(row.keys) == ["role","childId","pipeId","lifecycle","inheritedFDs","currentFDs"],
                  try string(row["role"]) == role, hex(child,count:32), hex(pipe,count:32),
                  childIDs.insert(child).inserted, pipeIDs.insert(pipe).inserted,
                  try string(row["lifecycle"]) == (role == "CONTROLLER" || role == "PROXY" ? "SERVICE":"WAITING"),
                  try canonical(row) == canonical(originals[index]) else { throw VMFailure.admissionUnavailable }
            let inherited = try array(row["inheritedFDs"])
            guard inherited.count == 5, inherited.enumerated().allSatisfy({ exactInteger($0.element) == $0.offset }) else { throw VMFailure.admissionUnavailable }
            let current = try array(row["currentFDs"])
            guard current.count >= 5, current.count <= 55 else { throw VMFailure.admissionUnavailable }
            var previous = -1, owners = Set<String>(), counts:[String:Int] = [:], runtimeIdentities = Set<String>()
            var selectorIdentities = Set<String>()
            for (offset,rawFD) in current.enumerated() {
                let fd = try object(rawFD), kind = try string(fd["kind"]), owner = try string(fd["ownerId"])
                guard Set(fd.keys) == ["fd","kind","device","inode","flags","ownerId","acquiredGeneration"],
                      let number = exactInteger(fd["fd"],0,4095), number > previous,
                      exactInteger(fd["flags"]) != nil, exactInteger(fd["acquiredGeneration"],1,generation) != nil,
                      decimal(fd["device"]), decimal(fd["inode"]), hex(owner,count:32), owners.insert(owner).inserted else { throw VMFailure.admissionUnavailable }
                previous = number
                if offset < 5 {
                    guard number == offset, kind == (offset < 3 ? "NULL":offset == 3 ? "COMMAND":"RESULT") else { throw VMFailure.admissionUnavailable }
                    if offset >= 3 {
                        guard exactInteger(fd["flags"])! & 3 == offset - 3,
                              runtimeIdentities.insert("\(fd["device"]!):\(fd["inode"]!)").inserted else { throw VMFailure.admissionUnavailable }
                    }
                } else {
                    guard role == "PROXY", let limit = limits[kind] else { throw VMFailure.admissionUnavailable }
                    let identity = "\(fd["device"]!):\(fd["inode"]!)"
                    if kind == "PROXY_STOP_SELECTOR" || kind == "PROXY_CONNECT_SELECTOR" {
                        // Linux epoll files share an anonymous inode. Their original
                        // acquisitions remain distinct through ownerId, FD and the
                        // exact current-to-original comparison above. This exception
                        // cannot alias an inherited pipe or an ordinary socket.
                        guard !runtimeIdentities.contains(identity) else { throw VMFailure.admissionUnavailable }
                        selectorIdentities.insert(identity)
                    } else {
                        guard !selectorIdentities.contains(identity), runtimeIdentities.insert(identity).inserted else { throw VMFailure.admissionUnavailable }
                    }
                    counts[kind,default:0] += 1
                    guard counts[kind]! <= limit else { throw VMFailure.admissionUnavailable }
                }
            }
            guard role != "PROXY" || counts["PROXY_LISTENER"] == 1,
                  counts["PROXY_VSOCK_STREAM",default:0] <= counts["PROXY_ACCEPTED_STREAM",default:0],
                  counts["PROXY_CONNECT_SELECTOR",default:0] <= counts["PROXY_ACCEPTED_STREAM",default:0] else { throw VMFailure.admissionUnavailable }
        }
    }
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
    private static func boolean(_ value:Any?,_ expected:Bool) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue == expected
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
    private static func validateRoles(_ value:Any?,runID:String,programPins:[String:String],serviceRoles:Set<String> = []) throws {
        guard Set(programPins.keys) == Set(programs), programPins.values.allSatisfy({ hex($0,count:64) }) else { throw VMFailure.admissionUnavailable }
        let rows = try array(value); guard rows.count == roles.count else { throw VMFailure.admissionUnavailable }
        var pids = Set<Int>()
        for (raw,expected) in zip(rows,roles) {
            let row = try object(raw), pid = integer(row["pid"],1,Int(Int32.max))
            guard Set(row.keys) == ["pid","runId","role","uids","gids","groups","capabilities","noNewPrivs","seccomp","filterDigest","fds","views","waiting","programs"],
                  try string(row["role"]) == expected.0, try string(row["runId"]) == runID,
                  let pid, pids.insert(pid).inserted, try string(row["filterDigest"]) == expected.2,
                  integer(row["noNewPrivs"]) == 1, integer(row["seccomp"]) == 2,
                  boolean(row["waiting"],!serviceRoles.contains(expected.0)) else { throw VMFailure.admissionUnavailable }
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
            for key in ["separatePid","separateMount","initialUserNamespace","readOnlyBase","privateTmpfs","noExternalIpInterface","noFdDonor"] { guard boolean(views[key],true) else { throw VMFailure.admissionUnavailable } }
            for key in ["console","controllingTty"] { guard boolean(views[key],false) else { throw VMFailure.admissionUnavailable } }
            let pins = try array(row["programs"]); guard pins.count == programs.count else { throw VMFailure.admissionUnavailable }
            for (rawPin,path) in zip(pins,programs) { let pin = try object(rawPin); guard Set(pin.keys) == ["path","sha256"], try string(pin["path"]) == path, try string(pin["sha256"]) == programPins[path] else { throw VMFailure.admissionUnavailable } }
        }
    }
    private static func validateProbes(_ value:Any?) throws {
        let rows = try array(value), expected = BootstrapProbeID.allCases; guard rows.count == expected.count else { throw VMFailure.admissionUnavailable }
        for (raw,id) in zip(rows,expected) { let row = try object(raw), positive = id == .proxyVsockControl
            guard Set(row.keys) == ["attempted","identifier","outcome","ownedReceiverCount"], try string(row["identifier"]) == id.rawValue, boolean(row["attempted"],true),
                  try string(row["outcome"]) == (positive ? "ALLOWED":"DENIED"),
                  integer(row["ownedReceiverCount"],0,1) == (positive ? 1:0) else { throw VMFailure.admissionUnavailable } }
    }
    static func verify(data:Data,expectedRunID:String,manifestIdentity:String,configIdentity:String,expiresAt:Int,capability:Data,executables:BootstrapExecutableAuthority,composition:BootstrapCompositionExpectation? = nil) throws -> AdmissionProof {
        do {
            guard executables.manifestIdentity == nil || executables.manifestIdentity == manifestIdentity else { throw VMFailure.admissionUnavailable }
            let programPins = executables.pins
            guard data.count <= maxBytes, capability.count == 32 else { throw VMFailure.admissionUnavailable }
            let raw = try JSONSerialization.jsonObject(with:data,options:[]), envelope = try object(raw)
            let wireVersion = composition == nil ? 1:2
            guard Set(envelope.keys) == ["mac","payload","version"], integer(envelope["version"]) == wireVersion,
                  try canonical(envelope) == data else { throw VMFailure.admissionUnavailable }
            let payload = try object(envelope["payload"]), supplied = try string(envelope["mac"])
            var payloadKeys:Set<String> = ["configIdentity","devices","expiresAt","manifestIdentity","observedMonotonic","observedWall","probes","proxy","roles","runId","sequence"]
            if composition != nil { payloadKeys.insert("composition") }
            guard Set(payload.keys) == payloadKeys else { throw VMFailure.admissionUnavailable }
            guard hex(supplied,count:64), let suppliedData = Data(hexString:supplied) else { throw VMFailure.admissionUnavailable }
            var bytes = Data()
            if composition != nil { bytes.append(Data("acceptance:bootstrap-composition:v1\0".utf8)) }
            bytes.append(try canonical(payload))
            let calculated = Data(HMAC<SHA256>.authenticationCode(for:bytes,using:SymmetricKey(data:capability)))
            guard equalMAC(suppliedData,calculated), try string(payload["runId"]) == expectedRunID,
                  try string(payload["manifestIdentity"]) == manifestIdentity,
                  try string(payload["configIdentity"]) == configIdentity,
                  integer(payload["expiresAt"],1) == expiresAt,
                  let sequence = integer(payload["sequence"],1), let observedWall = integer(payload["observedWall"]),
                  let observedMonotonic = integer(payload["observedMonotonic"]) else { throw VMFailure.admissionUnavailable }
            let deviceObject = try object(payload["devices"]); try validateDevices(deviceObject)
            if let expected = composition {
                let value = try object(payload["composition"])
                guard Set(value.keys) == ["binding","probeEpochDigest","fixtureInventoryDigest","eventCheckpoint","proxyRuntimeId","roleRuntime"],
                      try string(value["probeEpochDigest"]) == expected.probeEpochDigest,
                      try string(value["fixtureInventoryDigest"]) == expected.fixtureInventoryDigest,
                      try string(value["proxyRuntimeId"]) == expected.proxyRuntimeID,
                      hex(expected.probeEpochDigest,count:64), hex(expected.fixtureInventoryDigest,count:64),
                      hex(expected.proxyRuntimeID,count:32) else { throw VMFailure.admissionUnavailable }
                let binding = try object(value["binding"])
                guard Set(binding.keys) == ["version","runId","manifestDigest","configIdentity","rolePolicyDigest","epoch","expiresAtMs"],
                      integer(binding["version"]) == 1, try string(binding["runId"]) == expectedRunID,
                      try string(binding["manifestDigest"]) == manifestIdentity,
                      try string(binding["configIdentity"]) == configIdentity,
                      try string(binding["rolePolicyDigest"]) == expected.rolePolicyDigest,
                      integer(binding["epoch"],1) == expected.epoch,
                      integer(binding["expiresAtMs"],1) == expiresAt,
                      hex(expected.rolePolicyDigest,count:64) else { throw VMFailure.admissionUnavailable }
                let checkpoint = try object(value["eventCheckpoint"])
                guard Set(checkpoint.keys) == ["binding","generation","sequence","sourceIdentity","lostCount"],
                      try canonical(checkpoint["binding"]!) == canonical(binding),
                      integer(checkpoint["generation"],1) == expected.generation,
                      integer(checkpoint["sequence"],1) != nil,
                      try string(checkpoint["sourceIdentity"]) == expected.eventSourceID,
                      integer(checkpoint["lostCount"]) == 0, hex(expected.eventSourceID,count:32) else { throw VMFailure.admissionUnavailable }
                try validateRolesV2(payload["roles"]!,runID:expectedRunID,programPins:programPins,
                                    runtime:value["roleRuntime"]!,originals:expected.originalRoleRuntime,
                                    generation:expected.generation)
            } else {
                try validateRoles(payload["roles"],runID:expectedRunID,programPins:programPins)
            }
            try validateProbes(payload["probes"])
            let proxy = try object(payload["proxy"])
            guard Set(proxy.keys) == ["configIdentity","expiresAt","hostCid","listenAddress","listenPort","manifestIdentity","runId","servicePort","uid"],
                  try string(proxy["runId"]) == expectedRunID, try string(proxy["manifestIdentity"]) == manifestIdentity,
                  try string(proxy["configIdentity"]) == configIdentity, integer(proxy["expiresAt"],1) == expiresAt,
                  try string(proxy["listenAddress"]) == "127.0.0.1", integer(proxy["listenPort"],1,65535) == 3128,
                  integer(proxy["hostCid"],1,Int(UInt32.max)) == 2,
                  integer(proxy["servicePort"],1,65535) == 4050, integer(proxy["uid"],1,Int(UInt32.max)) == 10004 else { throw VMFailure.admissionUnavailable }
            var stable = payload; stable.removeValue(forKey:"sequence"); stable.removeValue(forKey:"observedWall"); stable.removeValue(forKey:"observedMonotonic")
            if var value = stable["composition"] as? [String:Any],
               var checkpoint = value["eventCheckpoint"] as? [String:Any] {
                checkpoint.removeValue(forKey:"sequence"); value["eventCheckpoint"] = checkpoint
                stable["composition"] = value
            }
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
    private let executables:BootstrapExecutableAuthority
    private let composition:BootstrapCompositionExpectation?
    private let lock = NSLock()
    private var proof:AdmissionProof, lastClock:ClockSample, failed = false, activated = false
    private var generation = 0, busy:UUID?, lifecycle:(any BootstrapOwnedLifecycle)?
    private var roles:[any BootstrapActivationTransaction] = []
    private var retired=Set<ObjectIdentifier>(), inFlight=Set<ObjectIdentifier>(), stoppedInFlight=Set<ObjectIdentifier>()
    private var pendingRoles=Set<ObjectIdentifier>(), pendingLifecycles = 0
    private let cleanupBudget:BootstrapCleanupBudget
    private var _cleanupUncertain = false
    private var hasUnresolvedCleanup:Bool {
        _cleanupUncertain || !pendingRoles.isEmpty || pendingLifecycles > 0 ||
            (failed && (!inFlight.isEmpty || roles.contains { !retired.contains(ObjectIdentifier($0)) }))
    }
    var cleanupUncertain:Bool { lock.withLock { hasUnresolvedCleanup } }
    private var unresolvedRoles:[any BootstrapActivationTransaction] = []
    private var unresolvedLifecycles:[any BootstrapOwnedLifecycle] = []
    private var unresolvedQualifications:[BootstrapQualification] = []
    fileprivate init(run:RunConfiguration,authority:RunAuthority,clock:any BrokerClock,probe:any BootstrapProbePort,
         executables:BootstrapExecutableAuthority,proof:AdmissionProof,lastClock:ClockSample,
         composition:BootstrapCompositionExpectation? = nil) {
        self.run=run; self.authority=authority; self.clock=clock; self.probe=probe
        self.proof=proof; self.lastClock=lastClock
        self.executables=executables
        self.composition=composition
        cleanupBudget=BootstrapCleanupBudget(clock:clock)
    }
    private func checkedSample() throws -> ClockSample {
        let sample = try clock.sample()
        try lock.withLock {
            guard !failed, sample.wall >= lastClock.wall, sample.monotonic >= lastClock.monotonic else { throw VMFailure.clock }
            lastClock = sample
        }
        _ = try authority.check(sample)
        return sample
    }
    private func reserve(activation:Bool) throws -> (UUID,Int) {
        do { return try lock.withLock {
            guard !failed, busy == nil, !activation || !activated else {
                failed = true; generation += 1; throw VMFailure.terminal
            }
            if activation { activated = true }
            let token = UUID(); busy = token
            return (token,generation)
        } } catch {
            latch()
            if cleanupUncertain { throw BootstrapCleanupFailure(cleanup:self) }
            throw error
        }
    }
    fileprivate func latch() {
        let owned = lock.withLock { () -> ((any BootstrapOwnedLifecycle)?,[any BootstrapActivationTransaction]) in
            failed = true; generation += 1; busy = nil
            let pending=roles.filter { !retired.contains(ObjectIdentifier($0)) && !pendingRoles.contains(ObjectIdentifier($0)) }
            for owner in pending {
                let id=ObjectIdentifier(owner); retired.insert(id)
                pendingRoles.insert(id)
                if inFlight.contains(id) { stoppedInFlight.insert(id) }
            }
            let values = (lifecycle,pending)
            if lifecycle != nil { pendingLifecycles += 1 }
            lifecycle=nil; return values
        }
        var pending=owned.1
        while !pending.isEmpty {
            for owner in pending.reversed() {
                do {
                    if try cleanupBudget.stop({ try owner.stopOwned(deadline:$0) }) != .stopped {
                        lock.withLock { _cleanupUncertain=true; unresolvedRoles.append(owner) }
                    }
                } catch {
                    rememberCleanupFailure(error)
                    lock.withLock { _cleanupUncertain=true; unresolvedRoles.append(owner) }
                }
                _ = lock.withLock { pendingRoles.remove(ObjectIdentifier(owner)) }
            }
            pending = lock.withLock {
                let next=roles.filter { !retired.contains(ObjectIdentifier($0)) && !pendingRoles.contains(ObjectIdentifier($0)) }
                for owner in next {
                    let id=ObjectIdentifier(owner); retired.insert(id); pendingRoles.insert(id)
                    if inFlight.contains(id) { stoppedInFlight.insert(id) }
                }
                return next
            }
        }
        if let owner = owned.0 {
            do {
                if try cleanupBudget.stop({ try owner.stopOwned(deadline:$0) }) != .stopped {
                    lock.withLock { _cleanupUncertain=true; unresolvedLifecycles.append(owner) }
                }
            } catch {
                rememberCleanupFailure(error)
                lock.withLock { _cleanupUncertain=true; unresolvedLifecycles.append(owner) }
            }
            lock.withLock { pendingLifecycles -= 1 }
        }
    }
    fileprivate func rememberCleanupFailure(_ error:Error) {
        guard let error=error as? BootstrapCleanupFailure, error.cleanup !== self else { return }
        lock.withLock {
            _cleanupUncertain=true
            if !unresolvedQualifications.contains(where:{ $0 === error.cleanup }) {
                unresolvedQualifications.append(error.cleanup)
            }
        }
    }
    private func retain(_ owner:any BootstrapActivationTransaction) {
        lock.withLock { if !roles.contains(where:{ $0 === owner }) { roles.append(owner) } }
    }
    private func beginPreparation(_ owner:any BootstrapActivationTransaction,_ token:UUID,_ admittedGeneration:Int) throws {
        try lock.withLock {
            if !roles.contains(where:{ $0 === owner }) { roles.append(owner) }
            guard !failed, busy == token, generation == admittedGeneration else { throw VMFailure.terminal }
            inFlight.insert(ObjectIdentifier(owner))
        }
    }
    private func finishActivation() {
        lock.withLock { finishActivationLocked() }
    }
    private func finishActivationLocked() {
        retired.subtract(stoppedInFlight); stoppedInFlight.removeAll(); inFlight.removeAll()
    }
    private func assertCurrent(_ token:UUID,_ admittedGeneration:Int) throws {
        try lock.withLock {
            guard !failed, busy == token, generation == admittedGeneration else { throw VMFailure.terminal }
        }
    }
    private func resample(token:UUID,generation admittedGeneration:Int) throws -> AdmissionProof {
        let before = try checkedSample(); try run.appliance.recheck(); _ = try checkedSample()
        let data = try probe.capture(ids:BootstrapProbeID.allCases)
        let after = try checkedSample(); try run.appliance.recheck()
        let final = try checkedSample()
        let current = try BootstrapHandoff.verify(data:data,expectedRunID:run.binding.runID,
            manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
            expiresAt:run.binding.expiresAt,capability:run.capability,
            executables:executables,composition:composition)
        guard current.sequence == proof.sequence + 1,
              current.topologyDigest == proof.topologyDigest,
              current.roleInventoryDigest == proof.roleInventoryDigest,
              current.deviceInventoryDigest == proof.deviceInventoryDigest,
              before.wall <= current.observedWall, current.observedWall <= after.wall,
              before.monotonic <= current.observedMonotonic, current.observedMonotonic <= after.monotonic,
              after.wall-current.observedWall <= 1, after.monotonic-current.observedMonotonic <= 1,
              final.wall >= after.wall, final.monotonic >= after.monotonic else { throw VMFailure.admissionUnavailable }
        _ = try checkedSample()
        try lock.withLock {
            guard !failed, busy == token, generation == admittedGeneration else { throw VMFailure.terminal }
            proof=current
        }
        return current
    }
    func currentProofWithoutActivation() throws -> AdmissionProof {
        try lock.withLock {
            if hasUnresolvedCleanup { throw BootstrapCleanupFailure(cleanup:self) }
            guard !failed else { throw VMFailure.terminal }; return proof
        }
    }
    public func requireBrowserAdmission() throws -> AdmissionProof {
        let reservation = try reserve(activation:false)
        do {
            let current = try resample(token:reservation.0,generation:reservation.1)
            try lock.withLock { guard !failed, busy == reservation.0 else { throw VMFailure.terminal }; busy=nil }
            return current
        } catch {
            rememberCleanupFailure(error); latch()
            if cleanupUncertain { throw BootstrapCleanupFailure(cleanup:self) }
            throw (error as? VMFailure) ?? VMFailure.admissionUnavailable
        }
    }
    func activateBrowser(_ activation:any BootstrapActivationPort) throws {
        let reservation = try reserve(activation:true)
        do {
            let current = try resample(token:reservation.0,generation:reservation.1)
            try run.appliance.recheck(); _ = try checkedSample()
            let original=activation.cleanup
            try beginPreparation(original,reservation.0,reservation.1)
            let transaction = try activation.prepareBrowser(proof:current)
            retain(transaction)
            guard transaction === original else { throw VMFailure.terminal }
            try assertCurrent(reservation.0,reservation.1)
            try transaction.activate(authorize:{ [weak self] in
                guard let self else { throw VMFailure.terminal }
                try self.run.appliance.recheck(); _ = try self.checkedSample()
                try self.assertCurrent(reservation.0,reservation.1)
            })
            try run.appliance.recheck(); _ = try checkedSample()
            try lock.withLock {
                guard !failed, busy == reservation.0, generation == reservation.1 else { throw VMFailure.terminal }
                busy=nil
                finishActivationLocked()
            }
        } catch let error as VMFailure {
            finishActivation()
            latch(); if cleanupUncertain { throw BootstrapCleanupFailure(cleanup:self) }; throw error
        } catch {
            rememberCleanupFailure(error)
            finishActivation()
            latch()
            if cleanupUncertain { throw BootstrapCleanupFailure(cleanup:self) }
            throw VMFailure.admissionUnavailable
        }
    }
    fileprivate func installLifecycle(_ handle:any BootstrapOwnedLifecycle) throws {
        let accepted = lock.withLock { () -> Bool in
            guard lifecycle == nil else { return false }
            lifecycle=handle; return !failed
        }
        if !accepted { latch(); throw VMFailure.terminal }
    }
    fileprivate func topologyDrifted() {
        latch()
    }
}

final class BootstrapCompositionV1: BootstrapProbePort, @unchecked Sendable {
    fileprivate let probe:any BootstrapProbePort
    fileprivate let lifecycle:any BootstrapLifecyclePort & BootstrapOwnedLifecycle
    fileprivate let executables:BootstrapExecutableAuthority
    fileprivate let clock:any BrokerClock
    fileprivate let expectation:BootstrapCompositionExpectation
    private let runID:String, manifestIdentity:String, configIdentity:String, expiresAt:Int
    private let capability:Data, channelOwners:[ObjectIdentifier]
    private let eventOwner:UUID, eventOwnerOrdinal=1
    private let lock=NSLock(); private var claimed=false, nextOrdinal=2, firstCaptureOrdinal:Int?

    fileprivate init(run:RunConfiguration,probe:any BootstrapProbePort,
                     lifecycle:any BootstrapLifecyclePort & BootstrapOwnedLifecycle,
                     executables:BootstrapExecutableAuthority,clock:any BrokerClock,
                     expectation:BootstrapCompositionExpectation) {
        self.probe=probe; self.lifecycle=lifecycle; self.executables=executables; self.clock=clock
        self.expectation=expectation; runID=run.binding.runID
        manifestIdentity=run.appliance.manifest.digest; configIdentity=run.binding.configIdentity
        expiresAt=run.binding.expiresAt; capability=run.capability
        channelOwners=(run.channels.broker + run.channels.console).map(ObjectIdentifier.init)
        // This nominal owner exists before the first capture. Native construction
        // will replace this offline identity only after it can retain the actual
        // Linux event descriptors and delivery/effect fences.
        eventOwner=UUID()
    }
    var eventOwnerInstalledBeforeCapture:Bool { lock.withLock {
        !eventOwner.uuidString.isEmpty && (firstCaptureOrdinal == nil || eventOwnerOrdinal < firstCaptureOrdinal!)
    } }
    fileprivate func claimOffline() -> Bool { lock.withLock { if claimed { return false }; claimed=true; return true } }
    func capture(ids:[BootstrapProbeID]) throws -> Data {
        lock.withLock {
            if firstCaptureOrdinal == nil { firstCaptureOrdinal=nextOrdinal }
            nextOrdinal += 1
        }
        return try probe.capture(ids:ids)
    }
    fileprivate func matches(_ run:RunConfiguration) -> Bool {
        run.binding.runID == runID && run.appliance.manifest.digest == manifestIdentity
            && run.binding.configIdentity == configIdentity && run.binding.expiresAt == expiresAt
            && run.capability == capability
            && (run.channels.broker + run.channels.console).map(ObjectIdentifier.init) == channelOwners
    }
}

struct NativeBootstrapComposition: Sendable {
    let manifestPath:String, releasePath:String
    static func select(manifestPath:String,releasePath:String,platform:String,machine:String) throws -> Self {
        guard platform == "darwin", machine == "arm64", !manifestPath.isEmpty, !releasePath.isEmpty,
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
    // Admission from a retained composition is a separate internal boundary.
    // The only constructor in this milestone is explicitly offline and carries
    // no native descriptor, event-delivery, signer, entitlement or effect-fence
    // authority, so the operational host rejects it before asking for evidence.
    static func bootstrapCheck(run:RunConfiguration,composition:BootstrapCompositionV1) throws -> BootstrapQualification {
        guard composition.matches(run) else { throw VMFailure.admissionUnavailable }
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
    static func composeBootstrapV1(run:RunConfiguration,probe:any BootstrapProbePort,
        lifecycle:any BootstrapLifecyclePort & BootstrapOwnedLifecycle,
        executables:BootstrapExecutableAuthority,
        clock:any BrokerClock,originalRoleRuntime:[[String:Any]],rolePolicyDigest:String,
        epoch:Int,generation:Int,probeEpochDigest:String,fixtureInventoryDigest:String,
        eventSourceID:String,proxyRuntimeID:String) throws -> BootstrapCompositionV1 {
        func hex(_ value:String,_ count:Int) -> Bool {
            value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        guard epoch > 0, epoch <= 9007199254740991, generation == 1,
              hex(rolePolicyDigest,64), hex(probeEpochDigest,64), hex(fixtureInventoryDigest,64),
              hex(eventSourceID,32), hex(proxyRuntimeID,32), originalRoleRuntime.count == 4,
              executables.manifestIdentity == nil else { throw VMFailure.admissionUnavailable }
        let runtimeBytes=try JSONSerialization.data(withJSONObject:originalRoleRuntime,
                                                     options:[.sortedKeys,.withoutEscapingSlashes])
        guard runtimeBytes.count <= 65536,
              let retainedRuntime=try JSONSerialization.jsonObject(with:runtimeBytes) as? [[String:Any]]
              else { throw VMFailure.admissionUnavailable }
        try BootstrapHandoff.validateRoleRuntimeV1(retainedRuntime,originals:retainedRuntime,
                                                   generation:generation)
        let expectation=BootstrapCompositionExpectation(rolePolicyDigest:rolePolicyDigest,
            epoch:epoch,generation:generation,probeEpochDigest:probeEpochDigest,
            fixtureInventoryDigest:fixtureInventoryDigest,eventSourceID:eventSourceID,
            proxyRuntimeID:proxyRuntimeID,originalRoleRuntime:retainedRuntime)
        return BootstrapCompositionV1(run:run,probe:probe,lifecycle:lifecycle,
            executables:executables,clock:clock,expectation:expectation)
    }

    static func bootstrapCheck(run:RunConfiguration,composition:BootstrapCompositionV1) throws -> BootstrapQualification {
        guard composition.matches(run), composition.claimOffline() else { throw VMFailure.admissionUnavailable }
        var qualification:BootstrapQualification?
        do {
            let clock=composition.clock, before=try clock.sample()
            let authority=try RunAuthority(run:run,sample:before)
            _=try authority.check(before); try run.appliance.recheck(); try run.appliance.plan.validateResources()
            let handoff=try composition.capture(ids:BootstrapProbeID.allCases)
            let after=try clock.sample(); _=try authority.check(after); try run.appliance.recheck()
            guard after.wall >= before.wall, after.monotonic >= before.monotonic else { throw VMFailure.clock }
            let proof=try BootstrapHandoff.verify(data:handoff,expectedRunID:run.binding.runID,
                manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
                expiresAt:run.binding.expiresAt,capability:run.capability,
                executables:composition.executables,composition:composition.expectation)
            guard proof.sequence == 1, before.wall <= proof.observedWall, proof.observedWall <= after.wall,
                  before.monotonic <= proof.observedMonotonic, proof.observedMonotonic <= after.monotonic,
                  after.wall-proof.observedWall <= 1, after.monotonic-proof.observedMonotonic <= 1 else { throw VMFailure.admissionUnavailable }
            let owner=BootstrapQualification(run:run,authority:authority,clock:clock,
                probe:composition,executables:composition.executables,proof:proof,
                lastClock:after,composition:composition.expectation)
            qualification=owner
            let lifecycleHandle=try composition.lifecycle.begin(handoff:handoff,onDrift:{ owner.topologyDrifted() })
            try owner.installLifecycle(lifecycleHandle)
            let final=try clock.sample(); _=try authority.check(final); try run.appliance.recheck()
            let postRecheck=try clock.sample(); _=try authority.check(postRecheck)
            guard final.wall >= after.wall, final.monotonic >= after.monotonic,
                  postRecheck.wall >= final.wall, postRecheck.monotonic >= final.monotonic else { throw VMFailure.clock }
            _=try owner.currentProofWithoutActivation(); return owner
        } catch let error as VMFailure {
            qualification?.latch()
            if let qualification, qualification.cleanupUncertain { throw BootstrapCleanupFailure(cleanup:qualification) }
            if error == .terminal { throw error }
            throw VMFailure.admissionUnavailable
        } catch {
            if let error=error as? BootstrapCleanupFailure, let qualification {
                qualification.rememberCleanupFailure(error)
            }
            qualification?.latch()
            if let qualification, qualification.cleanupUncertain { throw BootstrapCleanupFailure(cleanup:qualification) }
            throw VMFailure.admissionUnavailable
        }
    }

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
    static func bootstrapCheck(run:RunConfiguration,probe:any BootstrapProbePort,lifecycle:any BootstrapLifecyclePort,executables:BootstrapExecutableAuthority,clock:any BrokerClock) throws -> BootstrapQualification {
        var qualification:BootstrapQualification?
        do {
            // This internal model exercises lifecycle with literal wire vectors.
            // No inspector/native provenance is implied or available.
            guard executables.manifestIdentity == nil else { throw VMFailure.admissionUnavailable }
            let before = try clock.sample(), authority = try RunAuthority(run:run,sample:before)
            _ = try authority.check(before)
            try run.appliance.recheck(); try run.appliance.plan.validateResources()
            let ids = BootstrapProbeID.allCases
            let handoff = try probe.capture(ids:ids)
            let after = try clock.sample(); _ = try authority.check(after); try run.appliance.recheck()
            guard after.wall >= before.wall, after.monotonic >= before.monotonic else { throw VMFailure.clock }
            let proof = try BootstrapHandoff.verify(data:handoff,expectedRunID:run.binding.runID,
                manifestIdentity:run.appliance.manifest.digest,configIdentity:run.binding.configIdentity,
                expiresAt:run.binding.expiresAt,capability:run.capability,
                executables:executables)
            guard proof.sequence == 1, before.wall <= proof.observedWall, proof.observedWall <= after.wall,
                  before.monotonic <= proof.observedMonotonic, proof.observedMonotonic <= after.monotonic,
                  after.wall-proof.observedWall <= 1, after.monotonic-proof.observedMonotonic <= 1 else { throw VMFailure.admissionUnavailable }
            let owner = BootstrapQualification(run:run,authority:authority,clock:clock,
                probe:probe,executables:executables,proof:proof,lastClock:after)
            qualification=owner
            let lifecycleHandle = try lifecycle.begin(handoff:handoff,onDrift:{ owner.topologyDrifted() })
            try owner.installLifecycle(lifecycleHandle)
            let final = try clock.sample(); _ = try authority.check(final); try run.appliance.recheck()
            let postRecheck = try clock.sample(); _ = try authority.check(postRecheck)
            guard final.wall >= after.wall, final.monotonic >= after.monotonic,
                  postRecheck.wall >= final.wall, postRecheck.monotonic >= final.monotonic else { throw VMFailure.clock }
            _ = try owner.currentProofWithoutActivation()
            return owner
        } catch let error as VMFailure {
            qualification?.latch()
            if let qualification, qualification.cleanupUncertain { throw BootstrapCleanupFailure(cleanup:qualification) }
            if error == .terminal { throw error }
            throw VMFailure.admissionUnavailable
        } catch {
            if let error=error as? BootstrapCleanupFailure {
                guard let qualification else { throw error }
                qualification.rememberCleanupFailure(error)
            }
            qualification?.latch()
            if let qualification, qualification.cleanupUncertain { throw BootstrapCleanupFailure(cleanup:qualification) }
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
