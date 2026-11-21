import Darwin
import Dispatch
import Foundation

public enum ConsoleFailure: String, Error, Sendable {
    case invalidGrant, nonTTY, expired, consumed, cancelled, terminal, sink, invalidFrame, descriptor, clock, credentialInvalid
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
// T11-M7, P26: the result names the run only; the credential length stays private.
public struct ConsumeResult: Sendable, Equatable { public let runID:String }

// C8 (E6): the one host-to-guest credential frame, a UInt32 big-endian length n with
// 1 <= n <= 4096, then exactly n bytes. guest/intake.py reads the same frame in raw mode.
public enum CredentialFrame {
    public static let limit=4096
    public static func encode(_ secret:Data) throws -> Data {
        guard secret.count >= 1, secret.count <= limit else { throw ConsoleFailure.credentialInvalid }
        let length=UInt32(secret.count)
        var frame=Data(capacity:4+secret.count)
        frame.append(contentsOf:[UInt8(truncatingIfNeeded:length >> 24),UInt8(truncatingIfNeeded:length >> 16),
                                 UInt8(truncatingIfNeeded:length >> 8),UInt8(truncatingIfNeeded:length)])
        frame.append(secret)
        return frame
    }
    // T11-M3: a bounded UTF-8 check that makes no String copy; NUL is rejected, as on the guest.
    static func validCredential(_ bytes:UnsafeRawBufferPointer) -> Bool {
        var index=0
        while index < bytes.count {
            let lead=bytes[index]
            if lead == 0 { return false }
            if lead < 0x80 { index += 1; continue }
            let tail:Int, low:UInt8, high:UInt8
            switch lead {
            case 0xc2...0xdf: (tail,low,high)=(1,0x80,0xbf)
            case 0xe0: (tail,low,high)=(2,0xa0,0xbf)
            case 0xed: (tail,low,high)=(2,0x80,0x9f)
            case 0xe1...0xef: (tail,low,high)=(2,0x80,0xbf)
            case 0xf0: (tail,low,high)=(3,0x90,0xbf)
            case 0xf1...0xf3: (tail,low,high)=(3,0x80,0xbf)
            case 0xf4: (tail,low,high)=(3,0x80,0x8f)
            default: return false
            }
            guard index + tail < bytes.count, (low...high).contains(bytes[index+1]) else { return false }
            var position=index+2
            while position <= index+tail { guard (0x80...0xbf).contains(bytes[position]) else { return false }; position += 1 }
            index += tail + 1
        }
        return true
    }
}

struct ConsoleSerialEndpoint: Sendable, Equatable { let runID:String, device:UInt64, inode:UInt64 }

// C8 (E6), P26: the host's credential sink is the serial input itself, the write end of the pipe
// whose read end the VM serial attachment owns. It carries no guest-role field: the consumer, the
// child and its UID exist only inside the guest (guest/intake.py PrivatePipeSink).
public final class ConsoleSerialInput: @unchecked Sendable {
    public let runID:String, device:UInt64, inode:UInt64
    private let fd:Int32
    public init(fd:Int32,runID:String) throws {
        var facts=stat()
        guard fd >= 0, runID.utf8.count == 32, runID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              fstat(fd,&facts) == 0, (facts.st_mode & S_IFMT) == S_IFIFO, isatty(fd) == 0 else { throw ConsoleFailure.descriptor }
        // Only a write-only, non-TTY pipe end is ever changed; a refused descriptor is left untouched.
        let flags=fcntl(fd,F_GETFL)
        guard flags >= 0, flags & O_ACCMODE == O_WRONLY, fcntl(fd,F_SETNOSIGPIPE,1) == 0,
              fcntl(fd,F_SETFL,flags | O_NONBLOCK) == 0 else { throw ConsoleFailure.descriptor }
        self.fd=fd; self.runID=runID
        device=UInt64(UInt32(bitPattern:facts.st_dev)); inode=UInt64(facts.st_ino)
    }
    var endpoint:ConsoleSerialEndpoint { ConsoleSerialEndpoint(runID:runID,device:device,inode:inode) }
    fileprivate func matches(_ binding:RunBinding) -> Bool {
        var facts=stat(); let flags=fcntl(fd,F_GETFL)
        return runID == binding.runID && fstat(fd,&facts) == 0
            && UInt64(UInt32(bitPattern:facts.st_dev)) == device && UInt64(facts.st_ino) == inode
            && (facts.st_mode & S_IFMT) == S_IFIFO && isatty(fd) == 0 && flags >= 0
            && flags & O_ACCMODE == O_WRONLY && flags & O_NONBLOCK == O_NONBLOCK
    }
    // The whole frame, before END (host monotonic) and unless cancelled; it exceeds PIPE_BUF, so a
    // partial write waits for room instead of failing at the first EAGAIN (T11-M8).
    fileprivate func write(_ frame:Data,until end:UInt64,latch:ConsoleSignalLatch) throws {
        var offset=0
        while offset < frame.count {
            try latch.check()
            guard DispatchTime.now().uptimeNanoseconds < end else { throw ConsoleFailure.sink }
            var descriptor=pollfd(fd:fd,events:Int16(POLLOUT),revents:0); let polled=Darwin.poll(&descriptor,1,10)
            if polled < 0 { if errno == EINTR { continue }; throw ConsoleFailure.sink }; if polled == 0 { continue }
            guard descriptor.revents & Int16(POLLNVAL | POLLERR | POLLHUP) == 0 else { throw ConsoleFailure.sink }
            let count=frame.withUnsafeBytes { Darwin.write(fd,$0.baseAddress!.advanced(by:offset),frame.count-offset) }
            if count < 0 { if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }; throw ConsoleFailure.sink }
            guard count > 0 else { throw ConsoleFailure.sink }; offset += count
        }
    }
}

