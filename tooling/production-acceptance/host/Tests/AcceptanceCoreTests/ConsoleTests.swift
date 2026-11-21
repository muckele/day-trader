import Darwin
import Foundation
import Testing
@testable import AcceptanceCore

private final class ConsoleTestClock: ConsoleClock, @unchecked Sendable {
    private let lock = NSLock(); private var value:Int
    init(_ value:Int = 1_000) { self.value=value }
    func nowMilliseconds() throws -> Int { lock.withLock { value } }
    func set(_ newValue:Int) { lock.withLock { value=newValue } }
}

private final class ReceiptSource: ConsoleReceiptSource, @unchecked Sendable {
    var data:Data; init(_ data:Data=Data()) { self.data=data }
    func receive(maxBytes:Int) throws -> Data { data }
}
private final class PublicSink: ConsolePublicSink, @unchecked Sendable {
    private let lock=NSLock(); private(set) var values=[Data]()
    func publish(_ value:Data) throws { lock.withLock { values.append(value) } }
}
private final class ConsoleAuthority: ConsolePhaseAuthority, @unchecked Sendable {
    private let lock=NSLock(); var phase:ConsolePhase = .awaitCredential
    var sequence=1, expiresAt=150_000
    func permit(_ operation:ConsoleOperation,runID:String,now:Int) throws -> ConsolePermit {
        try lock.withLock {
            let allowed:Bool
            switch operation {
            case .credential: allowed = phase == .awaitCredential
            case .receipt(let kind):
                allowed = kind == .restartReceipt ? phase == .holdForRestart : phase == .preflight
            case .publicRecord: allowed = phase == .finalize
            }
            guard allowed else { throw ConsoleFailure.invalidFrame }
            return ConsolePermit(runID:runID,sequence:sequence,expiresAt:expiresAt)
        }
    }
}

// C8 vectors, the same table as intake_test.py FRAME_VECTORS: (case, secret, header hex).
private let credentialVectors:[(name:String,secret:Data,header:String)] = [
    ("a", Data("synthetic-private-canary".utf8), "00000018"),
    ("b", Data("0123456789".utf8), "0000000a"),
    ("c", Data([0x70,0x61,0x0a,0x73,0x73,0x03,0x04,0x15,0x7f,0x77,0x6f,0x72,0x64]), "0000000d"),
    ("d", Data(repeating:0x61,count:4096), "00001000"),
]
private let canary="synthetic-private-canary"
private func hex(_ data:Data) -> String { data.map { String(format:"%02x",$0) }.joined() }
// Any 8-byte window of the canary, so a split or partial copy is still found.
private func containsCanary(_ data:Data) -> Bool {
    let bytes=Array(canary.utf8)
    return (0...(bytes.count-8)).contains { start in data.range(of:Data(bytes[start..<start+8])) != nil }
}

