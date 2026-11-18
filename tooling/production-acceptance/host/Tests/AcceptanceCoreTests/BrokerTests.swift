import Foundation
import CryptoKit
import Testing
@testable import AcceptanceCore

// Observable memory barriers; no sleeps or fixed yield loops drive fix probes.
private final class MemoryEvent: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var waiters = [CheckedContinuation<Void, Never>]()
    var isSignalled: Bool { lock.withLock { fired } }
    func signal() {
        let ready = lock.withLock {
            fired = true
            let ready = waiters
            waiters.removeAll()
            return ready
        }
        ready.forEach { $0.resume() }
    }
    func wait() async {
        await withCheckedContinuation { continuation in
            let immediate = lock.withLock {
                if fired { return true }
                waiters.append(continuation)
                return false
            }
            if immediate { continuation.resume() }
        }
    }
}

private final class ObservedMemoryStream: ByteStream, @unchecked Sendable {
    let base: BufferedStream
    let closed = MemoryEvent()
    let cancelled = MemoryEvent()
    let readGate: Deferred<Data>?
    init(_ data: Data = Data(), readGate: Deferred<Data>? = nil) {
        base = BufferedStream(data)
        self.readGate = readGate
    }
    func read(maxBytes: Int) async throws -> Data {
        if let readGate {
            return try await withTaskCancellationHandler {
                try await readGate.get()
            } onCancel: {
                self.cancelled.signal()
            }
        }
        return try await base.read(maxBytes: maxBytes)
    }
    func write(_ data: Data) async throws -> Int { try await base.write(data) }
    func endWrite() async throws {}
    func close() { base.close(); closed.signal() }
}

private final class UnexpectedWaitClock: BrokerClock, @unchecked Sendable {
    let regular = FakeClock()
    let errorGate = Deferred<Void>()
    let returnedError = MemoryEvent()
    private let lock = NSLock()
    private var calls = 0
    let errorIndex: Int
    init(errorIndex: Int) { self.errorIndex = errorIndex }
    func sample() throws -> ClockSample { try regular.sample() }
    func wait(milliseconds: Int) async throws {
        let current = lock.withLock { calls += 1; return calls }
        if current == errorIndex {
            try await errorGate.get()
            returnedError.signal()
            // The caller's Task has not been cancelled.
            throw CancellationError()
        }
        try await regular.wait(milliseconds: milliseconds)
    }
}

private final class FakeClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock()
    var value = ClockSample(wall: 160, monotonic: 10)
    private var isBroken = false
    var broken: Bool { get { lock.withLock { isBroken } } set { lock.withLock { isBroken = newValue } } }
    private var recordedDurations = [Int]()
    var durations: [Int] { lock.withLock { recordedDurations } }
    private var observers = [(Int, CheckedContinuation<Void,Never>)]()
    private var waiters = [UUID: CheckedContinuation<Void, any Error>]()
    func sample() throws -> ClockSample { try lock.withLock { if isBroken { throw BrokerFailure.clock }; return value } }
    func set(_ wall: Int = 160, _ mono: Int = 10) { lock.withLock { value = ClockSample(wall: wall, monotonic: mono) } }
    func wait(milliseconds: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
                lock.withLock { recordedDurations.append(milliseconds); if Task.isCancelled { c.resume(throwing:CancellationError()) } else { waiters[id] = c }; let ready = observers.filter { waiters.count >= $0.0 }; observers.removeAll { waiters.count >= $0.0 }; ready.forEach { $0.1.resume() } }
            }
        } onCancel: { self.lock.withLock { self.waiters.removeValue(forKey:id) }?.resume(throwing:CancellationError()) }
    }
    func waitForWaiters(_ count:Int) async {
        await withCheckedContinuation { c in
            lock.withLock { if waiters.count >= count { c.resume() } else { observers.append((count,c)) } }
        }
    }
    var waitCount: Int { lock.withLock { waiters.count } }
    func tick() { let cs = lock.withLock { let cs = Array(waiters.values); waiters = [:]; return cs }; cs.forEach { $0.resume() } }
}
private actor Deferred<T: Sendable> {
    var c: CheckedContinuation<T, any Error>?, entered = false
    var observers = [CheckedContinuation<Void, Never>]()
    func get() async throws -> T { try await withCheckedThrowingContinuation { c in self.c = c; entered = true; observers.forEach { $0.resume() }; observers = [] } }
    func waitEntered() async { if entered { return }; await withCheckedContinuation { observers.append($0) } }
    func finish(_ value: T) { c?.resume(returning: value); c = nil }
    func fail() { c?.resume(throwing: BrokerFailure.transport); c = nil }
}
private final class MemoryStream: ByteStream, @unchecked Sendable {
    let lock = NSLock()
    var chunks: [Data], written = Data(), ends = 0, maxRead = 0, maxWrite = 0
    private var closeCount = 0
    let closeEvent = MemoryEvent()
    var closes: Int { lock.withLock { closeCount } }
    var partial = 4096, badWrite = false, badRead = false
    let delayed: Deferred<Data>?
    init(_ chunks: [Data] = [], delayed: Deferred<Data>? = nil) { self.chunks = chunks; self.delayed = delayed }
    func read(maxBytes: Int) async throws -> Data {
        if let delayed { return try await delayed.get() }
        return try lock.withLock { maxRead = max(maxRead, maxBytes); if badRead { throw NSError(domain: "PRIVATE_PAYLOAD_CANARY", code: 1) }; if chunks.isEmpty { return Data() }; let d = chunks.removeFirst(); return d }
    }
    func write(_ data: Data) async throws -> Int { try lock.withLock { maxWrite = max(maxWrite,data.count); if badWrite { throw NSError(domain: "PRIVATE_PAYLOAD_CANARY", code: 2) }; let n = min(partial,data.count); written.append(data.prefix(n)); return n } }
    func endWrite() async throws { lock.withLock { ends += 1 } }
    func close() { lock.withLock { closeCount += 1 }; closeEvent.signal() }
}
private final class FakeResolver: Resolver, @unchecked Sendable {
    let lock = NSLock(); var calls = [String](), addresses: [NumericAddress]
    let deferred: Deferred<[NumericAddress]>?
    init(_ addresses: [NumericAddress], deferred: Deferred<[NumericAddress]>? = nil) { self.addresses = addresses; self.deferred = deferred }
    func resolve(host: String) async throws -> [NumericAddress] { let first = lock.withLock { calls.append(host); return calls.count == 1 }; if first, let deferred { return try await deferred.get() }; return addresses }
}
private final class FakeConnector: Connector, @unchecked Sendable {
    let lock = NSLock(); var calls = [(NumericAddress, UInt16)](); let stream: MemoryStream
    let deferred: Deferred<any ByteStream>?
    // Origins handed out in order before falling back to `stream`.
    var queued: [any ByteStream]
    init(stream: MemoryStream = MemoryStream(), deferred: Deferred<any ByteStream>? = nil, queued: [any ByteStream] = []) { self.stream = stream; self.deferred = deferred; self.queued = queued }
    func connect(address: NumericAddress, port: UInt16) async throws -> any ByteStream {
        let (first, next) = lock.withLock { () -> (Bool, (any ByteStream)?) in calls.append((address,port)); return (calls.count == 1, queued.isEmpty ? nil : queued.removeFirst()) }
        if first, let deferred { return try await deferred.get() }
        return next ?? stream
    }
}
private struct Harness {
    let clock: FakeClock, authority: ReleaseAuthority, release: VerifiedRelease, binding: RunBinding, resolver: FakeResolver, connector: FakeConnector, broker: EgressBroker
    init(clock: FakeClock = FakeClock(), resolver: FakeResolver? = nil, connector: FakeConnector = FakeConnector(), bytes: Int = 10000, idle: Int = 20, duration: Int = 30, expiry: Int = 190, releaseMaxAge: Int = 100, capability: Data = harnessCapability, firstSequence: Int = 1, manifestIdentity: String = String(repeating:"b",count:64), configIdentity: String = String(repeating:"a",count:64), origins: [Destination:String] = [.frontend:"https://frontend.example.test",.backend:"https://backend.example.test"]) throws {
        self.clock = clock
        let f = try BrokerTests.fixture(); let a = try BrokerTests.authority(f,maxAge:releaseMaxAge); authority = a
        release = try ReceiptVerifier.verifyRelease(BrokerTests.candidate(f), authority:a, atWallTime:clock.sample().wall)
        let r = try resolver ?? FakeResolver([NumericAddress("8.8.8.8")]); self.resolver = r; self.connector = connector
        binding = RunBinding(runID: BrokerTests.runID, capability:capability, expiresAt:expiry,firstSequence:firstSequence,manifest:BrokerManifest(identity:manifestIdentity,limits:BrokerLimits(bytes:bytes,idleMs:idle),durationMs:duration),configIdentity:configIdentity,origins:origins)
        broker = try EgressBroker(release:release,authority:a,binding:binding,limits:BrokerLimits(bytes:bytes,idleMs:idle),resolver:r,connector:connector,clock:clock)
    }
}

