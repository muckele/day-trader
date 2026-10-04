import Darwin
import Dispatch
import Foundation

public enum ConsoleFailure: String, Error, Sendable {
    case invalidGrant, nonTTY, expired, consumed, cancelled, terminal, sink, invalidFrame, descriptor, clock
}
public protocol ConsoleClock: Sendable { func nowMilliseconds() throws -> Int }
public protocol ConsoleReceiptSource: Sendable { func receive(maxBytes:Int) throws -> Data }
public protocol ConsolePublicSink: Sendable { func publish(_ value:Data) throws }
public enum ConsolePhase: String, Sendable {
    case preflight="PREFLIGHT", awaitCredential="AWAIT_CREDENTIAL", authenticating="AUTHENTICATING"
    case observeBeforeRestart="OBSERVE_BEFORE_RESTART", holdForRestart="HOLD_FOR_RESTART"
    case observeAfterRestart="OBSERVE_AFTER_RESTART", logout="LOGOUT", verifyRevocation="VERIFY_REVOCATION"
    case finalize="FINALIZE", done="DONE", failed="FAILED"
}
public enum ConsoleOperation: Sendable { case credential, receipt(FrameKind), publicRecord }
public struct ConsolePermit: Sendable {
    public let runID:String, sequence:Int, expiresAt:Int
    public init(runID:String,sequence:Int,expiresAt:Int) { self.runID=runID; self.sequence=sequence; self.expiresAt=expiresAt }
}
public protocol ConsolePhaseAuthority: Sendable {
    func permit(_ operation:ConsoleOperation,runID:String,now:Int) throws -> ConsolePermit
}
public struct ConsumeResult: Sendable, Equatable { public let runID:String, byteLength:Int }

public struct ConsolePrivateEndpoint: Sendable, Equatable {
    public let runID:String, capability:Data, configIdentity:String
    public let origins:[Destination:String], consumer:String, destinations:Set<Destination>
    public let childID:String, childUID:UInt32, device:UInt64, inode:UInt64
}

public final class ConsolePrivatePipeSink: @unchecked Sendable {
    public let endpoint:ConsolePrivateEndpoint
    public var childUID:UInt32 { endpoint.childUID }; public var device:UInt64 { endpoint.device }; public var inode:UInt64 { endpoint.inode }
    private let fd:Int32
    private init(fd:Int32,endpoint:ConsolePrivateEndpoint) { self.fd=fd; self.endpoint=endpoint }
    public static func issue(fd:Int32,binding:RunBinding,consumer:String,destinations:Set<Destination>,childID:String,childUID:UInt32) throws -> ConsolePrivatePipeSink {
        var facts=stat(); let flags=fcntl(fd,F_GETFL)
        guard fd >= 0, consumer == "BROWSER", destinations == [.frontend,.backend], destinations == Set(binding.origins.keys),
              childID.count == 32, childID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              fstat(fd,&facts) == 0, (facts.st_mode & S_IFMT) == S_IFIFO, isatty(fd) == 0,
              flags >= 0, flags & O_ACCMODE == O_WRONLY, fcntl(fd,F_SETNOSIGPIPE,1) == 0,
              fcntl(fd,F_SETFL,flags | O_NONBLOCK) == 0 else { throw ConsoleFailure.descriptor }
        return ConsolePrivatePipeSink(fd:fd,endpoint:ConsolePrivateEndpoint(runID:binding.runID,
            capability:binding.capability,configIdentity:binding.configIdentity,origins:binding.origins,
            consumer:consumer,destinations:destinations,childID:childID,childUID:childUID,
            device:UInt64(facts.st_dev),inode:UInt64(facts.st_ino)))
    }
    fileprivate func matches(_ binding:RunBinding) -> Bool {
        var facts=stat(); let flags=fcntl(fd,F_GETFL)
        return endpoint.runID == binding.runID && endpoint.capability == binding.capability
            && endpoint.configIdentity == binding.configIdentity && endpoint.origins == binding.origins
            && fstat(fd,&facts) == 0 && UInt64(facts.st_dev) == endpoint.device && UInt64(facts.st_ino) == endpoint.inode
            && (facts.st_mode & S_IFMT) == S_IFIFO && isatty(fd) == 0 && flags >= 0
            && flags & O_ACCMODE == O_WRONLY && flags & O_NONBLOCK == O_NONBLOCK
    }
    fileprivate func consumePrivate(_ value:Data) throws {
        guard !value.isEmpty, value.count <= 4096 else { throw ConsoleFailure.sink }
        var length=UInt32(value.count).bigEndian
        var frame=withUnsafeBytes(of:&length) { Data($0) }; frame.append(value); defer { frame.resetBytes(in:0..<frame.count) }
        var offset=0
        while offset < frame.count {
            let count=frame.withUnsafeBytes { Darwin.write(fd,$0.baseAddress!.advanced(by:offset),frame.count-offset) }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { throw ConsoleFailure.sink }
            guard count > 0 else { throw ConsoleFailure.sink }; offset += count
        }
    }
}