private struct ConsoleHarness {
    let master:Int32, slave:Int32, serialRead:Int32, serialWrite:Int32
    let clock:ConsoleTestClock, sink:ConsoleSerialInput, authority:ConsoleAuthority
    let receipts:ReceiptSource, output:PublicSink, binding:RunBinding, proof:AdmissionProof
    init(receipt:Data=Data()) throws {
        var master:Int32=0, slave:Int32=0
        guard openpty(&master,&slave,nil,nil,nil)==0 else { throw ConsoleFailure.terminal }
        var serialPipe:[Int32]=[0,0]
        guard pipe(&serialPipe)==0 else { throw ConsoleFailure.terminal }
        self.master=master; self.slave=slave; serialRead=serialPipe[0]; serialWrite=serialPipe[1]
        clock=ConsoleTestClock(); authority=ConsoleAuthority()
        receipts=ReceiptSource(receipt); output=PublicSink()
        let identity=String(repeating:"a",count:64)
        binding=RunBinding(runID:String(repeating:"1",count:32),capability:Data(repeating:7,count:32),
            expiresAt:200_000,firstSequence:1,
            manifest:BrokerManifest(identity:identity,limits:BrokerLimits(bytes:10_000,idleMs:20),durationMs:30),
            configIdentity:String(repeating:"b",count:64),
            origins:[.frontend:"https://frontend.example.test",.backend:"https://backend.example.test"])
        proof=AdmissionProof(runID:binding.runID,manifestIdentity:identity,
            roleInventoryDigest:String(repeating:"c",count:64),deviceInventoryDigest:String(repeating:"d",count:64),
            topologyDigest:String(repeating:"e",count:64),expiresAt:200_000,sequence:1,
            eventCheckpointSequence:1,observedWall:1_000,observedMonotonic:1_000)
        // C8: the host sink is the serial input itself (the write end the VM serial attachment reads).
        sink=try ConsoleSerialInput(fd:serialWrite,runID:binding.runID)
        _ = try console()
    }
    // Caller-supplied facts only: these tests never inventory a real process.
    static let brokerFacts=[DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:501,device:9,inode:9,tty:false)]
    static let automationFacts=[DescriptorFacts(fd:4,kind:.pipe,direction:O_RDONLY,uid:501,device:8,inode:8,tty:false)]
    func console(brokerFacts:[DescriptorFacts]=[],automationFacts:[DescriptorFacts]=[]) throws -> SerialConsole {
        try SerialConsole(binding:binding,proof:proof,ttyFD:slave,sink:sink,authorization:authority,
            receiptSource:receipts,publicSink:output,clock:clock,
            brokerFacts:brokerFacts.isEmpty ? Self.brokerFacts : brokerFacts,
            automationFacts:automationFacts.isEmpty ? Self.automationFacts : automationFacts)
    }
    func grant(runID:String?=nil,consumer:String="BROWSER",destinations:Set<Destination>=[.frontend,.backend],
               issuedAt:Int=1_000,expiresAt:Int=121_000) throws -> IntakeGrant {
        try IntakeGrant.issue(proof:proof,binding:binding,runID:runID ?? binding.runID,
            consumer:consumer,destinations:destinations,issuedAt:issuedAt,expiresAt:expiresAt,
            now:clock.nowMilliseconds(),sink:sink)
    }
    // Fix round 1 (I2): honest facts. A holder of the serial input's read end shows the read end's own st_dev and
    // st_ino with O_RDONLY; on Darwin each pipe end has its own st_ino, so it never matches the write end the sink
    // pins. A holder of the write end (an injector) shows the sink's own identity with O_WRONLY.
    func serialInputFact() -> DescriptorFacts {
        var readEnd=stat(); _=fstat(serialRead,&readEnd)
        return DescriptorFacts(fd:5,kind:.pipe,direction:O_RDONLY,uid:501,device:UInt64(UInt32(bitPattern:readEnd.st_dev)),
            inode:UInt64(readEnd.st_ino),tty:false)
    }
    func serialWriteEndFact() -> DescriptorFacts {
        DescriptorFacts(fd:6,kind:.pipe,direction:O_WRONLY,uid:501,device:sink.device,inode:sink.inode,tty:false)
    }
    func echoEnabled() -> Bool { var value=termios(); return tcgetattr(slave,&value)==0 && value.c_lflag & tcflag_t(ECHO) != 0 }
    func attributes() -> termios { var value=termios(); _=tcgetattr(slave,&value); return value }
    func write(_ data:Data) {
        data.withUnsafeBytes { raw in _ = Darwin.write(master,raw.baseAddress,data.count) }
    }
    // Every byte now in the serial input pipe (what the guest would read).
    func serialBytes() -> Data { drain(serialRead) }
    // Every byte the PTY master received (echo, or anything the console wrote to the terminal).
    func masterOutput() -> Data { drain(master) }
    private func drain(_ fd:Int32) -> Data {
        _=fcntl(fd,F_SETFL,fcntl(fd,F_GETFL) | O_NONBLOCK)
        var data=Data(), chunk=[UInt8](repeating:0,count:8_192)
        while true {
            let count=chunk.withUnsafeMutableBytes { Darwin.read(fd,$0.baseAddress,$0.count) }
            guard count > 0 else { return data }; data.append(contentsOf:chunk[0..<count])
        }
    }
    func close() { Darwin.close(master); Darwin.close(slave); Darwin.close(serialRead); Darwin.close(serialWrite) }
}