public final class IntakeGrant: @unchecked Sendable {
    public let runID:String, consumer:String, destinations:Set<Destination>, issuedAt:Int, expiresAt:Int
    private let lock=NSLock(); private var consumed=false
    private let capability:Data, configIdentity:String, origins:[Destination:String], manifestIdentity:String
    private let roleDigest:String, deviceDigest:String, topologyDigest:String, proofSequence:Int
    private let endpoint:ConsoleSerialEndpoint
    private init(proof:AdmissionProof,binding:RunBinding,consumer:String,destinations:Set<Destination>,issuedAt:Int,expiresAt:Int,endpoint:ConsoleSerialEndpoint) {
        runID=binding.runID; self.consumer=consumer; self.destinations=destinations; self.issuedAt=issuedAt; self.expiresAt=expiresAt
        capability=binding.capability; configIdentity=binding.configIdentity; origins=binding.origins; manifestIdentity=proof.manifestIdentity
        roleDigest=proof.roleInventoryDigest; deviceDigest=proof.deviceInventoryDigest; topologyDigest=proof.topologyDigest
        proofSequence=proof.sequence; self.endpoint=endpoint
    }
    public static func issue(proof:AdmissionProof,binding:RunBinding,runID:String,consumer:String,destinations:Set<Destination>,issuedAt:Int,expiresAt:Int,now:Int,sink:ConsoleSerialInput) throws -> IntakeGrant {
        guard runID == binding.runID, proof.runID == binding.runID, proof.manifestIdentity == binding.manifest.identity,
              sink.matches(binding), sink.runID == runID, consumer == "BROWSER", destinations == Set(binding.origins.keys),
              destinations == [.frontend,.backend], issuedAt <= now, now < expiresAt,
              expiresAt <= issuedAt + 120_000, expiresAt <= binding.expiresAt, expiresAt <= proof.expiresAt else {
            if expiresAt <= now || expiresAt > issuedAt + 120_000 || expiresAt > binding.expiresAt || expiresAt > proof.expiresAt { throw ConsoleFailure.expired }
            throw ConsoleFailure.invalidGrant
        }
        return IntakeGrant(proof:proof,binding:binding,consumer:consumer,destinations:destinations,issuedAt:issuedAt,expiresAt:expiresAt,endpoint:sink.endpoint)
    }
    fileprivate func claim(proof:AdmissionProof,binding:RunBinding,sink:ConsoleSerialInput,now:Int) throws {
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
// T11-M4: the same five signals as the guest intake. Each is ignored at the process level and
// latched while the scope is open; the previous dispositions come back last, after the terminal.
private final class ConsoleSignalScope {
    private static let numbers:[Int32]=[SIGINT,SIGTERM,SIGHUP,SIGQUIT,SIGTSTP]
    private let previous:[sig_t?], sources:[DispatchSourceSignal]
    init(_ latch:ConsoleSignalLatch) {
        previous=Self.numbers.map { Darwin.signal($0,SIG_IGN) }
        sources=Self.numbers.map { DispatchSource.makeSignalSource(signal:$0,queue:.global()) }
        for source in sources { source.setEventHandler { latch.cancel() }; source.resume() }
    }
    func restore() { sources.forEach { $0.cancel() }; for (number,handler) in zip(Self.numbers,previous) { _=Darwin.signal(number,handler) } }
}

public final class SerialConsole: @unchecked Sendable {
    private let binding:RunBinding, proof:AdmissionProof, ttyFD:Int32, sink:ConsoleSerialInput
    private let authorization:any ConsolePhaseAuthority, receiptSource:any ConsoleReceiptSource
    private let publicSink:any ConsolePublicSink, clock:any ConsoleClock, publicBudget=PublicRunBudget()
    private let stateLock=NSLock(); private var failed=false, active=false, credentialConsumed=false
    // brokerFacts and automationFacts are caller-supplied; nothing here inventories a real process.
    // Neither the broker nor the automation child may hold a TTY or the serial input's write end (P26).
    // A holder of the read end is NOT caught: on Darwin each pipe end has its own st_ino, so fstat facts
    // cannot link it to the write end. proc_pidfdinfo PROC_PIDFDPIPEINFO (pipe_peerhandle) can; that
    // host-side peer check is carried to Stage 2 (fix round 1, I2).
    public init(binding:RunBinding,proof:AdmissionProof,ttyFD:Int32,sink:ConsoleSerialInput,
                authorization:any ConsolePhaseAuthority,receiptSource:any ConsoleReceiptSource,
                publicSink:any ConsolePublicSink,clock:any ConsoleClock,
                brokerFacts:[DescriptorFacts],automationFacts:[DescriptorFacts]) throws {
        guard proof.runID == binding.runID, proof.manifestIdentity == binding.manifest.identity, sink.matches(binding) else { throw ConsoleFailure.invalidGrant }
        guard ttyFD >= 0, isatty(ttyFD) == 1 else { throw ConsoleFailure.nonTTY }
        let e=sink.endpoint
        let namesSerialInput:(DescriptorFacts) -> Bool = { $0.device == e.device && $0.inode == e.inode }
        guard !brokerFacts.isEmpty, !automationFacts.isEmpty,
              brokerFacts.allSatisfy({ !$0.tty && !namesSerialInput($0) }),
              automationFacts.allSatisfy({ !$0.tty && !namesSerialInput($0) }) else { throw ConsoleFailure.descriptor }
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
    // Reads one operator line and writes it to the serial input as one C8 frame. The host line is
    // canonical, so it is bounded by Darwin's MAX_INPUT (1024 bytes): a longer line never completes
    // and the consume expires; it is never truncated (T11-M2).
    public func consume(grant:IntakeGrant) async throws -> ConsumeResult {
        try begin(credential:true); var succeeded=false; defer { finish(success:succeeded,credential:succeeded) }
        let now:Int; do { now=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
        let permission=try permit(.credential,now:now); try grant.claim(proof:proof,binding:binding,sink:sink,now:now)
        guard isatty(ttyFD) == 1 else { throw ConsoleFailure.nonTTY }
        var original=termios(); guard tcgetattr(ttyFD,&original) == 0 else { throw ConsoleFailure.terminal }
        let flags=fcntl(ttyFD,F_GETFL); guard flags >= 0 else { throw ConsoleFailure.terminal }
        let latch=ConsoleSignalLatch(), signals=ConsoleSignalScope(latch)
        // T11-M1: c_lflag set explicitly, ICANON on with ISIG, IEXTEN, ECHO and ECHONL off, applied
        // with TCSAFLUSH so typeahead is discarded.
        var line=original
        line.c_lflag |= tcflag_t(ICANON)
        line.c_lflag &= ~tcflag_t(ECHO | ECHONL | ISIG | IEXTEN)
        guard tcsetattr(ttyFD,TCSAFLUSH,&line) == 0 else { var restore=original; _=tcsetattr(ttyFD,TCSANOW,&restore); signals.restore(); throw ConsoleFailure.terminal }
        guard fcntl(ttyFD,F_SETFL,flags | O_NONBLOCK) == 0 else { var restore=original; _=tcsetattr(ttyFD,TCSANOW,&restore); signals.restore(); throw ConsoleFailure.terminal }
        let effectiveExpiry=min(grant.expiresAt,permission.expiresAt)
        let end=DispatchTime.now().uptimeNanoseconds + UInt64(max(0,min(120_000,effectiveExpiry-now))) * 1_000_000
        // T11-M3: one preallocated buffer (the limit plus the line end) and the frame, both zeroed on
        // every path; no String copy. No erasure guarantee: the TTY layer keeps its own copies.
        var value=Data(count:CredentialFrame.limit+1), count=0, frame=Data()
        defer { value.resetBytes(in:0..<value.count); frame.resetBytes(in:0..<frame.count) }
        var pending:(any Error)?
        do {
            while true {
                try Task.checkCancellation(); try latch.check()
                let sampled:Int; do { sampled=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
                guard sampled >= now, sampled < effectiveExpiry, DispatchTime.now().uptimeNanoseconds < end else { throw ConsoleFailure.expired }
                var descriptor=pollfd(fd:ttyFD,events:Int16(POLLIN),revents:0); let polled=Darwin.poll(&descriptor,1,10)
                if polled < 0 { if errno == EINTR { continue }; throw ConsoleFailure.terminal }; if polled == 0 { continue }
                guard descriptor.revents & Int16(POLLNVAL | POLLERR) == 0 else { throw ConsoleFailure.terminal }
                guard count < value.count else { throw ConsoleFailure.credentialInvalid }
                let got=value.withUnsafeMutableBytes { Darwin.read(ttyFD,$0.baseAddress!.advanced(by:count),1) }
                if got < 0 { if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { continue }; throw ConsoleFailure.terminal }
                guard got == 1 else { throw ConsoleFailure.terminal }
                if value[count] == 10 { value[count]=0; break }     // the trailing newline is never framed
                count += 1
                guard count <= CredentialFrame.limit else { throw ConsoleFailure.credentialInvalid }
            }
            if count > 0 && value[count-1] == 13 { count -= 1; value[count]=0 }
            let valid=value.withUnsafeBytes { CredentialFrame.validCredential(UnsafeRawBufferPointer(rebasing:$0[0..<count])) }
            guard count > 0, valid, !value.prefix(count).contains(10), !value.prefix(count).contains(13) else { throw ConsoleFailure.credentialInvalid }
            let finalNow:Int; do { finalNow=try clock.nowMilliseconds() } catch { throw ConsoleFailure.clock }
            guard finalNow >= now, finalNow < effectiveExpiry, DispatchTime.now().uptimeNanoseconds < end else { throw ConsoleFailure.expired }
            frame=try CredentialFrame.encode(value.prefix(count))
            try sink.write(frame,until:end,latch:latch)
        } catch is CancellationError { pending=ConsoleFailure.cancelled } catch let failure as ConsoleFailure { pending=failure } catch { pending=ConsoleFailure.terminal }
        // T11-M1, T11-M4: no unread byte is left for the next reader; O_NONBLOCK is restored first,
        // then the terminal, then the signal dispositions.
        let flushed=tcflush(ttyFD,TCIFLUSH) == 0
        let flagsRestored=fcntl(ttyFD,F_SETFL,flags) == 0; var restore=original; let terminalRestored=tcsetattr(ttyFD,TCSANOW,&restore) == 0
        signals.restore()
        guard flushed, flagsRestored, terminalRestored else { throw ConsoleFailure.terminal }; if let pending { throw pending }
        succeeded=true; return ConsumeResult(runID:binding.runID)
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