public final class IntakeGrant: @unchecked Sendable {
    public let runID:String, consumer:String, destinations:Set<Destination>, issuedAt:Int, expiresAt:Int
    private let lock=NSLock(); private var consumed=false
    private let capability:Data, configIdentity:String, origins:[Destination:String], manifestIdentity:String
    private let roleDigest:String, deviceDigest:String, topologyDigest:String, proofSequence:Int
    private let endpoint:ConsolePrivateEndpoint
    private init(proof:AdmissionProof,binding:RunBinding,consumer:String,destinations:Set<Destination>,issuedAt:Int,expiresAt:Int,endpoint:ConsolePrivateEndpoint) {
        runID=binding.runID; self.consumer=consumer; self.destinations=destinations; self.issuedAt=issuedAt; self.expiresAt=expiresAt
        capability=binding.capability; configIdentity=binding.configIdentity; origins=binding.origins; manifestIdentity=proof.manifestIdentity
        roleDigest=proof.roleInventoryDigest; deviceDigest=proof.deviceInventoryDigest; topologyDigest=proof.topologyDigest
        proofSequence=proof.sequence; self.endpoint=endpoint
    }
    public static func issue(proof:AdmissionProof,binding:RunBinding,runID:String,consumer:String,destinations:Set<Destination>,issuedAt:Int,expiresAt:Int,now:Int,sink:ConsolePrivatePipeSink) throws -> IntakeGrant {
        guard runID == binding.runID, proof.runID == binding.runID, proof.manifestIdentity == binding.manifest.identity,
              sink.matches(binding), sink.endpoint.runID == runID, sink.endpoint.consumer == consumer,
              sink.endpoint.destinations == destinations, consumer == "BROWSER", destinations == Set(binding.origins.keys),
              destinations == [.frontend,.backend], issuedAt <= now, now < expiresAt,
              expiresAt <= issuedAt + 120_000, expiresAt <= binding.expiresAt, expiresAt <= proof.expiresAt else {
            if expiresAt <= now || expiresAt > issuedAt + 120_000 || expiresAt > binding.expiresAt || expiresAt > proof.expiresAt { throw ConsoleFailure.expired }
            throw ConsoleFailure.invalidGrant
        }
        return IntakeGrant(proof:proof,binding:binding,consumer:consumer,destinations:destinations,issuedAt:issuedAt,expiresAt:expiresAt,endpoint:sink.endpoint)
    }
    fileprivate func claim(proof:AdmissionProof,binding:RunBinding,sink:ConsolePrivatePipeSink,now:Int) throws {
        guard runID == binding.runID, proof.runID == runID, manifestIdentity == binding.manifest.identity,
              capability == binding.capability, configIdentity == binding.configIdentity, origins == binding.origins,
              endpoint == sink.endpoint, sink.matches(binding), proof.manifestIdentity == manifestIdentity,
              proof.roleInventoryDigest == roleDigest, proof.deviceInventoryDigest == deviceDigest,
              proof.topologyDigest == topologyDigest, proof.sequence == proofSequence,
              consumer == "BROWSER", destinations == Set(binding.origins.keys), destinations == [.frontend,.backend] else { throw ConsoleFailure.invalidGrant }
        guard now >= issuedAt, now < expiresAt, now < binding.expiresAt, now < proof.expiresAt else { throw ConsoleFailure.expired }
        try lock.withLock { guard !consumed else { throw ConsoleFailure.consumed }; consumed=true }
    }
}

private final class ConsoleSignalLatch: @unchecked Sendable {
    private let lock=NSLock(); private var value=false
    func cancel() { lock.withLock { value=true } }; func check() throws { if lock.withLock({value}) { throw ConsoleFailure.cancelled } }
}
private final class ConsoleSignalScope {
    private let previousInterrupt:sig_t?, previousTerminate:sig_t?
    private let interrupt:DispatchSourceSignal, terminate:DispatchSourceSignal
    init(_ latch:ConsoleSignalLatch) {
        previousInterrupt=Darwin.signal(SIGINT,SIG_IGN); previousTerminate=Darwin.signal(SIGTERM,SIG_IGN)
        interrupt=DispatchSource.makeSignalSource(signal:SIGINT,queue:.global()); terminate=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.global())
        interrupt.setEventHandler { latch.cancel() }; terminate.setEventHandler { latch.cancel() }; interrupt.resume(); terminate.resume()
    }
    func restore() { interrupt.cancel(); terminate.cancel(); _=Darwin.signal(SIGINT,previousInterrupt); _=Darwin.signal(SIGTERM,previousTerminate) }
}