private func sameAttributes(_ lhs:termios,_ rhs:termios) -> Bool {
    var left=lhs, right=rhs
    return withUnsafeBytes(of:&left) { a in withUnsafeBytes(of:&right) { b in a.elementsEqual(b) } }
}

private func safeFacts(_ tty:Bool=false) -> [DescriptorFacts] {
    [DescriptorFacts(fd:3,kind:.pipe,direction:0,uid:501,device:1,inode:3,tty:tty)]
}

@Suite(.serialized) struct ConsoleTests {
    @Test func nonTTY_redirect_reject() throws {
        var descriptors:[Int32]=[0,0]; #expect(pipe(&descriptors)==0)
        defer { Darwin.close(descriptors[0]); Darwin.close(descriptors[1]) }
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.nonTTY) {
            _ = try SerialConsole(binding:h.binding,proof:h.proof,ttyFD:descriptors[0],sink:h.sink,
                authorization:h.authority,receiptSource:h.receipts,publicSink:h.output,clock:h.clock,
                brokerFacts:ConsoleHarness.brokerFacts,automationFacts:ConsoleHarness.automationFacts)
        }
    }

    @Test func wrong_run_consumer_destination_expiry_second_consume_reject() async throws {
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.invalidGrant) { _ = try h.grant(runID:String(repeating:"2",count:32)) }
        #expect(throws:ConsoleFailure.invalidGrant) { _ = try h.grant(consumer:"VERIFIER") }
        #expect(throws:ConsoleFailure.invalidGrant) { _ = try h.grant(destinations:[.frontend]) }
        #expect(throws:ConsoleFailure.expired) { _ = try h.grant(expiresAt:121_001) }
        let expired=try h.grant(expiresAt:1_001); h.clock.set(1_001)
        await #expect(throws:ConsoleFailure.expired) { _ = try await h.console().consume(grant:expired) }
        h.clock.set(1_000); let grant=try h.grant(), console=try h.console()
        let task=Task { try await console.consume(grant:grant) }
        while h.echoEnabled() { usleep(1_000) }
        h.write(Data("synthetic-only-password\n".utf8)); _ = try await task.value
        await #expect(throws:ConsoleFailure.consumed) { _ = try await console.consume(grant:grant) }
        await #expect(throws:ConsoleFailure.consumed) { _ = try await console.consume(grant:try h.grant()) }
        let expiry=try ConsoleHarness(); defer { expiry.close() }
        expiry.authority.expiresAt=1_001
        let expiringTask=Task { try await expiry.console().consume(grant:try expiry.grant()) }
        while expiry.echoEnabled() { usleep(1_000) }
        expiry.clock.set(1_001); expiry.write(Data("late-private-value\n".utf8))
        await #expect(throws:ConsoleFailure.expired) { _ = try await expiringTask.value }
        #expect(expiry.echoEnabled())
    }

    @Test func cancelled_signal_exception_restore_both_echo() async throws {
        do {
            let h=try ConsoleHarness(); defer { h.close() }; let console=try h.console(), grant=try h.grant()
            #expect(h.echoEnabled()); let task=Task { try await console.consume(grant:grant) }
            while h.echoEnabled() { usleep(1_000) }
            _=Darwin.raise(SIGINT)
            await #expect(throws:ConsoleFailure.cancelled) { _ = try await task.value }
            #expect(h.echoEnabled())
        }
        do {
            // The serial input never takes the frame: a sink failure once the consume deadline (500 ms) passes.
            let h=try ConsoleHarness(); defer { h.close() }
            let fill=[UInt8](repeating:120,count:4096)
            _=fcntl(h.serialWrite,F_SETFL,fcntl(h.serialWrite,F_GETFL) | O_NONBLOCK)
            while fill.withUnsafeBytes({ Darwin.write(h.serialWrite,$0.baseAddress,fill.count) }) > 0 {}
            #expect(errno == EAGAIN || errno == EWOULDBLOCK)
            let task=Task { try await h.console().consume(grant:try h.grant(expiresAt:1_500)) }
            while h.echoEnabled() { usleep(1_000) }
            h.write(Data("synthetic-full-pipe\n".utf8))
            await #expect(throws:ConsoleFailure.sink) { _ = try await task.value }
            #expect(h.echoEnabled())
        }
    }

    // C8: the same frames as the Python vectors, header byte for byte.
    @Test func credential_frame_vectors_match_python() throws {
        for vector in credentialVectors {
            let frame=try CredentialFrame.encode(vector.secret)
            #expect(frame.count == 4 + vector.secret.count, "\(vector.name)")
            #expect(hex(frame.prefix(4)) == vector.header, "\(vector.name)")
            #expect(frame.dropFirst(4) == vector.secret, "\(vector.name)")
        }
    }

    // Producer for intake_test.py test_swift_credential_frames_decode_in_python (CREDENTIAL_FRAME_INPUT). P26: it
    // creates the directory it writes into, and writes the file exclusively.
    @Test func credential_frames_exported_for_python() throws {
        let path=try #require(ProcessInfo.processInfo.environment["CREDENTIAL_FRAME_EXCHANGE"])
        let directory=URL(fileURLWithPath:path)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false)
        let vectors=try credentialVectors.map { ["secretHex":hex($0.secret),"frameHex":hex(try CredentialFrame.encode($0.secret))] }
        let data=try JSONSerialization.data(withJSONObject:["vectors":vectors],options:[.sortedKeys,.withoutEscapingSlashes])
        try data.write(to:directory.appendingPathComponent("credential-frames.json"),options:.withoutOverwriting)
    }

    // T11-I3, P26: the host serial input names only its run; the guest consumer, child and UID exist only in the guest.
    @Test func serial_input_has_no_guest_role_fields() throws {
        let h=try ConsoleHarness(); defer { h.close() }
        let labels=Set(Mirror(reflecting:h.sink).children.compactMap(\.label))
        #expect(labels == ["runID","device","inode","fd"])
        for guestField in ["consumer","childID","childUID","destinations","endpoint"] { #expect(!labels.contains(guestField)) }
        #expect(Mirror(reflecting:ConsumeResult(runID:h.binding.runID)).children.compactMap(\.label) == ["runID"])
        var stored=stat(); #expect(fstat(h.serialWrite,&stored) == 0)
        #expect(h.sink.runID == h.binding.runID && h.sink.inode == UInt64(stored.st_ino))
        // The serial input is a pipe's write end, never a TTY or a read end, and the run id is 32 lowercase hex.
        let ttyFlags=fcntl(h.slave,F_GETFL)
        #expect(throws:ConsoleFailure.descriptor) { _ = try ConsoleSerialInput(fd:h.serialRead,runID:h.binding.runID) }
        #expect(throws:ConsoleFailure.descriptor) { _ = try ConsoleSerialInput(fd:h.slave,runID:h.binding.runID) }
        #expect(fcntl(h.slave,F_GETFL) == ttyFlags)
        #expect(throws:ConsoleFailure.descriptor) { _ = try ConsoleSerialInput(fd:h.serialWrite,runID:String(repeating:"A",count:32)) }
    }

    // T11-M8: oversize is credentialInvalid, never invalidGrant; so is an operator line that is not UTF-8.
    @Test func oversize_credential_is_credential_invalid() async throws {
        #expect(throws:ConsoleFailure.credentialInvalid) { _ = try CredentialFrame.encode(Data(repeating:0x61,count:4097)) }
        #expect(throws:ConsoleFailure.credentialInvalid) { _ = try CredentialFrame.encode(Data()) }
        let largest=try CredentialFrame.encode(Data(repeating:0x61,count:4096))
        #expect(largest.count == 4100)
        let h=try ConsoleHarness(); defer { h.close() }; let console=try h.console(), grant=try h.grant()
        let task=Task { try await console.consume(grant:grant) }
        while h.echoEnabled() { usleep(1_000) }
        h.write(Data([0xff,0x0a]))
        await #expect(throws:ConsoleFailure.credentialInvalid) { _ = try await task.value }
        #expect(h.serialBytes().isEmpty)
        #expect(h.echoEnabled())
    }

    // RF5: the actual PTY output and the actual published records hold no canary; the serial input holds exactly
    // the C8 frame of the operator line without its newline.
    @Test func host_output_and_receipts_hold_no_canary() async throws {
        let h=try ConsoleHarness(); defer { h.close() }; let console=try h.console(), grant=try h.grant()
        let before=h.attributes(), flagsBefore=fcntl(h.slave,F_GETFL)
        let task=Task { try await console.consume(grant:grant) }
        while h.echoEnabled() { usleep(1_000) }
        let during=h.attributes()
        #expect(during.c_lflag & tcflag_t(ICANON) != 0)
        #expect(during.c_lflag & tcflag_t(ECHO | ECHONL | ISIG | IEXTEN) == 0)
        h.write(Data((canary+"\n").utf8))
        let result=try await task.value
        #expect(result == ConsumeResult(runID:h.binding.runID))
        #expect(!String(describing:result).contains(canary))
        let expectedFrame=try CredentialFrame.encode(Data(canary.utf8))
        #expect(h.serialBytes() == expectedFrame)
        #expect(sameAttributes(h.attributes(),before))
        #expect(fcntl(h.slave,F_GETFL) == flagsBefore)
        let echoed=h.masterOutput()
        #expect(!containsCanary(echoed))
        let json="{\"version\":1,\"kind\":\"PUBLIC_RECORD\",\"runId\":\"" + h.binding.runID
            + "\",\"sequence\":1,\"payload\":{\"recordKind\":\"PHASE\",\"phase\":\"PREFLIGHT\",\"outcome\":\"PASS\"}}"
        h.authority.phase = .finalize
        try console.publish(record:try Contracts.decode(Data(json.utf8),kind:.publicRecord))
        #expect(h.output.values.count == 1)
        #expect(!h.output.values.contains { containsCanary($0) })
    }

    @Test func raw_console_ANSI_OSC_reject() throws {
        let h=try ConsoleHarness(receipt:Data("\u{1b}]0;secret\u{07}\u{1b}[31m".utf8)); defer { h.close() }
        let console=try h.console(); h.authority.phase = .holdForRestart
        #expect(throws:ConsoleFailure.invalidFrame) { _ = try console.receiveReceipt(kind:.restartReceipt) }
        #expect(throws:ConsoleFailure.terminal) { _ = try console.receiveReceipt(kind:.restartReceipt) }
        #expect(h.output.values.isEmpty)
    }

    // Over caller-supplied facts only (T11-I2): no real broker inventory is taken here. A broker holding the serial
    // input's write end is refused. A holder of its read end is not visible in fstat facts (fix round 1, I2): the
    // host-side peer check (proc_pidfdinfo PROC_PIDFDPIPEINFO pipe_peerhandle) is carried to Stage 2.
    @Test func broker_fd_inventory_no_TTY_over_supplied_facts() throws {
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(brokerFacts:safeFacts(true)) }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(brokerFacts:[h.serialWriteEndFact()]) }
        withKnownIssue("read-end holders are unbound on the host until the Stage 2 pipe-peer check") {
            #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(brokerFacts:[h.serialInputFact()]) }
        }
        _ = try h.console(brokerFacts:safeFacts(false))
    }

    // Over caller-supplied facts only (T11-I2): the automation child holds neither a TTY nor the serial input's write
    // end. Its read end is unbound here, as above (fix round 1, I2; carried to Stage 2).
    @Test func automation_child_no_console_access_over_supplied_facts() throws {
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(automationFacts:safeFacts(true)) }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(automationFacts:[h.serialWriteEndFact()]) }
        withKnownIssue("read-end holders are unbound on the host until the Stage 2 pipe-peer check") {
            #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(automationFacts:[h.serialInputFact()]) }
        }
        _ = try h.console(automationFacts:safeFacts(false))
    }
}
