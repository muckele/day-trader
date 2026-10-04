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
private enum SyntheticFailure: Error { case privateSink }
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

private struct ConsoleHarness {
    let master:Int32, slave:Int32, privateRead:Int32, privateWrite:Int32
    let clock:ConsoleTestClock, sink:ConsolePrivatePipeSink, authority:ConsoleAuthority
    let receipts:ReceiptSource, output:PublicSink, binding:RunBinding, proof:AdmissionProof
    init(receipt:Data=Data(), brokerFacts:[DescriptorFacts]=[], automationFacts:[DescriptorFacts]=[]) throws {
        var master:Int32=0, slave:Int32=0
        guard openpty(&master,&slave,nil,nil,nil)==0 else { throw ConsoleFailure.terminal }
        var privatePipe:[Int32]=[0,0]
        guard pipe(&privatePipe)==0 else { throw ConsoleFailure.terminal }
        self.master=master; self.slave=slave; privateRead=privatePipe[0]; privateWrite=privatePipe[1]
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
        sink=try ConsolePrivatePipeSink.issue(fd:privateWrite,binding:binding,consumer:"BROWSER",
            destinations:[.frontend,.backend],childID:String(repeating:"2",count:32),childUID:10002)
        let defaults = Self.facts(sink:sink)
        _ = try SerialConsole(binding:binding,proof:proof,ttyFD:slave,sink:sink,authorization:authority,
            receiptSource:receipts,publicSink:output,clock:clock,
            brokerFacts:brokerFacts.isEmpty ? defaults.broker : brokerFacts,
            automationFacts:automationFacts.isEmpty ? defaults.automation : automationFacts)
    }
    static func facts(sink:ConsolePrivatePipeSink) -> (broker:[DescriptorFacts],automation:[DescriptorFacts]) {
        let broker=[DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:501,device:9,inode:9,tty:false)]
        let automation=[DescriptorFacts(fd:4,kind:.pipe,direction:O_RDONLY,uid:sink.childUID,
            device:sink.device,inode:sink.inode,tty:false)]
        return (broker,automation)
    }
    func console(brokerFacts:[DescriptorFacts]=[],automationFacts:[DescriptorFacts]=[]) throws -> SerialConsole {
        let defaults=Self.facts(sink:sink)
        return try SerialConsole(binding:binding,proof:proof,ttyFD:slave,sink:sink,authorization:authority,
            receiptSource:receipts,publicSink:output,clock:clock,
            brokerFacts:brokerFacts.isEmpty ? defaults.broker : brokerFacts,
            automationFacts:automationFacts.isEmpty ? defaults.automation : automationFacts)
    }
    func grant(runID:String?=nil,consumer:String="BROWSER",destinations:Set<Destination>=[.frontend,.backend],
               issuedAt:Int=1_000,expiresAt:Int=121_000) throws -> IntakeGrant {
        try IntakeGrant.issue(proof:proof,binding:binding,runID:runID ?? binding.runID,
            consumer:consumer,destinations:destinations,issuedAt:issuedAt,expiresAt:expiresAt,
            now:clock.nowMilliseconds(),sink:sink)
    }
    func echoEnabled() -> Bool { var value=termios(); return tcgetattr(slave,&value)==0 && value.c_lflag & tcflag_t(ECHO) != 0 }
    func write(_ data:Data) {
        data.withUnsafeBytes { raw in _ = Darwin.write(master,raw.baseAddress,data.count) }
    }
    func privateValue() -> Data {
        var length=UInt32(0); _=withUnsafeMutableBytes(of:&length) { Darwin.read(privateRead,$0.baseAddress,4) }
        let count=Int(UInt32(bigEndian:length)); var value=Data(count:count)
        _=value.withUnsafeMutableBytes { Darwin.read(privateRead,$0.baseAddress,count) }
        return value
    }
    func close() { Darwin.close(master); Darwin.close(slave); Darwin.close(privateRead); Darwin.close(privateWrite) }
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
                brokerFacts:SelfFacts.broker,automationFacts:SelfFacts.automation)
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
            let h=try ConsoleHarness(); defer { h.close() }
            let fill=[UInt8](repeating:120,count:4096)
            while fill.withUnsafeBytes({ Darwin.write(h.privateWrite,$0.baseAddress,fill.count) }) > 0 {}
            #expect(errno == EAGAIN || errno == EWOULDBLOCK)
            let task=Task { try await h.console().consume(grant:try h.grant()) }
            while h.echoEnabled() { usleep(1_000) }
            h.write(Data("synthetic-full-pipe\n".utf8))
            await #expect(throws:ConsoleFailure.sink) { _ = try await task.value }
            #expect(h.echoEnabled())
        }
    }

    @Test func synthetic_canary_absent_from_host_output_and_evidence() async throws {
        let h=try ConsoleHarness(); defer { h.close() }; let console=try h.console(), grant=try h.grant()
        let task=Task { try await console.consume(grant:grant) }
        while h.echoEnabled() { usleep(1_000) }
        let secret="synthetic-host-private-canary"; h.write(Data((secret+"\n").utf8))
        let result=try await task.value
        #expect(result.runID == h.binding.runID); #expect(result.byteLength == secret.utf8.count)
        #expect(h.privateValue() == Data(secret.utf8))
        let json="{\"version\":1,\"kind\":\"PUBLIC_RECORD\",\"runId\":\"" + h.binding.runID
            + "\",\"sequence\":1,\"payload\":{\"recordKind\":\"PHASE\",\"phase\":\"PREFLIGHT\",\"outcome\":\"PASS\"}}"
        let record=try Contracts.decode(Data(json.utf8),kind:.publicRecord)
        h.authority.phase = .finalize
        try console.publish(record:record)
        #expect(h.output.values.count == 1)
        #expect(!String(decoding:h.output.values[0],as:UTF8.self).contains(secret))
    }

    @Test func raw_console_ANSI_OSC_reject() throws {
        let h=try ConsoleHarness(receipt:Data("\u{1b}]0;secret\u{07}\u{1b}[31m".utf8)); defer { h.close() }
        let console=try h.console(); h.authority.phase = .holdForRestart
        #expect(throws:ConsoleFailure.invalidFrame) { _ = try console.receiveReceipt(kind:.restartReceipt) }
        #expect(throws:ConsoleFailure.terminal) { _ = try console.receiveReceipt(kind:.restartReceipt) }
        #expect(h.output.values.isEmpty)
    }

    @Test func broker_fd_inventory_no_TTY() throws {
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(brokerFacts:safeFacts(true)) }
        _ = try h.console(brokerFacts:safeFacts(false))
    }

    @Test func automation_child_no_console_access() throws {
        let h=try ConsoleHarness(); defer { h.close() }
        #expect(throws:ConsoleFailure.descriptor) { _ = try h.console(automationFacts:safeFacts(true)) }
        _ = try h.console()
    }
}

private enum SelfFacts {
    static let broker=[DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:501,device:9,inode:9,tty:false)]
    static let automation=[DescriptorFacts(fd:4,kind:.pipe,direction:O_RDONLY,uid:10002,device:8,inode:8,tty:false)]
}