// C3/C4 (E3). The harness run capability is 32 bytes of 7; the host derives k_vsock from it
// (Task 3 vector 5814c714...4d00) and verifies each stream's proof with that key.
private let harnessCapability = Data(repeating: 7, count: 32)
private let testVsockKey = try! ChannelKeys.derive(capability: harnessCapability, label: "vsock-stream")
private func hexString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
// Challenge value i: bytes 00..0f with the big-endian i XORed into the last eight bytes, so the
// first is the vector's 00..0f and no two values repeat.
private func brokerNonce(_ index: UInt64) -> Data {
    var bytes = (0..<16).map { UInt8($0) }
    withUnsafeBytes(of: index.bigEndian) { for (offset, byte) in $0.enumerated() { bytes[8 + offset] ^= byte } }
    return Data(bytes)
}
private final class CountingBrokerNonces: BrokerNonceSource, @unchecked Sendable {
    private let lock = NSLock(); private var next: UInt64
    init(start: UInt64 = 0) { next = start }
    func nonce() throws -> Data { lock.withLock { defer { next += 1 }; return brokerNonce(next) } }
}
private final class ConstantBrokerNonces: BrokerNonceSource, @unchecked Sendable {
    let value: Data?
    init(_ value: Data?) { self.value = value }
    func nonce() throws -> Data { guard let value else { throw BrokerFailure.transport }; return value }
}
// Suite-wide fresh values for the M2 cases that predate the challenge.
private let harnessNonces = CountingBrokerNonces(start: 1 << 32)
private func controlFields(_ control: Data) -> (String, Int) {
    let value = (try? JSONSerialization.jsonObject(with: control)) as? [String: Any]
    return (value?["runId"] as? String ?? "", value?["sequence"] as? Int ?? 0)
}
// The guest's C4 proof for CONTROL's own run and sequence (k_vsock unless KEY is given).
private func proofFor(_ control: Data, _ nonce: Data, key: Data = testVsockKey) -> Data {
    let (run, sequence) = controlFields(control)
    return VsockStreamProof.compute(key: key, nonce: nonce, runID: run, sequence: sequence)
}
// A C4 request for CONTROL: by default a fresh nonce and a valid proof.
private func admission(_ control: Data, _ stream: any ByteStream, nonce: Data? = nil, proof: Data? = nil, key: Data = testVsockKey) -> RelayRequest {
    let challenge = nonce ?? (try! harnessNonces.nonce())
    return RelayRequest(control: control, nonce: challenge, proof: proof ?? proofFor(control, challenge, key: key), stream: stream)
}
extension EgressBroker {
    // Test-only: the M2 cases admit through the real verifier with a valid C4 proof.
    // Production has no proof-less entry.
    func accept(control: Data, stream: any ByteStream) async throws -> Tunnel {
        try await accept(request: admission(control, stream))
    }
}
@Suite(.serialized) struct BrokerTests {
    static let runID = String(repeating:"1",count:32)
    static func fixture() throws -> [String:Any] { return try #require(JSONSerialization.jsonObject(with:Data(contentsOf:receiptNodeInput(environment:ProcessInfo.processInfo.environment))) as? [String:Any]) }
    static func candidate(_ f: [String:Any]) throws -> Data { let rows = try #require(f["positive"] as? [[String:String]]); return Data(try #require(rows.first { $0["kind"] == "RELEASE_RECEIPT" }?["json"]).utf8) }
    static func authority(_ f: [String:Any], maxAge: Int = 100, notBefore: Int = 0, deadline: Int = 300) throws -> ReleaseAuthority {
        let options = try #require(f["options"] as? [String:Any]), expected = try #require(options["expected"] as? [String:[String:Any]]), keys = try #require(options["publicKeys"] as? [String:String])
        var template = try #require(expected["RELEASE_RECEIPT"]), p = try #require(template["payload"] as? [String:Any]); p["issuedAt"] = 0; p["expiresAt"] = 1; p["keyId"] = String(repeating:"0",count:64); p["signature"] = String(repeating:"0",count:128); template["payload"] = p
        return try ReleaseAuthority(expectedRelease:JSONSerialization.data(withJSONObject:template),publicKey:hex(#require(keys["RELEASE_RECEIPT"])),maxAgeMs:maxAge,notBefore:notBefore,deadline:deadline)
    }
    static func hex(_ s:String) -> Data { Data(stride(from:0,to:s.count,by:2).map { i in UInt8(s.dropFirst(i).prefix(2),radix:16)! }) }
    func control(_ destination:String = "FRONTEND", sequence:Int = 1, run:String = runID, phase:String = "PREFLIGHT", event:String = "validate") -> Data { Data("{\"version\":1,\"kind\":\"CONTROL\",\"runId\":\"\(run)\",\"sequence\":\(sequence),\"payload\":{\"phase\":\"\(phase)\",\"event\":\"\(event)\",\"destination\":\"\(destination)\"}}".utf8) }
    private func denied(_ h:Harness, _ data:Data, stream:MemoryStream = MemoryStream(), expected:BrokerFailure? = nil) async {
        do { let t = try await h.broker.accept(control:data,stream:stream); t.close(); Issue.record("Unexpected admitted control") } catch { if let expected { #expect(error as? BrokerFailure == expected) } }
    }
    @Test func exact_two_enums_only() async throws {
        let h = try Harness(); let a = try await h.broker.accept(control:control(),stream:MemoryStream()); let b = try await h.broker.accept(control:control("BACKEND",sequence:2),stream:MemoryStream())
        #expect(h.resolver.calls.count == 2); #expect(h.resolver.calls[0] != h.resolver.calls[1]); #expect(h.connector.calls.allSatisfy { $0.1 == 443 }); a.close(); b.close()
    }
    @Test func arbitrary_host_suffix_trailing_dot_ip_literal_port_rejected() async throws {
        for dest in ["evil.example","FRONTEND.evil","FRONTEND.","8.8.8.8","FRONTEND:8443","https://frontend.example"] { let h = try Harness(); await denied(h,control(dest)); #expect(h.connector.calls.isEmpty) }
    }
    @Test func no_udp_socks_dns_request_or_file_command() async throws {
        for dest in ["UDP","SOCKS","DNS","CONNECT-UDP","/private/file","command"] { let h = try Harness(); await denied(h,control(dest)); #expect(h.resolver.calls.isEmpty) }
    }
    @Test func malformed_duplicate_unknown_and_header256_rejected() async throws {
        let good = String(decoding:control(),as:UTF8.self)
        let bad = [Data(),Data("{}".utf8),Data(good.replacingOccurrences(of:"\"version\":1",with:"\"version\":1,\"version\":1").utf8),Data(good.replacingOccurrences(of:"\"version\":1",with:"\"host\":\"evil.example\",\"version\":1").utf8),Data(repeating:32,count:257)]
        for data in bad { let h = try Harness(); await denied(h,data); #expect(h.resolver.calls.isEmpty) }
    }
    @Test func wrong_run_sequence_replay_and_terminal_phase_rejected() async throws {
        // P38(a): a first control with a gap (sequence 2) is admitted; sequence_gaps_admitted_repeat_or_decrease_denied binds it.
        for data in [control(run:String(repeating:"b",count:32)),control(phase:"DONE",event:"readResult"),control(event:"abort")] { let h = try Harness(); await denied(h,data); #expect(h.connector.calls.isEmpty) }
        let h = try Harness(); let t = try await h.broker.accept(control:control(),stream:MemoryStream()); await denied(h,control(),expected:.replay); t.close()
    }
    @Test func required_limits_run_and_capability_fail_closed() throws {
        for (bytes,idle,duration,expiry) in [(0,20,30,190),(100,0,30,190),(100,20,0,190),(100,20,30,160),(-1,20,30,190)] { #expect(throws:(any Error).self) { _ = try Harness(bytes:bytes,idle:idle,duration:duration,expiry:expiry) } }
        // The host derives k_vsock from its own 32-byte capability; no other length is a run capability.
        for bad in [Data(),Data(repeating:7,count:31),Data(repeating:7,count:33)] { #expect(throws:BrokerFailure.identity) { _ = try Harness(capability:bad) } }
    }
    @Test func nonpublic_ipv4_addresses_rejected() throws {
        for text in ["0.0.0.0","0.1.2.3","10.1.2.3","100.64.0.1","127.0.0.1","169.254.169.254","172.16.0.1","172.31.255.255","192.0.0.1","192.0.2.1","192.88.99.1","192.168.1.1","198.18.0.1","198.19.255.255","198.51.100.2","203.0.113.2","224.0.0.1","239.1.1.1","240.0.0.1","255.255.255.255"] { #expect(try !NumericAddress(text).isPublic,"\(text)") }
    }
    @Test func ipv6_reserved_documentation_mapped_translated_rejected() throws {
        for text in ["::","::1","fe80::1","fc00::1","fd00::1","ff02::1","2001:db8::1","3fff::1","2001:2::1","2001:10::1","2001:20::1","2001::1","2002:0808:0808::1","::ffff:127.0.0.1","::ffff:8.8.8.8","::127.0.0.1","64:ff9b::a00:1","64:ff9b:1::1","100::1"] { #expect(try !NumericAddress(text).isPublic,"\(text)") }
        for text in ["8.8.8.8","1.1.1.1","172.32.0.1","2001:4860:4860::8888","2606:4700:4700::1111"] { #expect(try NumericAddress(text).isPublic) }
    }
    @Test func malformed_unsupported_numeric_forms_rejected() throws {
        for text in ["example.org","127.1","0177.0.0.1","0x7f000001","2130706433","256.1.1.1","1.2.3.4."," 8.8.8.8","8.8.8.8:443","[2001:4860::1]","fe80::1%en0","1::2::3","::ffff:garbage", "2001:4860::1\n"] { #expect(throws:(any Error).self,"\(text)") { _ = try NumericAddress(text) } }
    }
    @Test func mixed_empty_answer_sets_and_rebinding_no_second_resolution() async throws {
        for values in [[],[try NumericAddress("8.8.8.8"),try NumericAddress("10.0.0.1")]] { let r = FakeResolver(values); let h = try Harness(resolver:r); await denied(h,control()); #expect(h.connector.calls.isEmpty) }
        let r = try FakeResolver([NumericAddress("8.8.8.8"),NumericAddress("1.1.1.1")]); let h = try Harness(resolver:r); let t = try await h.broker.accept(control:control(),stream:MemoryStream()); #expect(r.calls.count == 1); #expect(h.connector.calls.first?.0 == r.addresses.first); t.close()
    }
    @Test func connection17_and_pending_admissions_capacity() async throws {
        let h = try Harness(); var tunnels = [Tunnel]()
        for n in 1...16 { tunnels.append(try await h.broker.accept(control:control(sequence:n),stream:MemoryStream())) }
        #expect(await h.broker.activeCount == 16); await denied(h,control(sequence:17),expected:.capacity); #expect(h.connector.calls.count == 16); tunnels.forEach { $0.close() }
    }
    @Test func concurrent_pending_reservation_and_no_double_free() async throws {
        let d = Deferred<[NumericAddress]>(); let r = try FakeResolver([NumericAddress("8.8.8.8")],deferred:d); let h = try Harness(resolver:r)
        let task = Task { try await h.broker.accept(control:control(),stream:MemoryStream()) }; await d.waitEntered(); #expect(await h.broker.activeCount == 1); await h.broker.fail(.transport); await h.broker.fail(.transport); await d.finish(r.addresses)
        do { _ = try await task.value; Issue.record("Late resolver revived broker") } catch {};
        #expect(h.connector.calls.isEmpty); #expect(await h.broker.activeCount == 0); await denied(h,control(sequence:2),expected:.terminal)
    }
    @Test func resolver_release_run_expiry_after_await_rejected() async throws {
        for (wall,mono) in [(200,10),(190,10),(160,40)] { let d = Deferred<[NumericAddress]>(); let r = try FakeResolver([NumericAddress("8.8.8.8")],deferred:d); let h = try Harness(resolver:r); let task = Task { try await h.broker.accept(control:control(),stream:MemoryStream()) }; await d.waitEntered(); h.clock.set(wall,mono); await d.finish(r.addresses); do { _ = try await task.value; Issue.record("Expired admission") } catch {}; #expect(h.connector.calls.isEmpty) }
    }
    @Test func late_connector_failure_expiry_and_cancellation_disposed() async throws {
        for mode in ["fail", "expiry", "cancel"] {
            let deferred = Deferred<any ByteStream>()
            let connector = FakeConnector(deferred: deferred)
            let input = MemoryStream()
            let h = try Harness(connector: connector)
            let task = Task { try await h.broker.accept(control: control(), stream: input) }
            await deferred.waitEntered()
            if mode == "fail" { await h.broker.fail(.transport) }
            if mode == "expiry" { h.clock.set(200, 10) }
            if mode == "cancel" { task.cancel() }
            let late = MemoryStream()
            await deferred.finish(late)
            do { _ = try await task.value; Issue.record("Late connector admitted") } catch {}
            // Admission now returns independently of a late worker callback.
            await late.closeEvent.wait()
            #expect(late.closes == 1)
            #expect(input.closes == 1)
            #expect(await h.broker.activeCount == 0)
        }
    }
    @Test func clock_throw_invalid_wall_monotonic_and_rollback_fail_closed() async throws {
        for (wall,mono) in [(-1,10),(160,-1),(159,10),(160,9),(9007199254740992,10)] { let h = try Harness(); h.clock.set(wall,mono); await denied(h,control()); #expect(h.connector.calls.isEmpty) }
        let h = try Harness(); h.clock.broken = true; await denied(h,control()); #expect(h.connector.calls.isEmpty)
    }
    @Test func broker_loss_closes_existing_tunnels_no_resume() async throws {
        let h = try Harness(), input = MemoryStream(); _ = try await h.broker.accept(control:control(),stream:input); await h.broker.fail(.transport); await h.broker.fail(.transport); #expect(input.closes == 1); #expect(h.connector.stream.closes == 1); await denied(h,control(sequence:2),expected:.terminal)
    }
    @Test func opaque_partial_io_backpressure_and_bidirectional_eof() async throws {
        let payload = Data([0,255,1,2,3,4,5,6]); let input = MemoryStream([payload]), output = MemoryStream([Data([128,1])]); output.partial = 2; input.partial = 1
        let h = try Harness(connector:FakeConnector(stream:output)); let t = try await h.broker.accept(control:control(),stream:input); try await t.run(); #expect(output.written == payload); #expect(input.written == Data([128,1])); #expect(input.maxRead <= 4096); #expect(output.maxWrite <= 4096); #expect(input.ends == 1 && output.ends == 1); #expect(input.closes == 1 && output.closes == 1); #expect(await h.broker.activeCount == 0)
    }
    @Test func byte_limit_aggregate_and_oversized_read_fail() async throws {
        for (payload,limit) in [(Data(repeating:1,count:11),10),(Data(repeating:1,count:4097),10000)] { let h = try Harness(bytes:limit); let t = try await h.broker.accept(control:control(),stream:MemoryStream([payload])); do { try await t.run(); Issue.record("Unbounded stream") } catch { #expect(error as? BrokerFailure == .limits) }; #expect(h.connector.stream.written.isEmpty) }
    }
    @Test func stream_failure_and_zero_progress_sanitized() async throws {
        for mode in ["read","write","zero"] { let input = MemoryStream([Data([1])]), output = MemoryStream(); input.badRead = mode == "read"; output.badWrite = mode == "write"; if mode == "zero" { output.partial = 0 }; let h = try Harness(connector:FakeConnector(stream:output)); let t = try await h.broker.accept(control:control(),stream:input); do { try await t.run(); Issue.record("Stream failure ignored") } catch { #expect(error as? BrokerFailure == .transport) }; #expect(input.closes == 1); #expect(output.closes == 1); await denied(h,control(sequence:2),expected:.terminal) }
    }
    @Test func release_only_nominal_signature_binding_time_and_context() throws {
        let f = try Self.fixture(), bytes = try Self.candidate(f), a = try Self.authority(f); let release = try ReceiptVerifier.verifyRelease(bytes,authority:a,atWallTime:160)
        #expect(ReceiptVerifier.inspectRelease(release,authority:try Self.authority(f),atWallTime:160) == nil)
        for time in [99,200,-1,9007199254740992] { #expect(throws:(any Error).self) { _ = try ReceiptVerifier.verifyRelease(bytes,authority:Self.authority(f),atWallTime:time) } }
        #expect(ReceiptVerifier.inspectRelease(release,authority:a,atWallTime:200) == nil)
        let rows = try #require(f["negative"] as? [[String:Any]])
        for row in rows where row["kind"] as? String == "RELEASE_RECEIPT" { let data = Data(try #require(row["json"] as? String).utf8); let wall = try #require(row["clock"] as? Int); #expect(throws:(any Error).self,"\(row["name"]!)") { _ = try ReceiptVerifier.verifyRelease(data,authority:Self.authority(f),atWallTime:wall) } }
        #expect(throws:(any Error).self) { _ = try ReceiptVerifier.verifyRelease(bytes,authority:Self.authority(f,maxAge:10),atWallTime:160) }
        #expect(throws:(any Error).self) { _ = try ReceiptVerifier.verifyRelease(bytes,authority:Self.authority(f,notBefore:101),atWallTime:160) }
    }
    @Test func numeric_sockaddr_family_port_scope_and_no_hostname() throws {
        let v4 = try NumericSocketAddress(address:NumericAddress("8.8.8.8"),port:443), v6 = try NumericSocketAddress(address:NumericAddress("2001:4860::8888"),port:443)
        #expect(v4.family == AF_INET); #expect(v6.family == AF_INET6); #expect(v4.port == 443 && v6.port == 443); #expect(v6.scopeID == 0); #expect(!v4.bytes.isEmpty && !v6.bytes.isEmpty)
        #expect(throws:(any Error).self) { _ = try NumericSocketAddress(address:NumericAddress("8.8.8.8"),port:80) }
    }
    @Test func no_console_inheritance_no_ambient_authority() throws {
        let inventory: [BrokerDescriptor] = (0...35).map { fd in
            let role: BrokerDescriptor.Role
            if fd < 3 { role = .null } else if fd == 3 { role = .bootstrap } else if fd % 2 == 0 { role = .relayRead } else { role = .relayWrite }
            return BrokerDescriptor(fd:Int32(fd),role:role)
        }
        try BrokerBootstrap.audit(inventory,arguments:[],environment:[:])
        for role in [BrokerDescriptor.Role.terminal,.console,.privateEvidence,.other] { #expect(throws:(any Error).self) { try BrokerBootstrap.audit(inventory + [BrokerDescriptor(fd:36,role:role)],arguments:[],environment:[:]) } }
        #expect(throws:(any Error).self) { try BrokerBootstrap.audit(inventory,arguments:["https://evil.example"],environment:[:]) }
        #expect(throws:(any Error).self) { try BrokerBootstrap.audit(inventory,arguments:[],environment:["OWNER_PASSWORD":"PRIVATE_CANARY"]) }
        #expect(throws:(any Error).self) { try BrokerBootstrap.audit(Array(inventory.dropLast()),arguments:[],environment:[:]) }
    }
}

private actor PendingResolver: Resolver {
    var pending = [CheckedContinuation<[NumericAddress], any Error>]()
    func resolve(host: String) async throws -> [NumericAddress] { try await withCheckedThrowingContinuation { pending.append($0) } }
    var count: Int { pending.count }
    func complete() throws { let cs = pending; pending = []; let a = try NumericAddress("8.8.8.8"); cs.forEach { $0.resume(returning:[a]) } }
}
extension BrokerTests {
    @Test func mandatory_manifest_config_and_exact_release_destinations() throws {
        for identity in ["", "bad", String(repeating:"B",count:64)] { #expect(throws:(any Error).self) { _ = try Harness(manifestIdentity:identity) } }
        for config in ["",String(repeating:"b",count:64)] { #expect(throws:(any Error).self) { _ = try Harness(configIdentity:config) } }
        for origins: [Destination:String] in [[:],[.frontend:"https://evil.test",.backend:"https://backend.example.test"],[.frontend:"https://frontend.example.test.",.backend:"https://backend.example.test"]] { #expect(throws:(any Error).self) { _ = try Harness(origins:origins) } }
    }
    @Test func pending_idle_deadline_and_immediate_cancellation() async throws {
        for mode in ["idle","run","cancel"] {
            let d = Deferred<[NumericAddress]>(), input = MemoryStream(); let r = try FakeResolver([NumericAddress("8.8.8.8")],deferred:d), h = try Harness(resolver:r)
            let task = Task { try await h.broker.accept(control:control(),stream:input) }; await d.waitEntered()
            if mode == "cancel" { task.cancel() } else {
                await h.clock.waitForWaiters(2)
                #expect(h.clock.waitCount > 0,"Pending admission lacks deadline watch")
                h.clock.set(160,mode == "idle" ? 30 : 40); h.clock.tick()
            }
            for _ in 0..<1000 { let count = await h.broker.activeCount; if input.closes > 0 && count == 0 { break }; await Task.yield() }
            #expect(input.closes == 1,"Pending resources were not closed before late completion")
            #expect(await h.broker.activeCount == 0)
            await d.finish(r.addresses); do { _ = try await task.value; Issue.record("Pending admission revived") } catch { if mode == "idle" { #expect(error is SlotEnded) } }
            #expect(h.connector.calls.isEmpty)
            if mode == "idle" {
                // P38(b): an idle pending slot ends only itself; its guest stream gets a logical
                // EOF before it closes, and the run admits the next stream.
                #expect(input.ends == 1)
                let next = try await h.broker.accept(control:control(sequence:2),stream:MemoryStream()); next.close()
            }
        }
    }
    @Test func sixteen_simultaneous_pending_no_connector_and_single_cleanup() async throws {
        let h = try Harness(), resolver = PendingResolver()
        let b = try EgressBroker(release:h.release,authority:h.authority,binding:h.binding,limits:BrokerLimits(bytes:10000,idleMs:20),resolver:resolver,connector:h.connector,clock:h.clock)
        var tasks = [Task<Tunnel, any Error>](), inputs = [MemoryStream]()
        for n in 1...16 { let input = MemoryStream(); inputs.append(input); tasks.append(Task { try await b.accept(control:control(sequence:n),stream:input) }); for _ in 0..<1000 { if await resolver.count == n { break }; await Task.yield() } }
        #expect(await b.activeCount == 16); do { _ = try await b.accept(control:control(sequence:17),stream:MemoryStream()); Issue.record("17th pending admission") } catch { #expect(error as? BrokerFailure == .capacity) }
        await b.fail(.transport); await b.fail(.transport); try await resolver.complete()
        for task in tasks { do { _ = try await task.value; Issue.record("Late pending revived") } catch {} }
        #expect(inputs.allSatisfy { $0.closes == 1 }); #expect(h.connector.calls.isEmpty); #expect(await b.activeCount == 0)
    }
    @Test func sequential_tunnels_release_capacity_aggregate_budget_persists() async throws {
        let h = try Harness(bytes:10)
        let first = try await h.broker.accept(control:control(),stream:MemoryStream([Data(repeating:1,count:6)])); try await first.run(); #expect(await h.broker.activeCount == 0)
        let second = try await h.broker.accept(control:control(sequence:2),stream:MemoryStream([Data(repeating:2,count:5)])); do { try await second.run(); Issue.record("Aggregate byte budget reset") } catch { #expect(error as? BrokerFailure == .limits) }; #expect(await h.broker.activeCount == 0)
    }
    @Test func stalled_stream_idle_deadline_and_run_cancellation() async throws {
        // An idle slot now closes only itself (T9-2, P38): idle_slot_closes_only_itself_and_run_continues.
        // The run deadline and cancellation stay whole-run.
        for mode in ["deadline","cancel"] {
            let d = Deferred<Data>(), input = MemoryStream(delayed:d), h = try Harness(); let t = try await h.broker.accept(control:control(),stream:input)
            let task = Task { try await t.run() }; await d.waitEntered()
            if mode == "cancel" { task.cancel() } else {
                await h.clock.waitForWaiters(2)
                h.clock.set(160,40); h.clock.tick()
            }
            for _ in 0..<1000 { let count = await h.broker.activeCount; if input.closes > 0 && count == 0 { break }; await Task.yield() }
            #expect(input.closes == 1); #expect(await h.broker.activeCount == 0)
            await d.finish(Data([1])); do { try await task.value; Issue.record("Stalled stream resumed") } catch {}
            #expect(h.connector.stream.written.isEmpty)
        }
    }
}

private final class BufferedStream: ByteStream, @unchecked Sendable {
    let lock = NSLock(); var bytes:Data, output = Data(); private var closeCount = 0; var partial = 1
    var closes: Int { lock.withLock { closeCount } }
    init(_ bytes:Data) { self.bytes = bytes }
    func read(maxBytes:Int) async throws -> Data { lock.withLock { let n = min(partial,maxBytes,bytes.count), d = Data(bytes.prefix(n)); bytes.removeFirst(n); return d } }
    func write(_ data:Data) async throws -> Int { lock.withLock { let n = min(partial,data.count); output.append(data.prefix(n)); return n } }
    func endWrite() async throws {}
    func close() { lock.withLock { closeCount += 1 } }
}
private final class FakeNative: NativeSocketCalls, NativeResolverCalls, @unchecked Sendable {
    let lock = NSLock(); var queries = [(String,Int32,Int32,Int32)](), addresses = ["8.8.8.8"]
    var opened = [Int32](), configured = [Int32](), protected = [Int32](), connected = [NumericSocketAddress](), ends = [Int32](), waits = 0
    private var closedFDs = [Int32]()
    var closed: [Int32] { lock.withLock { closedFDs } }
    var failure = "", pending = false
    var waitGate: Deferred<Void>?
    let closeEvent = MemoryEvent()
    var resolverGate: Deferred<[String]>?
    let resolverCancelled = MemoryEvent()
    func check(_ operation:String) throws { if failure == operation { throw NSError(domain:"PRIVATE_NATIVE_CANARY",code:1) } }
    func resolve(query:String,family:Int32,socketType:Int32,flags:Int32) async throws -> [String] {
        let result = try lock.withLock {
            queries.append((query,family,socketType,flags))
            try check("resolve")
            return addresses
        }
        if let resolverGate {
            return try await withTaskCancellationHandler {
                try await resolverGate.get()
            } onCancel: {
                self.resolverCancelled.signal()
            }
        }
        return result
    }
    func open(family:Int32) throws -> Int32 { try lock.withLock { try check("open"); opened.append(family); return 91 } }
    func configure(fd:Int32) throws { try lock.withLock { configured.append(fd); try check("configure") } }
    func protectFromSIGPIPE(fd:Int32) throws { try lock.withLock { protected.append(fd); try check("protect") } }
    func connect(fd:Int32,address:NumericSocketAddress) throws -> Bool { try lock.withLock { connected.append(address); try check("connect"); return !pending } }
    func finishConnect(fd:Int32) throws -> Bool { try lock.withLock { try check("finish"); return true } }
    func read(fd:Int32,maxBytes:Int) throws -> Data? { try lock.withLock { try check("read"); return Data() } }
    func write(fd:Int32,data:Data) throws -> Int? { try lock.withLock { try check("write"); return data.count } }
    func endWrite(fd:Int32) throws { try lock.withLock { ends.append(fd); try check("end") } }
    func close(fd:Int32) { lock.withLock { closedFDs.append(fd) }; closeEvent.signal() }
    func wait() async throws { try lock.withLock { waits += 1; try check("wait") }; if let waitGate { try await waitGate.get() } }
}
extension BrokerTests {
    private func record(_ bytes:Data) -> Data { let n = UInt16(bytes.count); return Data([UInt8(n >> 8),UInt8(n & 255)]) + bytes }
    @Test func native_resolver_absolute_query_flags_and_sanitized_error() async throws {
        let native = FakeNative(), resolver = NativeResolver(native:native)
        _ = try await resolver.resolve(host:"frontend.example.test")
        #expect(native.queries.first?.0 == "frontend.example.test."); #expect(native.queries.first?.1 == AF_UNSPEC); #expect(native.queries.first?.2 == SOCK_STREAM); #expect(native.queries.first?.3 == AI_ADDRCONFIG | AI_NUMERICSERV)
        native.failure = "resolve"; do { _ = try await resolver.resolve(host:"backend.example.test"); Issue.record("Native failure ignored") } catch { #expect(error as? BrokerFailure == .transport) }
    }
    @Test func native_connector_numeric_sockaddr_flags_pending_and_fd_ownership() async throws {
        for text in ["8.8.8.8","2001:4860::8888"] {
            let native = FakeNative(); native.pending = true; let connector = NativeConnector(native:native)
            let stream = try await connector.connect(address:NumericAddress(text),port:443)
            #expect(native.configured == [91]); #expect(native.protected == [91]); #expect(native.waits == 1); #expect(native.connected.count == 1)
            let a = try #require(native.connected.first); #expect(a.bytes[2] == 1 && a.bytes[3] == 187); #expect(a.scopeID == 0); #expect(native.queries.isEmpty)
            stream.close(); stream.close(); #expect(native.closed == [91])
        }
        for failure in ["configure","protect","connect","finish"] {
            let native = FakeNative(); native.failure = failure; native.pending = true
            do { _ = try await NativeConnector(native:native).connect(address:NumericAddress("8.8.8.8"),port:443); Issue.record("Native failure ignored") } catch { #expect(error as? BrokerFailure == .transport) }
            #expect(native.closed == [91])
        }
        let native = FakeNative(); do { _ = try await NativeConnector(native:native).connect(address:NumericAddress("10.0.0.1"),port:443); Issue.record("Private native connector input") } catch {}; #expect(native.opened.isEmpty)
    }
    @Test func native_stream_failures_never_expose_raw_error_and_close_once() async throws {
        for failure in ["read","write","end"] { let native = FakeNative(), stream = try DescriptorStream(fd:91,native:native); native.failure = failure
            do { if failure == "read" { _ = try await stream.read(maxBytes:4096) } else if failure == "write" { _ = try await stream.write(Data([1])) } else { try await stream.endWrite() }; Issue.record("Native I/O failure ignored") } catch { #expect(error as? BrokerFailure == .transport) }
            stream.close(); stream.close(); #expect(native.closed == [91])
        }
    }
    @Test func descriptor_native_facts_direction_uid_tty_duplicates_and_inventory() throws {
        let facts: [DescriptorFacts] = (0...35).map { fd in
            let kind: DescriptorFacts.Kind = fd < 3 ? .null : .pipe
            let direction: Int32
            if fd < 3 { direction = O_RDWR } else if fd == 3 || fd % 2 == 0 { direction = O_RDONLY } else { direction = O_WRONLY }
            return DescriptorFacts(fd:Int32(fd),kind:kind,direction:direction,uid:501,device:1,inode:UInt64(fd < 3 ? 0 : fd),tty:false)
        }
        try BrokerBootstrap.auditFacts(facts,uid:501,arguments:[],environment:[:])
        for altered in [DescriptorFacts(fd:3,kind:.other,direction:O_RDONLY,uid:501,device:1,inode:3,tty:false),DescriptorFacts(fd:3,kind:.pipe,direction:O_WRONLY,uid:501,device:1,inode:3,tty:false),DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:0,device:1,inode:3,tty:false),DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:501,device:1,inode:3,tty:true),DescriptorFacts(fd:3,kind:.pipe,direction:O_RDONLY,uid:501,device:1,inode:4,tty:false)] {
            var bad = facts; bad[3] = altered; #expect(throws:(any Error).self) { try BrokerBootstrap.auditFacts(bad,uid:501,arguments:[],environment:[:]) }
        }
        #expect(throws:(any Error).self) { try BrokerBootstrap.auditFacts(Array(facts.dropLast()),uid:501,arguments:[],environment:[:]) }
    }
    @Test func relay_partial_framing_logical_eof_reuse_and_old_generation() async throws {
        let n1 = brokerNonce(1), n2 = brokerNonce(2), p1 = proofFor(control(),n1), p2 = proofFor(control("BACKEND",sequence:2),n2)
        let physical = BufferedStream(record(control()) + record(p1) + record(Data([0,255,1])) + record(Data()) + record(control("BACKEND",sequence:2)) + record(p2) + record(Data()))
        let channel = RelayChannel(physical:physical,nonces:CountingBrokerNonces(start:1)), first = try await channel.next()
        #expect(first.control == control()); #expect(first.nonce == n1); #expect(first.proof == p1)
        #expect(try await first.stream.read(maxBytes:4096) == Data([0,255,1])); #expect(try await first.stream.read(maxBytes:4096) == Data()); #expect(try await first.stream.write(Data([7,8])) == 2); try await first.stream.endWrite(); first.stream.close()
        let second = try await channel.next(); #expect(second.control == control("BACKEND",sequence:2)); #expect(second.nonce == n2); #expect(second.proof == p2)
        #expect(try await second.stream.read(maxBytes:4096) == Data()); try await second.stream.endWrite(); second.stream.close()
        // C4: each stream's challenge frame (length 16, then the nonce) precedes what the host writes on it.
        #expect(physical.output == record(n1) + record(Data([7,8])) + record(Data()) + record(n2) + record(Data())); #expect(physical.closes == 0)
        do { _ = try await first.stream.write(Data([9])); Issue.record("Old generation wrote into next tunnel") } catch { #expect(error as? BrokerFailure == .terminal) }
    }
    @Test func relay_oversize_partial_physical_loss_and_no_early_reuse() async throws {
        let nonces = CountingBrokerNonces(start:10)
        // A control outside 1...256 bytes or a proof frame that is not exactly 32 bytes is a protocol violation.
        for data in [Data([0,0]),record(Data(repeating:1,count:257)),record(control()) + record(Data(repeating:1,count:31)) + Data(repeating:0,count:64),record(control()) + Data([0,33]),record(control()) + Data([0,0])] {
            do { _ = try await RelayChannel(physical:BufferedStream(data),nonces:nonces).next(); Issue.record("Malformed setup framing") } catch { #expect(error as? BrokerFailure == .invalidControl) }
        }
        // P38(c): a physical EOF before or inside the setup ends that lane only, never as a run failure code.
        for data in [Data(),Data([0]),record(control()),record(control()) + Data([0,32,1])] {
            do { _ = try await RelayChannel(physical:BufferedStream(data),nonces:nonces).next(); Issue.record("Truncated setup admitted") } catch { #expect(error is GuestStreamClosed) }
        }
        let n = brokerNonce(20)
        let physical = BufferedStream(record(control()) + record(proofFor(control(),n)) + record(Data(repeating:1,count:4097))), channel = RelayChannel(physical:physical,nonces:ConstantBrokerNonces(n)), request = try await channel.next()
        do { _ = try await request.stream.read(maxBytes:4096); Issue.record("Oversized opaque record") } catch { #expect(error as? BrokerFailure == .limits) }
        do { _ = try await channel.next(); Issue.record("Relay reused before both EOF") } catch { #expect(error as? BrokerFailure == .terminal) }
        // A physical EOF inside a record is never a logical EOF. It ends only that lane (P38(c)).
        let lost = RelayChannel(physical:BufferedStream(record(control()) + record(proofFor(control(),n)) + Data([0,2,1])),nonces:ConstantBrokerNonces(n)), current = try await lost.next()
        do { _ = try await current.stream.read(maxBytes:4096); Issue.record("Partial physical EOF mistaken for logical EOF") } catch { #expect(error is GuestStreamClosed) }
        current.stream.close()
        do { _ = try await lost.next(); Issue.record("Lane reused after the guest's physical close") } catch { #expect(error is GuestStreamClosed) }
    }
}

extension BrokerTests {
    private func bootstrapBytes(_ values:[Int] = [100,0,300,190,10000,20,30,1]) throws -> Data {
        let f = try Self.fixture(), options = try #require(f["options"] as? [String:Any]), expected = try #require(options["expected"] as? [String:[String:Any]]), keys = try #require(options["publicKeys"] as? [String:String])
        var template = try #require(expected["RELEASE_RECEIPT"]), p = try #require(template["payload"] as? [String:Any]); p["issuedAt"] = 0; p["expiresAt"] = 1; p["keyId"] = String(repeating:"0",count:64); p["signature"] = String(repeating:"0",count:128); template["payload"] = p
        var data = Data("ABR1".utf8) + record(try JSONSerialization.data(withJSONObject:template)) + record(try Self.candidate(f))
        data += Self.hex(try #require(keys["RELEASE_RECEIPT"])); data += Data(repeating:0x11,count:16); data += Data(repeating:7,count:32); data += Data(repeating:0xbb,count:32); data += Data(repeating:0xaa,count:32)
        for number in values { let n = UInt64(number).bigEndian; data.append(withUnsafeBytes(of:n) { Data($0) }) }; return data
    }
    @Test func bootstrap_exact_finite_fields_no_extra_magic_truncation_and_bound() throws {
        let bytes = try bootstrapBytes(), configuration = try BootstrapConfiguration.decode(bytes)
        #expect(configuration.binding.runID == Self.runID); #expect(configuration.binding.manifest.identity == String(repeating:"b",count:64)); #expect(configuration.binding.configIdentity == String(repeating:"a",count:64)); #expect(configuration.binding.capability.count == 32)
        _ = try configuration.makeBroker(resolver:FakeResolver([NumericAddress("8.8.8.8")]),connector:FakeConnector(),clock:FakeClock(),physicalChannels:[])
        var magic = bytes; magic[0] = 0
        for bad in [magic,bytes + Data([0]),Data(bytes.dropLast()),Data(repeating:0,count:32769)] { #expect(throws:(any Error).self) { _ = try BootstrapConfiguration.decode(bad) } }
        for values in [[0,0,300,190,10000,20,30,1],[100,0,300,190,0,20,30,1],[100,0,300,190,10000,0,30,1],[100,0,300,190,10000,20,0,1],[100,0,300,190,10000,20,30,0]] { #expect(throws:(any Error).self) { _ = try BootstrapConfiguration.decode(bootstrapBytes(values)) } }
    }
    @Test func bootstrap_in_memory_partial_intake_eof_no_private_authority() async throws {
        let bytes = try bootstrapBytes(), count = UInt32(bytes.count), header = Data([UInt8(count >> 24),UInt8((count >> 16) & 255),UInt8((count >> 8) & 255),UInt8(count & 255)])
        let stream = BufferedStream(header + bytes), configuration = try await BrokerBootstrap.load(stream:stream,clock:FakeClock(),timeoutMs:100)
        #expect(configuration.binding.runID == Self.runID); #expect(stream.closes == 1)
        for bad in [Data(),Data([0,0,0]),Data([0,0,128,1]),header + Data(bytes.dropLast()),header + bytes + Data([1])] {
            do { _ = try await BrokerBootstrap.load(stream:BufferedStream(bad),clock:FakeClock(),timeoutMs:100); Issue.record("Bad bootstrap intake accepted") } catch { #expect(error as? BrokerFailure != nil) }
        }
    }
}

extension BrokerTests {
    @Test func overall_deadline_closes_physical_channels_without_active_slots() async throws {
        for completed in [false,true] {
            let h = try Harness(), physical = MemoryStream()
            let b = try EgressBroker(release:h.release,authority:h.authority,binding:h.binding,limits:h.binding.manifest.limits,resolver:h.resolver,connector:h.connector,clock:h.clock,physicalChannels:[physical])
            if completed { let t = try await b.accept(control:control(),stream:MemoryStream()); try await t.run() }
            await h.clock.waitForWaiters(2)
            h.clock.set(190,40); h.clock.tick()
            for _ in 0..<1000 { if physical.closes > 0 { break }; await Task.yield() }
            #expect(physical.closes == 1); #expect(await b.activeCount == 0)
            await b.fail(.transport); #expect(physical.closes == 1)
        }
    }
    @Test func twenty_minute_manifest_duration_and_wall_window_maximum() throws {
        #expect(throws:(any Error).self) { _ = try Harness(duration:1200001) }
        #expect(throws:(any Error).self) { _ = try Harness(expiry:1200161) }
        _ = try Harness(duration:1200000,expiry:1200160)
    }
    @Test func release_max_age_watchdog_uses_exact_current_authority_window() async throws {
        let h = try Harness(releaseMaxAge:70), d = Deferred<[NumericAddress]>(), r = try FakeResolver([NumericAddress("8.8.8.8")],deferred:d)
        let b = try EgressBroker(release:h.release,authority:h.authority,binding:h.binding,limits:h.binding.manifest.limits,resolver:r,connector:h.connector,clock:h.clock)
        let task = Task { try await b.accept(control:control(),stream:MemoryStream()) }; await d.waitEntered()
        await h.clock.waitForWaiters(2)
        #expect(h.clock.durations.contains { $0 <= 11 },"Release max-age expires at171 and must bound sleep")
        h.clock.set(171,21); h.clock.tick(); await d.finish(r.addresses)
        do { _ = try await task.value; Issue.record("Authority expired during DNS") } catch {}; #expect(h.connector.calls.isEmpty)
    }
    @Test func bootstrap_timeout_disposes_before_late_in_memory_completion() async throws {
        let d = Deferred<Data>(), stream = MemoryStream(delayed:d), clock = FakeClock()
        let task = Task { try await BrokerBootstrap.load(stream:stream,clock:clock,timeoutMs:100) }; await d.waitEntered()
        await clock.waitForWaiters(1)
        clock.tick(); for _ in 0..<1000 { if stream.closes > 0 { break }; await Task.yield() }
        #expect(stream.closes > 0); await d.finish(Data())
        do { _ = try await task.value; Issue.record("Late bootstrap resumed") } catch { #expect(error as? BrokerFailure == .bootstrap) }
    }
    @Test func native_pending_connection_cancellation_closes_once() async throws {
        let native = FakeNative(), gate = Deferred<Void>(); native.pending = true; native.waitGate = gate
        let task = Task { try await NativeConnector(native:native).connect(address:NumericAddress("8.8.8.8"),port:443) }; await gate.waitEntered(); task.cancel()
        for _ in 0..<1000 { if native.closed.count > 0 { break }; await Task.yield() }
        #expect(native.closed == [91]); await gate.finish(())
        do { _ = try await task.value; Issue.record("Cancelled native connection returned") } catch { #expect(error as? BrokerFailure == .cancelled) }; #expect(native.closed == [91])
    }
}

extension BrokerTests {
    @Test func resolver_transport_failure_is_terminal_no_later_admission() async throws {
        let d = Deferred<[NumericAddress]>(), r = try FakeResolver([NumericAddress("8.8.8.8")],deferred:d), input = MemoryStream(), h = try Harness(resolver:r)
        let task = Task { try await h.broker.accept(control:control(),stream:input) }; await d.waitEntered(); await d.fail()
        do { _ = try await task.value; Issue.record("Resolver error ignored") } catch { #expect(error as? BrokerFailure == .transport) }
        #expect(input.closes == 1); await denied(h,control(sequence:2),expected:.terminal); #expect(h.connector.calls.isEmpty)
    }
    @Test func bootstrap_timeout_close_ownership_exactly_once() async throws {
        let d = Deferred<Data>(), stream = MemoryStream(delayed:d), clock = FakeClock()
        let task = Task { try await BrokerBootstrap.load(stream:stream,clock:clock,timeoutMs:100) }; await d.waitEntered(); await clock.waitForWaiters(1); clock.tick()
        for _ in 0..<1000 { if stream.closes > 0 { break }; await Task.yield() }; await d.finish(Data())
        do { _ = try await task.value; Issue.record("Late bootstrap admitted") } catch {}; #expect(stream.closes == 1)
    }
}

extension BrokerTests {
    private func replacementBroker(
        _ h: Harness,
        resolver: any Resolver,
        connector: any Connector,
        clock: (any BrokerClock)? = nil,
        physical: [any ByteStream] = []
    ) throws -> EgressBroker {
        try EgressBroker(
            release: h.release,
            authority: h.authority,
            binding: h.binding,
            limits: h.binding.manifest.limits,
            resolver: resolver,
            connector: connector,
            clock: clock ?? h.clock,
            physicalChannels: physical
        )
    }

    @Test func broker_owns_pending_native_fd_on_fail_idle_run_and_release_expiry() async throws {
        for mode in ["fail", "idle", "run", "release"] {
            let h = try Harness(releaseMaxAge: mode == "release" ? 70 : 100)
            await h.broker.fail(.terminal)
            let native = FakeNative()
            let gate = Deferred<Void>()
            native.pending = true
            native.waitGate = gate
            let physical = ObservedMemoryStream()
            let broker = try replacementBroker(
                h, resolver: h.resolver, connector: NativeConnector(native: native),
                physical: [physical]
            )
            let input = MemoryStream()
            let admission = Task { try await broker.accept(control: control(), stream: input) }
            await gate.waitEntered()
            await h.clock.waitForWaiters(2)
            if mode == "fail" {
                await broker.fail(.transport)
            } else if mode == "idle" {
                // P38: an idle pending slot ends only itself; the physical channels stay open.
                h.clock.set(180, 30)
                h.clock.tick()
                await native.closeEvent.wait()
                do { _ = try await admission.value; Issue.record("Idle admission returned a tunnel") }
                catch { #expect(error is SlotEnded) }
            } else {
                if mode == "run" { h.clock.set(190, 40) }
                if mode == "release" { h.clock.set(171, 21) }
                h.clock.tick()
                await physical.closed.wait()
            }
            #expect(native.closed == [91], "Pending FD must close before fake native completion: \(mode)")
            #expect(await broker.activeCount == 0)
            if native.closed.isEmpty {
                // Only RED cleanup releases the noncooperative native callback.
                await gate.finish(())
            }
            if mode != "idle" {
                do { _ = try await admission.value; Issue.record("Cancelled admission returned a tunnel") }
                catch { #expect(error as? BrokerFailure != nil) }
            }
            if !native.closed.isEmpty { await gate.finish(()) }
            #expect(native.closed == [91])
            #expect(input.closes == 1)
            #expect(input.ends == (mode == "idle" ? 1 : 0))
            #expect(physical.base.closes == (mode == "idle" ? 0 : 1))
            await broker.fail(.transport)
            #expect(native.closed == [91])
            #expect(physical.base.closes == 1)
        }
    }

    @Test func broker_cancels_nonreturning_native_resolver_before_late_callback() async throws {
        for expired in [false, true] {
            let h = try Harness()
            await h.broker.fail(.terminal)
            let native = FakeNative()
            let gate = Deferred<[String]>()
            native.resolverGate = gate
            let physical = ObservedMemoryStream()
            let broker = try replacementBroker(
                h, resolver: NativeResolver(native: native), connector: h.connector,
                physical: [physical]
            )
            let input = MemoryStream()
            let admission = Task { try await broker.accept(control: control(), stream: input) }
            await gate.waitEntered()
            await h.clock.waitForWaiters(2)
            if expired {
                h.clock.set(190, 40)
                h.clock.tick()
                await physical.closed.wait()
            } else { await broker.fail(.transport) }
            #expect(native.resolverCancelled.isSignalled)
            if !native.resolverCancelled.isSignalled { await gate.finish(["8.8.8.8"]) }
            do { _ = try await admission.value; Issue.record("Late resolver revived admission") }
            catch { #expect(error as? BrokerFailure != nil) }
            if native.resolverCancelled.isSignalled { await gate.finish(["8.8.8.8"]) }
            #expect(h.connector.calls.isEmpty)
            #expect(input.closes == 1)
        }
    }

    @Test func already_cancelled_native_connector_does_not_open_or_connect() async throws {
        let native = FakeNative()
        let start = Deferred<Void>()
        let task = Task {
            try await start.get()
            return try await NativeConnector(native: native).connect(address: NumericAddress("8.8.8.8"), port: 443)
        }
        await start.waitEntered()
        task.cancel()
        await start.finish(())
        do { _ = try await task.value; Issue.record("Already cancelled connector succeeded") }
        catch { #expect(error as? BrokerFailure == .cancelled) }
        #expect(native.opened.isEmpty)
        #expect(native.connected.isEmpty)
        #expect(native.closed.isEmpty)
    }

    @Test func already_cancelled_native_resolver_does_not_query() async throws {
        let native = FakeNative()
        let start = Deferred<Void>()
        let task = Task {
            try await start.get()
            return try await NativeResolver(native: native).resolve(host: "frontend.example.test")
        }
        await start.waitEntered()
        task.cancel()
        await start.finish(())
        do { _ = try await task.value; Issue.record("Already cancelled resolver succeeded") }
        catch { #expect(error as? BrokerFailure == .cancelled) }
        #expect(native.queries.isEmpty, "No native lookup may start from an already cancelled caller")
    }

    @Test func relay_supervision_cancels_sibling_on_first_error_before_drain() async throws {
        let h = try Harness()
        await h.broker.fail(.terminal)
        let losingGate = Deferred<Data>()
        let siblingGate = Deferred<Data>()
        let losing = ObservedMemoryStream(readGate: losingGate)
        let sibling = ObservedMemoryStream(readGate: siblingGate)
        let broker = try replacementBroker(h, resolver: h.resolver, connector: h.connector, physical: [losing, sibling])
        let task = Task { try await BrokerExecutable.runRelays(broker: broker, physical: [losing, sibling], nonces: CountingBrokerNonces()) }
        await losingGate.waitEntered()
        await siblingGate.waitEntered()
        // A control length whose first byte is 02 (at least 512) is a protocol violation. (A physical
        // EOF here would end only that lane, P38(c): relay_guest_close_ends_only_its_lane_and_all_lanes_gone_fails_run.)
        await losingGate.finish(Data([2]))
        await sibling.closed.wait()
        await sibling.cancelled.wait()
        #expect(sibling.cancelled.isSignalled, "First child failure must cancel pending sibling before waitForAll drains")
        await siblingGate.finish(Data())
        do { try await task.value; Issue.record("Failed relay supervision succeeded") }
        catch { #expect(error as? BrokerFailure != nil) }
        #expect(losing.base.closes == 1)
        #expect(sibling.base.closes == 1)
    }

    @Test func unexpected_clock_cancellation_error_fails_global_physical_lifetime() async throws {
        let h = try Harness()
        await h.broker.fail(.terminal)
        let clock = UnexpectedWaitClock(errorIndex: 1)
        let physical = ObservedMemoryStream()
        let broker = try replacementBroker(h, resolver: h.resolver, connector: h.connector, clock: clock, physical: [physical])
        await clock.errorGate.waitEntered()
        await clock.errorGate.finish(())
        await clock.returnedError.wait()
        await physical.closed.wait()
        #expect(physical.base.closes == 1, "Unexpected CancellationError is a clock failure")
        await broker.fail(.transport)
        #expect(physical.base.closes == 1)
        do { _ = try await broker.accept(control: control(), stream: MemoryStream()); Issue.record("Clock failure resumed") }
        catch { #expect(error as? BrokerFailure == .terminal) }
    }

    @Test func unexpected_clock_cancellation_error_fails_pending_slot_lifetime() async throws {
        let h = try Harness()
        await h.broker.fail(.terminal)
        let clock = UnexpectedWaitClock(errorIndex: 2)
        let native = FakeNative()
        let gate = Deferred<Void>()
        native.pending = true
        native.waitGate = gate
        let input = MemoryStream()
        let physical = ObservedMemoryStream()
        let broker = try replacementBroker(h, resolver: h.resolver, connector: NativeConnector(native: native), clock: clock, physical: [physical])
        await clock.regular.waitForWaiters(1)
        let task = Task { try await broker.accept(control: control(), stream: input) }
        await gate.waitEntered()
        await clock.errorGate.waitEntered()
        await clock.errorGate.finish(())
        await clock.returnedError.wait()
        await physical.closed.wait()
        #expect(await broker.activeCount == 0)
        #expect(native.closed == [91])
        #expect(physical.base.closes == 1)
        let wasClosed = !native.closed.isEmpty
        await broker.fail(.transport)
        if !wasClosed { await gate.finish(()) }
        do { _ = try await task.value; Issue.record("Clock wait failure left admission usable") }
        catch { #expect(error as? BrokerFailure != nil) }
        if wasClosed { await gate.finish(()) }
        #expect(input.closes == 1)
        #expect(native.closed == [91])
    }
}

// Task 6: C4 vsock stream challenge-response (E3, R5, R6) and per-slot events (T9-2, P38).
// Reopens accepted M2 broker code under the owner's E3-A approval (R7).

// A stream whose pending read waits for deliver(_:) and is interrupted by close(), as the
// ByteStream contract requires. It records the order of endWrite and close.
private final class StallingStream: ByteStream, @unchecked Sendable {
    private let lock = NSLock()
    private var waiter: CheckedContinuation<Data, any Error>?
    private var isClosed = false, log = [String](), bytes = Data()
    let readEntered = MemoryEvent(), closed = MemoryEvent()
    var events: [String] { lock.withLock { log } }
    var written: Data { lock.withLock { bytes } }
    func read(maxBytes: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
            let shut = lock.withLock { () -> Bool in
                if isClosed { return true }
                waiter = continuation
                return false
            }
            if shut { continuation.resume(throwing: BrokerFailure.terminal) } else { readEntered.signal() }
        }
    }
    func deliver(_ data: Data) {
        let pending = lock.withLock { () -> CheckedContinuation<Data, any Error>? in defer { waiter = nil }; return waiter }
        pending?.resume(returning: data)
    }
    func write(_ data: Data) async throws -> Int { lock.withLock { bytes.append(data); log.append("write") }; return data.count }
    func endWrite() async throws { lock.withLock { log.append("endWrite") } }
    func close() {
        let pending = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            log.append("close"); isClosed = true
            defer { waiter = nil }
            return waiter
        }
        pending?.resume(throwing: BrokerFailure.terminal)
        closed.signal()
    }
}

extension BrokerTests {
    @Test func stream_proof_vector_matches_python() throws {
        // The plan author's vector, verbatim; proxy_test.py test_stream_proof_vector binds the guest.
        let key = try ChannelKeys.derive(capability: Data(repeating: 7, count: 32), label: "vsock-stream")
        #expect(hexString(key) == "5814c7147c97464dd6833b65cfd337b5d6f8277a080522efe9c3f7f498d54d00")
        #expect(VsockStreamProof.domain == Data("acceptance:vsock-stream:v1\0".utf8))
        let proof = VsockStreamProof.compute(key: key, nonce: Data((0..<16).map { UInt8($0) }),
                                             runID: "0123456789abcdef0123456789abcdef", sequence: 1)
        #expect(hexString(proof) == "564c1588db8960fb3a6748fe644fa0b4ffa9d1ca23ce8ae7d21c97020fe42e72")
    }

    @Test func forged_proof_latches_identity_before_sequence() async throws {
        // C4: the proof is compared in constant time before sequence admission. A mismatch latches
        // the whole run as identity, even where the sequence alone would be a replay.
        let n = brokerNonce(200), valid = proofFor(control(), n)
        let topology = try ChannelKeys.derive(capability: harnessCapability, label: "topology-admission")
        var flipped = valid; flipped[flipped.startIndex] ^= 1
        let forgeries: [(String, Data)] = [
            ("raw-capability", proofFor(control(), n, key: harnessCapability)),
            ("topology-key", proofFor(control(), n, key: topology)),
            ("flipped-bit", flipped), ("zeros", Data(count: 32)),
            ("short", Data(valid.prefix(31))), ("long", valid + Data([0])), ("empty", Data()),
        ]
        for (name, forged) in forgeries {
            for replayed in [false, true] {
                let h = try Harness(), input = MemoryStream()
                var first: Tunnel? = nil
                if replayed { first = try await h.broker.accept(control: control(), stream: input) }
                // Sequence 1: fresh, or (replayed) already admitted, which alone would be a replay.
                do {
                    _ = try await h.broker.accept(request: RelayRequest(control: control(), nonce: n, proof: forged, stream: MemoryStream()))
                    Issue.record("Forged proof admitted: \(name)")
                } catch { #expect(error as? BrokerFailure == .identity, "\(name)") }
                #expect(h.resolver.calls.count == (replayed ? 1 : 0))
                await denied(h, control(sequence: 2), expected: .terminal)
                if replayed { #expect(input.closes == 1, "the whole run latched") }
                first?.close()
            }
        }
    }

    @Test func replayed_proof_for_other_nonce_denied() async throws {
        // A proof recorded for one challenge never answers another, directly or through a lane.
        let a = brokerNonce(300), b = brokerNonce(301), recorded = proofFor(control(), a)
        let h = try Harness()
        do {
            _ = try await h.broker.accept(request: RelayRequest(control: control(), nonce: b, proof: recorded, stream: MemoryStream()))
            Issue.record("Replayed proof admitted")
        } catch { #expect(error as? BrokerFailure == .identity) }
        #expect(h.resolver.calls.isEmpty); #expect(h.connector.calls.isEmpty)
        let relayed = try Harness(), physical = BufferedStream(record(control()) + record(recorded))
        let request = try await RelayChannel(physical: physical, nonces: ConstantBrokerNonces(b)).next()
        #expect(physical.output == record(b)); #expect(request.nonce == b); #expect(request.proof == recorded)
        do { _ = try await relayed.broker.accept(request: request); Issue.record("Replayed proof admitted through the relay") }
        catch { #expect(error as? BrokerFailure == .identity) }
        // The proof made for b is admitted.
        let fresh = try Harness()
        let tunnel = try await fresh.broker.accept(request: RelayRequest(control: control(), nonce: b, proof: proofFor(control(), b), stream: MemoryStream()))
        tunnel.close()
    }

    @Test func proof_for_wrong_sequence_or_run_denied() async throws {
        let n = brokerNonce(400)
        for (sequence, run) in [(2, BrokerTests.runID), (0, BrokerTests.runID),
                                (1, String(repeating: "2", count: 32)), (1, String(repeating: "1", count: 31))] {
            let h = try Harness()
            let forged = VsockStreamProof.compute(key: testVsockKey, nonce: n, runID: run, sequence: sequence)
            do {
                _ = try await h.broker.accept(request: RelayRequest(control: control(), nonce: n, proof: forged, stream: MemoryStream()))
                Issue.record("Proof for sequence \(sequence) or run \(run) admitted")
            } catch { #expect(error as? BrokerFailure == .identity) }
            #expect(h.connector.calls.isEmpty)
            await denied(h, control(sequence: 2), expected: .terminal)
        }
    }

    @Test func broker_derives_vsock_key_from_bootstrap_capability() async throws {
        // R6: the host derives k_vsock from the bootstrap capability itself (there is no second,
        // "authenticated" capability). A proof under the raw capability or the topology key fails.
        let configuration = try BootstrapConfiguration.decode(try bootstrapBytes())
        #expect(configuration.binding.capability == harnessCapability)
        let topology = try ChannelKeys.derive(capability: harnessCapability, label: "topology-admission")
        for (name, key, admitted) in [("vsock-stream", testVsockKey, true), ("raw-capability", harnessCapability, false),
                                      ("topology-admission", topology, false)] {
            let broker = try configuration.makeBroker(resolver: FakeResolver([NumericAddress("8.8.8.8")]), connector: FakeConnector(),
                                                      clock: FakeClock(), physicalChannels: [])
            let n = brokerNonce(500)
            let request = RelayRequest(control: control(), nonce: n, proof: proofFor(control(), n, key: key), stream: MemoryStream())
            if admitted { let tunnel = try await broker.accept(request: request); tunnel.close() }
            else {
                do { _ = try await broker.accept(request: request); Issue.record("Proof under \(name) admitted") }
                catch { #expect(error as? BrokerFailure == .identity) }
            }
        }
    }

    @Test func repeated_challenge_nonce_latches_identity() async throws {
        // A challenge value presented twice in a run would reduce freshness to sequence-only: the
        // second presentation latches identity (fail closed), as the bootstrap challenge issuer does.
        let n = brokerNonce(600), h = try Harness()
        let first = try await h.broker.accept(request: admission(control(), MemoryStream(), nonce: n))
        do { _ = try await h.broker.accept(request: admission(control(sequence: 2), MemoryStream(), nonce: n)); Issue.record("Repeated challenge admitted") }
        catch { #expect(error as? BrokerFailure == .identity) }
        await denied(h, control(sequence: 3), expected: .terminal)
        first.close()
        // One lane with a constant nonce source: the second stream latches.
        let relayed = try Harness()
        let physical = BufferedStream(record(control()) + record(proofFor(control(), n)) + record(Data())
                                      + record(control(sequence: 2)) + record(proofFor(control(sequence: 2), n)))
        let lane = RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n))
        let tunnel = try await relayed.broker.accept(request: try await lane.next()); try await tunnel.run()
        let second = try await lane.next()
        do { _ = try await relayed.broker.accept(request: second); Issue.record("Repeated challenge admitted through the relay") }
        catch { #expect(error as? BrokerFailure == .identity) }
    }

    @Test func relay_challenge_precedes_control_and_bad_nonce_source_fails_closed() async throws {
        // C4/R5: the host writes the challenge frame before it reads anything of the stream.
        let gate = Deferred<Data>(), physical = ObservedMemoryStream(readGate: gate), n = brokerNonce(700)
        let task = Task { try await RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n)).next() }
        await gate.waitEntered()
        #expect(physical.base.output == record(n))
        await gate.fail()
        do { _ = try await task.value; Issue.record("Failed read admitted a request") } catch {}
        for source in [ConstantBrokerNonces(nil), ConstantBrokerNonces(Data(count: 15)), ConstantBrokerNonces(Data(count: 17))] {
            let quiet = BufferedStream(record(control()) + record(proofFor(control(), n)))
            do { _ = try await RelayChannel(physical: quiet, nonces: source).next(); Issue.record("Challenge without a 16-byte nonce") }
            catch { #expect(error as? BrokerFailure == .identity) }
            #expect(quiet.output.isEmpty)
        }
    }

    @Test func sequence_gaps_admitted_repeat_or_decrease_denied() async throws {
        // P38(a): strictly increasing sequences with gaps, never a repeat or a decrease. A gap is a
        // guest stream closed before its control was delivered; each sequence is used once.
        let h = try Harness(); var tunnels = [Tunnel]()
        for sequence in [2, 3, 7, 1024] { tunnels.append(try await h.broker.accept(control: control(sequence: sequence), stream: MemoryStream())) }
        #expect(h.connector.calls.count == 4); tunnels.forEach { $0.close() }
        for (admitted, next) in [([1, 3], 3), ([1, 3], 2), ([1, 3], 1), ([5], 4)] {
            let run = try Harness(); var open = [Tunnel]()
            for sequence in admitted { open.append(try await run.broker.accept(control: control(sequence: sequence), stream: MemoryStream())) }
            await denied(run, control(sequence: next), expected: .replay)
            await denied(run, control(sequence: 100), expected: .terminal)
            #expect(run.connector.calls.count == admitted.count)
            open.forEach { $0.close() }
        }
        // Below the run's first sequence is a replay as well; the first sequence itself is admitted.
        let low = try Harness(firstSequence: 5)
        await denied(low, control(sequence: 4), expected: .replay)
        let exact = try Harness(firstSequence: 5)
        let tunnel = try await exact.broker.accept(control: control(sequence: 5), stream: MemoryStream()); tunnel.close()
    }

    @Test func idle_slot_closes_only_itself_and_run_continues() async throws {
        // T9-2, P38(b): an idle slot ends only itself. Its guest stream receives a zero-length logical
        // EOF before it closes, nothing late is forwarded, and the run keeps admitting streams.
        let guestA = StallingStream(), originA = StallingStream()
        let guestB = MemoryStream([Data([1, 2])]), originB = MemoryStream([Data([9])])
        let h = try Harness(connector: FakeConnector(queued: [originA, originB]))
        let a = try await h.broker.accept(control: control(), stream: guestA)        // last progress: monotonic 10
        let runA = Task { try await a.run() }
        await guestA.readEntered.wait(); await originA.readEntered.wait()
        await h.clock.waitForWaiters(2)
        h.clock.set(160, 30); h.clock.tick()                                        // idle: 30 - 10 >= 20
        await originA.closed.wait()
        guestA.deliver(Data())                                                       // the guest's own logical EOF
        try await runA.value                                                         // a per-slot end, not a run failure
        #expect(guestA.events == ["endWrite", "close"], "the logical EOF precedes the close")
        #expect(originA.written.isEmpty); #expect(guestA.written.isEmpty)
        #expect(await h.broker.activeCount == 0)
        let b = try await h.broker.accept(control: control("BACKEND", sequence: 2), stream: guestB)
        try await b.run()
        #expect(originB.written == Data([1, 2])); #expect(guestB.written == Data([9]))
        #expect(guestB.ends == 1 && originB.ends == 1)
    }

    @Test func guest_physical_close_without_logical_eof_ends_only_its_slot() async throws {
        // P38(c): a guest stream that closes physically without its logical EOF (a per-tunnel close
        // on the guest, at a record boundary or inside a record) ends only that slot and its lane.
        for tail in [Data(), Data([0, 5, 1])] {
            let origin = StallingStream(), next = MemoryStream()
            let h = try Harness(connector: FakeConnector(queued: [origin, next]))
            let n = brokerNonce(800)
            let physical = BufferedStream(record(control()) + record(proofFor(control(), n)) + record(Data([1, 2, 3])) + tail)
            let lane = RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n))
            let tunnel = try await h.broker.accept(request: try await lane.next())
            try await tunnel.run()                                                   // not a run failure
            #expect(origin.written == Data([1, 2, 3])); #expect(origin.events == ["write", "close"])
            #expect(physical.output == record(n), "no logical EOF is written to a closed guest stream")
            do { _ = try await lane.next(); Issue.record("Lane reused after the guest's physical close") }
            catch { #expect(error is GuestStreamClosed) }
            #expect(await h.broker.activeCount == 0)
            let later = try await h.broker.accept(control: control(sequence: 2), stream: MemoryStream()); try await later.run()
        }
    }

    @Test func relay_guest_close_ends_only_its_lane_and_all_lanes_gone_fails_run() async throws {
        // P38(c) through the relay supervisor: one lane's guest closes physically; the broker and the
        // sibling lane keep running. Once every lane is gone the run fails as transport loss.
        let h = try Harness(); await h.broker.fail(.terminal)
        let n = brokerNonce(900)
        let closing = BufferedStream(record(control()) + record(proofFor(control(), n)) + record(Data([1])))
        let siblingGate = Deferred<Data>(), sibling = ObservedMemoryStream(readGate: siblingGate)
        let broker = try replacementBroker(h, resolver: h.resolver, connector: h.connector, physical: [closing, sibling])
        let task = Task { try await BrokerExecutable.runRelays(broker: broker, physical: [closing, sibling], nonces: ConstantBrokerNonces(n)) }
        await siblingGate.waitEntered()
        // The closing lane's origin closes when its slot ends; the actor then has no slot left.
        await h.connector.stream.closeEvent.wait()
        for _ in 0..<10000 { if await broker.activeCount == 0 { break }; await Task.yield() }
        #expect(await broker.activeCount == 0)
        #expect(h.connector.stream.written == Data([1])); #expect(h.connector.stream.closes > 0)
        #expect(!sibling.cancelled.isSignalled); #expect(sibling.base.closes == 0)
        let direct = try await broker.accept(control: control(sequence: 2), stream: MemoryStream()); direct.close()
        await siblingGate.finish(Data())                                             // the last lane's guest is gone too
        do { try await task.value; Issue.record("Relay supervision outlived every lane") }
        catch { #expect(error as? BrokerFailure == .transport) }
        do { _ = try await broker.accept(control: control(sequence: 3), stream: MemoryStream()); Issue.record("Run survived losing every lane") }
        catch { #expect(error as? BrokerFailure == .terminal) }
    }

    @Test func relay_lane_drains_after_host_first_close_then_reuses() async throws {
        // P38(b) on a lane: after a host-first close (logical EOF sent, stream closed) the guest's
        // remaining records of that generation are discarded up to its logical EOF, then the lane
        // carries the next stream. There, an oversized record is still a protocol violation and a
        // physical EOF ends only the lane.
        let n1 = brokerNonce(1000), n2 = brokerNonce(1001)
        let physical = BufferedStream(record(control()) + record(proofFor(control(), n1)) + record(Data([5])) + record(Data([6, 7]))
                                      + record(Data()) + record(control(sequence: 2)) + record(proofFor(control(sequence: 2), n2)))
        let lane = RelayChannel(physical: physical, nonces: CountingBrokerNonces(start: 1000))
        let first = try await lane.next(); try await first.stream.endWrite(); first.stream.close()
        let second = try await lane.next()
        #expect(second.control == control(sequence: 2)); #expect(second.nonce == n2)
        #expect(physical.output == record(n1) + record(Data()) + record(n2))
        for (tail, oversized) in [(record(Data(repeating: 1, count: 4097)), true), (record(Data([1])), false)] {
            let p = BufferedStream(record(control()) + record(proofFor(control(), n1)) + tail)
            let l = RelayChannel(physical: p, nonces: ConstantBrokerNonces(n1))
            let s = try await l.next(); try await s.stream.endWrite(); s.stream.close()
            do { _ = try await l.next(); Issue.record("Undrained lane reused") }
            catch { if oversized { #expect(error as? BrokerFailure == .limits) } else { #expect(error is GuestStreamClosed) } }
        }
        // Without the host's logical EOF the old generation is never reused.
        let p = BufferedStream(record(control()) + record(proofFor(control(), n1)) + record(Data()))
        let l = RelayChannel(physical: p, nonces: ConstantBrokerNonces(n1)); let s = try await l.next(); s.stream.close()
        do { _ = try await l.next(); Issue.record("Lane reused without the host's logical EOF") }
        catch { #expect(error as? BrokerFailure == .terminal) }
    }
}

// Fix round 1 (I-1, Minor 1 ruling, P39(b)).

// A relay lane under test control: reads take fed bytes and wait while none are fed; end() is the
// guest's physical close; writes are recorded and, once failAfter bytes were written, fail (the
// guest's side of the lane has gone).
private final class FeedStream: ByteStream, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: Data, eof = false, blocked = 0, bytes = Data(), shut = 0
    private var reader: CheckedContinuation<Void, Never>?
    private var observers = [(Int, CheckedContinuation<Void, Never>)]()
    private var writeObservers = [(Int, CheckedContinuation<Void, Never>)]()
    private let failAfter: Int?
    let failedWrite = MemoryEvent()
    init(_ initial: Data, failAfter: Int? = nil) { buffer = initial; self.failAfter = failAfter }
    var written: Data { lock.withLock { bytes } }
    var closes: Int { lock.withLock { shut } }
    func read(maxBytes: Int) async throws -> Data {
        while true {
            let got = lock.withLock { () -> Data? in
                if !buffer.isEmpty { let n = min(maxBytes, buffer.count); let d = Data(buffer.prefix(n)); buffer.removeFirst(n); return d }
                return eof ? Data() : nil
            }
            if let got { return got }
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let (now, ready) = lock.withLock { () -> (Bool, [CheckedContinuation<Void, Never>]) in
                    if !buffer.isEmpty || eof { return (true, []) }
                    reader = continuation; blocked += 1
                    let ready = observers.filter { blocked >= $0.0 }.map { $0.1 }
                    observers.removeAll { blocked >= $0.0 }
                    return (false, ready)
                }
                if now { continuation.resume() }
                ready.forEach { $0.resume() }
            }
        }
    }
    func feed(_ data: Data) { lock.withLock { () -> CheckedContinuation<Void, Never>? in buffer.append(data); defer { reader = nil }; return reader }?.resume() }
    func end() { lock.withLock { () -> CheckedContinuation<Void, Never>? in eof = true; defer { reader = nil }; return reader }?.resume() }
    func waitForBlockedReads(_ count: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let now = lock.withLock { () -> Bool in if blocked >= count { return true }; observers.append((count, continuation)); return false }
            if now { continuation.resume() }
        }
    }
    func waitForWritten(_ count: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let now = lock.withLock { () -> Bool in if bytes.count >= count { return true }; writeObservers.append((count, continuation)); return false }
            if now { continuation.resume() }
        }
    }
    func write(_ data: Data) async throws -> Int {
        let (failing, ready) = lock.withLock { () -> (Bool, [CheckedContinuation<Void, Never>]) in
            if let failAfter, bytes.count >= failAfter { return (true, []) }
            bytes.append(data)
            let ready = writeObservers.filter { bytes.count >= $0.0 }.map { $0.1 }
            writeObservers.removeAll { bytes.count >= $0.0 }
            return (false, ready)
        }
        ready.forEach { $0.resume() }
        if failing { failedWrite.signal(); throw BrokerFailure.transport }
        return data.count
    }
    func endWrite() async throws {}
    func close() { lock.withLock { () -> CheckedContinuation<Void, Never>? in shut += 1; eof = true; defer { reader = nil }; return reader }?.resume() }
}

extension BrokerTests {
    @Test func idle_ended_slot_still_fails_run_on_guest_protocol_violation() async throws {
        // Fix round 1, I-1: after a host-first idle end, a protocol violation on the guest's side of
        // the stream (an oversized record, or a first length byte that already proves one) still
        // fails the whole run as limits. It is never absorbed as a per-slot end.
        for (late, guestCloses) in [(Data([0x10, 0x01, 1]), false), (Data([0x11]), true)] {
            let origin = StallingStream(), n = brokerNonce(1100)
            let h = try Harness(connector: FakeConnector(queued: [origin]))
            let lane = FeedStream(record(control()) + record(proofFor(control(), n)))
            let tunnel = try await h.broker.accept(request: try await RelayChannel(physical: lane, nonces: ConstantBrokerNonces(n)).next())
            let run = Task { try await tunnel.run() }
            await lane.waitForBlockedReads(1); await origin.readEntered.wait()
            await h.clock.waitForWaiters(2)
            h.clock.set(160, 30); h.clock.tick()                                    // host-first idle end
            await origin.closed.wait()
            await lane.waitForWritten(18 + 2)                                       // the challenge, then the host's logical EOF
            #expect(lane.written.suffix(2) == Data([0, 0]))
            lane.feed(late)
            if guestCloses { lane.end() }                                            // never a quiet lane end
            do { try await run.value; Issue.record("Protocol violation absorbed by a per-slot end") }
            catch { #expect(error as? BrokerFailure == .limits) }
            await denied(h, control(sequence: 2), expected: .terminal)
        }
    }

    @Test func length_prefix_first_byte_out_of_range_is_violation_even_at_eof() async throws {
        // Fix round 1 (Minor 1 ruling): a guest close right after a length byte that already proves
        // an out-of-range length is a whole-run protocol violation, not a per-slot close. A first
        // byte that still allows a valid length, then the close, stays the guest's per-slot close.
        let n = brokerNonce(1200), proof = proofFor(control(), n)
        // Setup frames: a control of 1...256 bytes (first byte at most 01), a proof of 32 (first byte 00).
        for (data, violation) in [(Data([0x02]), true), (Data([0xff]), true), (Data([0x01]), false),
                                  (record(control()) + Data([0x01]), true), (record(control()) + Data([0x00]), false)] {
            do { _ = try await RelayChannel(physical: BufferedStream(data), nonces: ConstantBrokerNonces(n)).next(); Issue.record("Truncated setup admitted") }
            catch { if violation { #expect(error as? BrokerFailure == .invalidControl) } else { #expect(error is GuestStreamClosed) } }
        }
        // Records, read by the stream and by the drain: at most 4096 bytes (first byte at most 10).
        for (tail, violation) in [(Data([0x11]), true), (Data([0x10]), false)] {
            let reader = RelayChannel(physical: BufferedStream(record(control()) + record(proof) + tail), nonces: ConstantBrokerNonces(n))
            let request = try await reader.next()
            do { _ = try await request.stream.read(maxBytes: 4096); Issue.record("Truncated record read") }
            catch { if violation { #expect(error as? BrokerFailure == .limits) } else { #expect(error is GuestStreamClosed) } }
            let drained = RelayChannel(physical: BufferedStream(record(control()) + record(proof) + tail), nonces: ConstantBrokerNonces(n))
            let stream = try await drained.next(); try await stream.stream.endWrite(); stream.stream.close()
            do { _ = try await drained.next(); Issue.record("Truncated drain reused the lane") }
            catch { if violation { #expect(error as? BrokerFailure == .limits) } else { #expect(error is GuestStreamClosed) } }
        }
    }

    @Test func lane_write_failure_ends_only_its_slot_in_pump_and_pending_paths() async throws {
        // P39(b): a physical write failure on a lane means the guest's side has gone, seen first by a
        // write. It ends that slot and lane like the guest's physical close; the run continues. When
        // every lane is gone, the run still fails as transport loss.
        let n = brokerNonce(1300), setup = record(control()) + record(proofFor(control(), n))
        // (1) Pump: a data write toward the guest, or the logical EOF toward the guest, fails.
        for origin in [MemoryStream([Data([7])]), MemoryStream()] {
            let h = try Harness(connector: FakeConnector(queued: [origin]))
            let lane = FeedStream(setup, failAfter: 18)                              // the challenge goes through
            let channel = RelayChannel(physical: lane, nonces: ConstantBrokerNonces(n))
            let tunnel = try await h.broker.accept(request: try await channel.next())
            let run = Task { try await tunnel.run() }
            await lane.failedWrite.wait()
            lane.end()                                                               // the guest's close reaches the read
            try await run.value                                                      // a per-slot end, not a run failure
            #expect(origin.closes >= 1)
            do { _ = try await channel.next(); Issue.record("Lane reused after its write failed") }
            catch { #expect(error is GuestStreamClosed) }
            let later = try await h.broker.accept(control: control(sequence: 2), stream: MemoryStream()); later.close()
        }
        // (1b) Pump, after a host-first idle end: the logical EOF the ended slot owes the guest fails.
        do {
            let origin = StallingStream()
            let h = try Harness(connector: FakeConnector(queued: [origin]))
            let lane = FeedStream(setup, failAfter: 18)
            let channel = RelayChannel(physical: lane, nonces: ConstantBrokerNonces(n))
            let tunnel = try await h.broker.accept(request: try await channel.next())
            let run = Task { try await tunnel.run() }
            await lane.waitForBlockedReads(1); await origin.readEntered.wait()
            await h.clock.waitForWaiters(2)
            h.clock.set(160, 30); h.clock.tick()                                    // host-first idle end
            await lane.failedWrite.wait()
            lane.end()
            try await run.value
            do { _ = try await channel.next(); Issue.record("Lane reused after its write failed") }
            catch { #expect(error is GuestStreamClosed) }
            let later = try await h.broker.accept(control: control(sequence: 2), stream: MemoryStream()); later.close()
        }
        // (2) Pending path: an idle pending slot's logical EOF cannot be written.
        do {
            let d = Deferred<[NumericAddress]>(), r = try FakeResolver([NumericAddress("8.8.8.8")], deferred: d)
            let h = try Harness(resolver: r)
            let lane = FeedStream(setup, failAfter: 18)
            let channel = RelayChannel(physical: lane, nonces: ConstantBrokerNonces(n))
            let request = try await channel.next()
            let admission = Task { try await h.broker.accept(request: request) }
            await d.waitEntered(); await h.clock.waitForWaiters(2)
            h.clock.set(160, 30); h.clock.tick()
            do { _ = try await admission.value; Issue.record("Idle admission returned a tunnel") }
            catch { #expect(error is SlotEnded) }
            #expect(lane.failedWrite.isSignalled)
            await d.finish(r.addresses)
            let later = try await h.broker.accept(control: control(sequence: 2), stream: MemoryStream()); later.close()
            do { _ = try await channel.next(); Issue.record("Lane reused after its write failed") }
            catch { #expect(error is GuestStreamClosed) }
        }
        // (3) Supervision: the only lane fails a write and its guest closes; with no lane left, the run fails.
        do {
            let h = try Harness(connector: FakeConnector(queued: [MemoryStream([Data([7])])])); await h.broker.fail(.terminal)
            let lane = FeedStream(setup, failAfter: 18)
            let broker = try replacementBroker(h, resolver: h.resolver, connector: h.connector, physical: [lane])
            let task = Task { try await BrokerExecutable.runRelays(broker: broker, physical: [lane], nonces: ConstantBrokerNonces(n)) }
            await lane.failedWrite.wait()
            lane.end()
            do { try await task.value; Issue.record("Relay supervision outlived its only lane") }
            catch { #expect(error as? BrokerFailure == .transport) }
        }
    }
}