public final class SerialConsole: @unchecked Sendable {
    private let binding:RunBinding, proof:AdmissionProof, ttyFD:Int32, sink:ConsolePrivatePipeSink
    private let authorization:any ConsolePhaseAuthority, receiptSource:any ConsoleReceiptSource
    private let publicSink:any ConsolePublicSink, clock:any ConsoleClock, publicBudget=PublicRunBudget()
    private let stateLock=NSLock(); private var failed=false, active=false, credentialConsumed=false
    public init(binding:RunBinding,proof:AdmissionProof,ttyFD:Int32,sink:ConsolePrivatePipeSink,
                authorization:any ConsolePhaseAuthority,receiptSource:any ConsoleReceiptSource,
                publicSink:any ConsolePublicSink,clock:any ConsoleClock,
                brokerFacts:[DescriptorFacts],automationFacts:[DescriptorFacts]) throws {
        guard proof.runID == binding.runID, proof.manifestIdentity == binding.manifest.identity, sink.matches(binding) else { throw ConsoleFailure.invalidGrant }
        guard ttyFD >= 0, isatty(ttyFD) == 1 else { throw ConsoleFailure.nonTTY }
        let e=sink.endpoint, matches=automationFacts.filter { $0.kind == .pipe && !$0.tty && $0.direction == O_RDONLY && $0.uid == e.childUID && $0.device == e.device && $0.inode == e.inode }
        guard !brokerFacts.isEmpty, !automationFacts.isEmpty, brokerFacts.allSatisfy({ !$0.tty && !($0.device == e.device && $0.inode == e.inode) }),
              automationFacts.allSatisfy({ !$0.tty }), matches.count == 1 else { throw ConsoleFailure.descriptor }
        self.binding=binding; self.proof=proof; self.ttyFD=ttyFD; self.sink=sink; self.authorization=authorization
        self.receiptSource=receiptSource; self.publicSink=publicSink; self.clock=clock
    }
    private func begin(credential:Bool=false) throws { try stateLock.withLock { guard !failed, !active else { throw ConsoleFailure.terminal }; if credential && credentialConsumed { throw ConsoleFailure.consumed }; active=true } }
    private func finish(success:Bool,credential:Bool=false) { stateLock.withLock { active=false; if success && credential { credentialConsumed=true }; if !success { failed=true } } }
    private func permit(_ operation:ConsoleOperation,now:Int) throws -> ConsolePermit {
        let p=try authorization.permit(operation,runID:binding.runID,now:now)
        guard p.runID == binding.runID, p.sequence >= binding.firstSequence, now < p.expiresAt,
              p.expiresAt <= binding.expiresAt, p.expiresAt <= proof.expiresAt else { throw ConsoleFailure.expired }; return p
    }
    public func consume(grant:IntakeGrant) async throws -> ConsumeResult {
        try begin(credential:true); var succeeded=false; defer { finish(success:succeeded,credential:succeeded) }
        let now:Int; do { now=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
        let permission=try permit(.credential,now:now); try grant.claim(proof:proof,binding:binding,sink:sink,now:now)
        guard isatty(ttyFD) == 1 else { throw ConsoleFailure.nonTTY }
        var original=termios(); guard tcgetattr(ttyFD,&original) == 0 else { throw ConsoleFailure.terminal }
        let latch=ConsoleSignalLatch(), signals=ConsoleSignalScope(latch)
        var muted=original; muted.c_lflag &= ~tcflag_t(ECHO | ECHONL)
        guard tcsetattr(ttyFD,TCSANOW,&muted) == 0 else { signals.restore(); throw ConsoleFailure.terminal }
        let flags=fcntl(ttyFD,F_GETFL)
        guard flags >= 0, fcntl(ttyFD,F_SETFL,flags | O_NONBLOCK) == 0 else { var restore=original; _=tcsetattr(ttyFD,TCSANOW,&restore); signals.restore(); throw ConsoleFailure.terminal }
        let effectiveExpiry=min(grant.expiresAt,permission.expiresAt)
        let end=DispatchTime.now().uptimeNanoseconds + UInt64(max(0,min(120_000,effectiveExpiry-now))) * 1_000_000
        var value=Data(); defer { value.resetBytes(in:0..<value.count) }; var pending:(any Error)?
        do {
            while true {
                try Task.checkCancellation(); try latch.check()
                let sampled:Int; do { sampled=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
                guard sampled >= now, sampled < effectiveExpiry, DispatchTime.now().uptimeNanoseconds < end else { throw ConsoleFailure.expired }
                var descriptor=pollfd(fd:ttyFD,events:Int16(POLLIN),revents:0); let polled=Darwin.poll(&descriptor,1,10)
                if polled < 0 { if errno == EINTR { continue }; throw ConsoleFailure.terminal }; if polled == 0 { continue }
                guard descriptor.revents & Int16(POLLNVAL | POLLERR) == 0 else { throw ConsoleFailure.terminal }
                var byte:UInt8=0; let count=withUnsafeMutableBytes(of:&byte) { Darwin.read(ttyFD,$0.baseAddress,1) }
                if count < 0 { if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { continue }; throw ConsoleFailure.terminal }
                guard count == 1 else { throw ConsoleFailure.terminal }; if byte == 10 { break }; value.append(byte)
                guard value.count <= 4096 else { throw ConsoleFailure.invalidGrant }
            }
            if value.last == 13 { value.removeLast() }
            guard !value.isEmpty, String(data:value,encoding:.utf8) != nil, !value.contains(0), !value.contains(10), !value.contains(13) else { throw ConsoleFailure.invalidGrant }
            let finalNow:Int; do { finalNow=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
            guard finalNow >= now, finalNow < effectiveExpiry, DispatchTime.now().uptimeNanoseconds < end else { throw ConsoleFailure.expired }
            try sink.consumePrivate(value)
        } catch is CancellationError { pending=ConsoleFailure.cancelled } catch let failure as ConsoleFailure { pending=failure } catch { pending=ConsoleFailure.terminal }
        signals.restore(); let flagsRestored=fcntl(ttyFD,F_SETFL,flags) == 0; var restore=original; let terminalRestored=tcsetattr(ttyFD,TCSANOW,&restore) == 0
        guard flagsRestored, terminalRestored else { throw ConsoleFailure.terminal }; if let pending { throw pending }
        succeeded=true; return ConsumeResult(runID:binding.runID,byteLength:value.count)
    }
    public func receiveReceipt(kind:FrameKind) throws -> Data {
        try begin(); var succeeded=false; defer { finish(success:succeeded) }
        guard [.releaseReceipt,.restartReceipt,.ledgerReceipt,.maintenanceReceipt,.dbReceipt].contains(kind) else { throw ConsoleFailure.invalidFrame }
        let now:Int; do { now=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }; let permission=try permit(.receipt(kind),now:now)
        let data:Data; do { data=try receiptSource.receive(maxBytes:16_384) } catch { throw ConsoleFailure.invalidFrame }
        let finalNow:Int; do { finalNow=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
        guard finalNow >= now, finalNow < permission.expiresAt, finalNow < binding.expiresAt,
              finalNow < proof.expiresAt else { throw ConsoleFailure.expired }
        guard data.count <= 16_384, !data.contains(0x1b), !data.contains(0x07), let frame=try? Contracts.decode(data,kind:kind),
              frame.value["runId"] as? String == binding.runID, (frame.value["sequence"] as? NSNumber)?.intValue == permission.sequence else { throw ConsoleFailure.invalidFrame }
        succeeded=true; return data
    }
    public func publish(record:ValidatedFrame) throws {
        try begin(); var succeeded=false; defer { finish(success:succeeded) }; guard record.kind == .publicRecord else { throw ConsoleFailure.invalidFrame }
        let now:Int; do { now=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }; let permission=try permit(.publicRecord,now:now)
        guard record.value["runId"] as? String == binding.runID, (record.value["sequence"] as? NSNumber)?.intValue == permission.sequence else { throw ConsoleFailure.invalidFrame }
        let data:Data; do { try publicBudget.append(record); data=try Contracts.canonicalBytes(record) } catch { throw ConsoleFailure.invalidFrame }
        guard data.count <= 4096, !data.contains(0x1b), !data.contains(0x07), data.allSatisfy({ $0 >= 0x20 && $0 != 0x7f }) else { throw ConsoleFailure.invalidFrame }
        var length=UInt32(data.count).bigEndian; var frame=withUnsafeBytes(of:&length) { Data($0) }; frame.append(data)
        do { try publicSink.publish(frame) } catch { throw ConsoleFailure.terminal }; succeeded=true
    }
}
