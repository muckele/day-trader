import Foundation
import CryptoKit
import Testing
@testable import AcceptanceCore

// Observable memory barriers; no sleeps or fixed yield loops drive fix probes. A wait also returns
// when its task is cancelled (a test's time limit), so a probe that never fires cannot hang the run.
private final class MemoryEvent: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var waiters = [UUID: CheckedContinuation<Void, Never>]()
    var isSignalled: Bool { lock.withLock { fired } }
    func signal() {
        let ready = lock.withLock {
            fired = true
            let ready = Array(waiters.values)
            waiters.removeAll()
            return ready
        }
        ready.forEach { $0.resume() }
    }
    func wait() async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let immediate = lock.withLock {
                    if fired || Task.isCancelled { return true }
                    waiters[id] = continuation
                    return false
                }
                if immediate { continuation.resume() }
            }
        } onCancel: {
            lock.withLock { waiters.removeValue(forKey: id) }?.resume()
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
    private var observers = [UUID: (Int, CheckedContinuation<Void,Never>)]()
    private var waiters = [UUID: CheckedContinuation<Void, any Error>]()
    func sample() throws -> ClockSample { try lock.withLock { if isBroken { throw BrokerFailure.clock }; return value } }
    func set(_ wall: Int = 160, _ mono: Int = 10) { lock.withLock { value = ClockSample(wall: wall, monotonic: mono) } }
    func wait(milliseconds: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
                lock.withLock { recordedDurations.append(milliseconds); if Task.isCancelled { c.resume(throwing:CancellationError()) } else { waiters[id] = c }; let ready = observers.filter { waiters.count >= $0.value.0 }; ready.keys.forEach { observers.removeValue(forKey: $0) }; ready.values.forEach { $0.1.resume() } }
            }
        } onCancel: { self.lock.withLock { self.waiters.removeValue(forKey:id) }?.resume(throwing:CancellationError()) }
    }
    // Also returns when the waiting task is cancelled (a test's time limit).
    func waitForWaiters(_ count:Int) async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { c in
                lock.withLock { if waiters.count >= count || Task.isCancelled { c.resume() } else { observers[id] = (count,c) } }
            }
        } onCancel: { lock.withLock { observers.removeValue(forKey: id) }?.1.resume() }
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
        // An unknown lane record type is a malformed lane record: whole-run transport (P40).
        await losingGate.finish(Data([9, 0, 0]))
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
        let relayed = try Harness(), physical = BufferedStream(laneOpenRecord + laneDataRecord(record(control()) + record(recorded)))
        let request = try await RelayChannel(physical: physical, nonces: ConstantBrokerNonces(b)).next()
        #expect(physical.output == laneDataRecord(record(b))); #expect(request.nonce == b); #expect(request.proof == recorded)
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
        let physical = BufferedStream(laneOpenRecord + laneDataRecord(record(control()) + record(proofFor(control(), n)) + record(Data()))
                                      + laneEndRecord + laneOpenRecord
                                      + laneDataRecord(record(control(sequence: 2)) + record(proofFor(control(sequence: 2), n))))
        let lane = RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n))
        let tunnel = try await relayed.broker.accept(request: try await lane.next()); try await tunnel.run()
        let second = try await lane.next()
        do { _ = try await relayed.broker.accept(request: second); Issue.record("Repeated challenge admitted through the relay") }
        catch { #expect(error as? BrokerFailure == .identity) }
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
}

// Fix round 2 (controller ruling on a reviewer observation): the pending path's per-slot end.

// A clock whose waits are woken by their duration, and whose next sample() can hold the broker
// actor job that sampled until the test releases it.
private final class HeldClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock()
    private var value = ClockSample(wall: 160, monotonic: 10)
    private var waiters = [UUID: (Int, CheckedContinuation<Void, any Error>)]()
    private var observers = [(Int, CheckedContinuation<Void, Never>)]()
    private var hold: DispatchSemaphore?
    let held = MemoryEvent()
    func set(_ wall: Int, _ monotonic: Int) { lock.withLock { value = ClockSample(wall: wall, monotonic: monotonic) } }
    func holdNextSample() -> DispatchSemaphore { let gate = DispatchSemaphore(value: 0); lock.withLock { hold = gate }; return gate }
    func sample() throws -> ClockSample {
        let gate = lock.withLock { () -> DispatchSemaphore? in defer { hold = nil }; return hold }
        if let gate { held.signal(); gate.wait() }
        return lock.withLock { value }
    }
    func wait(milliseconds: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let ready = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                    if Task.isCancelled { continuation.resume(throwing: CancellationError()); return [] }
                    waiters[id] = (milliseconds, continuation)
                    let ready = observers.filter { $0.0 == milliseconds }.map { $0.1 }
                    observers.removeAll { $0.0 == milliseconds }
                    return ready
                }
                ready.forEach { $0.resume() }
            }
        } onCancel: { self.lock.withLock { self.waiters.removeValue(forKey: id) }?.1.resume(throwing: CancellationError()) }
    }
    func waitForWaiter(duration: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let now = lock.withLock { () -> Bool in
                if waiters.values.contains(where: { $0.0 == duration }) { return true }
                observers.append((duration, continuation)); return false
            }
            if now { continuation.resume() }
        }
    }
    func wake(duration: Int) {
        let ready = lock.withLock { () -> [CheckedContinuation<Void, any Error>] in
            let ids = waiters.filter { $0.value.0 == duration }.map { $0.key }
            return ids.compactMap { waiters.removeValue(forKey: $0)?.1 }
        }
        ready.forEach { $0.resume() }
    }
}
// Waits on its gate, signals `thrown`, then throws FAILURE (or, with no failure, answers 8.8.8.8).
private final class GatedResolver: Resolver, @unchecked Sendable {
    let gate = Deferred<Void>(), thrown = MemoryEvent(), failure: BrokerFailure?
    init(_ failure: BrokerFailure?) { self.failure = failure }
    func resolve(host: String) async throws -> [NumericAddress] {
        guard let failure else { return [try NumericAddress("8.8.8.8")] }
        try await gate.get(); thrown.signal(); throw failure
    }
}
private final class GatedConnector: Connector, @unchecked Sendable {
    let gate = Deferred<Void>(), thrown = MemoryEvent(), failure: BrokerFailure
    init(_ failure: BrokerFailure) { self.failure = failure }
    func connect(address: NumericAddress, port: UInt16) async throws -> any ByteStream {
        try await gate.get(); thrown.signal(); throw failure
    }
}

extension BrokerTests {
    @Test func idle_ended_pending_slot_still_fails_run_on_resolver_or_connector_failure() async throws {
        // Fix round 2: once a pending slot is marked ended (host idle), only that end's own signals
        // are per-slot. A genuine resolver or connector failure that reaches the admission after
        // the end still fails the run with its own code. The slot watch's job holds the broker
        // actor inside check(id) while the failure is delivered, so the end is processed first.
        // A delivery that lands after the end's cancellation is a lost race and is retried.
        for (stage, code) in [("resolver", BrokerFailure.address), ("resolver", .transport), ("connector", .transport)] {
            var decided = false
            for _ in 0..<20 where !decided {
                let h = try Harness(); await h.broker.fail(.terminal)
                let clock = HeldClock(), input = MemoryStream()
                let resolver = GatedResolver(stage == "resolver" ? code : nil), connector = GatedConnector(code)
                let broker = try EgressBroker(release: h.release, authority: h.authority, binding: h.binding,
                                              limits: h.binding.manifest.limits, resolver: resolver, connector: connector, clock: clock)
                let admission = Task { try await broker.accept(control: control(), stream: input) }
                if stage == "resolver" { await resolver.gate.waitEntered() } else { await connector.gate.waitEntered() }
                await clock.waitForWaiter(duration: 20)                              // the slot's idle watch
                let release = clock.holdNextSample()
                clock.set(160, 30); clock.wake(duration: 20)                         // idle: 30 - 10 >= 20
                await clock.held.wait()                                              // the watch holds the actor in check(id)
                if stage == "resolver" { await resolver.gate.finish(()); await resolver.thrown.wait() }
                else { await connector.gate.finish(()); await connector.thrown.wait() }
                release.signal()                                                     // the slot ends, then the failure is seen
                do { _ = try await admission.value; Issue.record("Admission returned a tunnel") }
                catch is SlotEnded { continue }                                      // lost race: the end's own cancellation came first
                catch {
                    decided = true
                    #expect(error as? BrokerFailure == code, "\(stage) \(code)")
                    #expect(input.ends == 0, "no per-slot logical EOF")
                    #expect(input.closes == 1)
                    do { _ = try await broker.accept(control: control(sequence: 2), stream: MemoryStream()); Issue.record("Run survived a \(stage) failure") }
                    catch { #expect(error as? BrokerFailure == .terminal) }
                }
            }
            #expect(decided, "a \(stage) \(code) failure after the slot's end never failed the run")
        }
    }
}

// Task 6 lane redesign (owner decision; P40, as amended by P41). Each relay pipe pair is a reusable
// lane: every byte on it, both ways, is inside a lane record, type (1) | length (2, big-endian) |
// payload. Launcher to broker: OPEN, DATA, END; broker to launcher: DATA, END. A stream is over once
// both sides have sent END, and the lane then carries the next guest vsock connection.

private struct LaneRecord: Equatable, CustomStringConvertible {
    let type: UInt8, payload: Data
    static func data(_ payload: Data) -> LaneRecord { LaneRecord(type: 2, payload: payload) }
    static let end = LaneRecord(type: 3, payload: Data())
    var description: String { "\(type):\(hexString(payload))" }
}
private let laneOpenRecord = Data([1, 0, 0]), laneEndRecord = Data([3, 0, 0])
private func laneDataRecord(_ payload: Data) -> Data { Data([2, UInt8(payload.count >> 8), UInt8(payload.count & 255)]) + payload }
// The complete lane records in BYTES (a trailing partial record is left out).
private func laneRecords(_ bytes: Data) -> [LaneRecord] {
    var records = [LaneRecord](), index = bytes.startIndex
    while bytes.endIndex - index >= 3 {
        let length = Int(bytes[index + 1]) << 8 | Int(bytes[index + 2])
        guard bytes.endIndex - index - 3 >= length else { break }
        records.append(LaneRecord(type: bytes[index], payload: Data(bytes[(index + 3)..<(index + 3 + length)])))
        index += 3 + length
    }
    return records
}
// A guest record (C4 framing): length (2, big-endian) | bytes.
private func guestRecord(_ bytes: Data) -> Data { Data([UInt8(bytes.count >> 8), UInt8(bytes.count & 255)]) + bytes }
// A guest stream's setup: its control, then its proof for NONCE.
private func setup(_ control: Data, _ nonce: Data) -> Data { guestRecord(control) + guestRecord(proofFor(control, nonce)) }
private struct LaneTestStop: Error {}

// The launcher's end of one lane, as the broker's ByteStream. The test sends lane records; the
// broker's writes are parsed back into lane records. A pending read waits for the next send and is
// interrupted by close() or by cancellation, as the ByteStream contract requires. Every test-side
// wait also returns once the lane is closed or the test is cancelled (its time limit).
private final class FakeLauncher: ByteStream, @unchecked Sendable {
    private let lock = NSLock(), chunk: Int
    private var inbound = Data(), pipeEnded = false, shut = false, writeLimit: Int?, bytes = Data()
    private var reader: (id: UUID, maxBytes: Int, continuation: CheckedContinuation<Data, any Error>)?
    private var observers = [UUID: (@Sendable ([LaneRecord]) -> Bool, CheckedContinuation<[LaneRecord], Never>)]()
    private var drainObservers = [UUID: CheckedContinuation<Void, Never>]()
    let closed = MemoryEvent(), failedWrite = MemoryEvent()
    // CHUNK: the most bytes one read returns.
    init(chunk: Int = 4096) { self.chunk = chunk }
    var output: Data { lock.withLock { bytes } }
    var records: [LaneRecord] { laneRecords(output) }
    var isClosed: Bool { lock.withLock { shut } }

    func send(_ data: Data) {
        let ready = lock.withLock { () -> (CheckedContinuation<Data, any Error>, Data)? in inbound.append(data); return takeReader() }
        if let ready { ready.0.resume(returning: ready.1) }
    }
    func open() { send(laneOpenRecord) }
    func data(_ payload: Data) { send(laneDataRecord(payload)) }
    func end() { send(laneEndRecord) }
    // The launcher's pipe ends: reads return empty once the bytes already sent are read.
    func endPipe() {
        let ready = lock.withLock { () -> (CheckedContinuation<Data, any Error>, Data)? in pipeEnded = true; return takeReader() }
        if let ready { ready.0.resume(returning: ready.1) }
    }
    // Writes past COUNT bytes in all fail.
    func failWrites(after count: Int) { lock.withLock { writeLimit = count } }
    private func takeReader() -> (CheckedContinuation<Data, any Error>, Data)? {
        guard let pending = reader, !inbound.isEmpty || pipeEnded else { return nil }
        reader = nil
        let n = min(pending.maxBytes, chunk, inbound.count), data = Data(inbound.prefix(n))
        inbound.removeFirst(n)
        return (pending.continuation, data)
    }
    // Returns once the broker waits in read() with nothing left to read, or the lane is closed.
    func waitUntilDrained() async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    if shut || reader != nil || Task.isCancelled { return true }
                    drainObservers[id] = continuation; return false
                }
                if now { continuation.resume() }
            }
        } onCancel: { lock.withLock { drainObservers.removeValue(forKey: id) }?.resume() }
    }
    // The broker's records once PREDICATE holds for them, or once the lane is closed.
    @discardableResult func waitForRecords(_ predicate: @escaping @Sendable ([LaneRecord]) -> Bool) async -> [LaneRecord] {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<[LaneRecord], Never>) in
                let now = lock.withLock { () -> [LaneRecord]? in
                    let current = laneRecords(bytes)
                    if shut || predicate(current) || Task.isCancelled { return current }
                    observers[id] = (predicate, continuation); return nil
                }
                if let now { continuation.resume(returning: now) }
            }
        } onCancel: { lock.withLock { observers.removeValue(forKey: id) }?.1.resume(returning: self.records) }
    }

    func read(maxBytes: Int) async throws -> Data {
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
                let (result, drained) = lock.withLock { () -> (Result<Data, any Error>?, [CheckedContinuation<Void, Never>]) in
                    if shut { return (.failure(BrokerFailure.terminal), []) }
                    if Task.isCancelled { return (.failure(CancellationError()), []) }
                    if !inbound.isEmpty || pipeEnded {
                        let n = min(maxBytes, chunk, inbound.count), data = Data(inbound.prefix(n))
                        inbound.removeFirst(n)
                        return (.success(data), [])
                    }
                    reader = (id, maxBytes, continuation)
                    let drained = Array(drainObservers.values); drainObservers.removeAll()
                    return (nil, drained)
                }
                drained.forEach { $0.resume() }
                if let result { continuation.resume(with: result) }
            }
        } onCancel: {
            let pending = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
                guard let current = reader, current.id == id else { return nil }
                reader = nil; return current.continuation
            }
            pending?.resume(throwing: CancellationError())
        }
    }
    func write(_ data: Data) async throws -> Int {
        let (failing, ready) = lock.withLock { () -> (Bool, [(CheckedContinuation<[LaneRecord], Never>, [LaneRecord])]) in
            if shut { return (true, []) }
            if let writeLimit, bytes.count + data.count > writeLimit { return (true, []) }
            bytes.append(data)
            let current = laneRecords(bytes), matched = observers.filter { $0.value.0(current) }
            matched.keys.forEach { observers.removeValue(forKey: $0) }
            return (false, matched.values.map { ($0.1, current) })
        }
        ready.forEach { $0.0.resume(returning: $0.1) }
        if failing { failedWrite.signal(); throw NSError(domain: "PRIVATE_PAYLOAD_CANARY", code: 3) }
        return data.count
    }
    func endWrite() async throws { throw BrokerFailure.transport }                  // as PipePairStream
    func close() {
        let (pending, waiting, drained) = lock.withLock { () -> (CheckedContinuation<Data, any Error>?, [CheckedContinuation<[LaneRecord], Never>], [CheckedContinuation<Void, Never>]) in
            shut = true
            let pending = reader?.continuation; reader = nil
            let waiting = observers.values.map { $0.1 }; observers.removeAll()
            let drained = Array(drainObservers.values); drainObservers.removeAll()
            return (pending, waiting, drained)
        }
        pending?.resume(throwing: BrokerFailure.terminal)
        let current = records
        waiting.forEach { $0.resume(returning: current) }
        drained.forEach { $0.resume() }
        closed.signal()
    }
}

// The test's side of one lane's streams, in order.
private final class LaneView {
    let launcher: FakeLauncher
    private(set) var seen = 0                                                         // broker records already taken
    init(_ launcher: FakeLauncher) { self.launcher = launcher }
    // OPEN. The stream's first broker record must be one DATA carrying the challenge frame (length
    // 16, then the nonce). Returns the nonce.
    func open() async throws -> Data {
        launcher.open()
        let start = seen, records = await launcher.waitForRecords { $0.count > start }
        guard records.count > start else { Issue.record("No challenge after OPEN (lane closed: \(launcher.isClosed))"); throw LaneTestStop() }
        let challenge = records[start]
        guard challenge.type == 2, challenge.payload.count == 18, challenge.payload.prefix(2) == Data([0, 16]) else {
            Issue.record("Expected the challenge DATA record, got \(challenge)"); throw LaneTestStop()
        }
        seen = start + 1
        return Data(challenge.payload.dropFirst(2))
    }
    // The broker's records for the current stream, up to and including its END.
    func brokerEnd() async throws -> [LaneRecord] {
        let start = seen, records = await launcher.waitForRecords { $0.dropFirst(start).contains(.end) }
        guard let index = records.indices.dropFirst(start).first(where: { records[$0] == .end }) else {
            Issue.record("No broker END (lane closed: \(launcher.isClosed))"); throw LaneTestStop()
        }
        seen = index + 1
        return Array(records[start..<seen])
    }
    // The broker has read everything sent and waits on the lane again; the run has not failed.
    func settled() async throws {
        await launcher.waitUntilDrained()
        guard !launcher.isClosed else { Issue.record("The run failed"); throw LaneTestStop() }
    }
}
private enum LaneStage { case idle, handshake, tunnel, draining, drainedEOF }
// The supervision's outcome; a cancelled test (its time limit) cancels the supervision too.
private func outcome(_ task: Task<Void, any Error>) async -> (any Error)? {
    await withTaskCancellationHandler {
        do { try await task.value; return nil } catch { return error }
    } onCancel: { task.cancel() }
}
// Waits for WORK, or returns when the test is cancelled (its time limit) first.
private func untilCancelled(_ work: @escaping @Sendable () async -> Void) async {
    let done = MemoryEvent(), task = Task { await work(); done.signal() }
    await done.wait()
    task.cancel()
}

extension BrokerTests {
    // A broker that owns LAUNCHERS, as BrokerExecutable.run's broker owns its relay pipes, under the
    // real relay supervision. After BODY the broker is failed and the supervision awaited.
    private func laneRun(_ h: Harness, _ launchers: [FakeLauncher], nonces: any BrokerNonceSource = CountingBrokerNonces(),
                         _ body: (EgressBroker, Task<Void, any Error>) async throws -> Void) async throws {
        await h.broker.fail(.terminal)
        let broker = try replacementBroker(h, resolver: h.resolver, connector: h.connector, physical: launchers)
        let task = Task { try await BrokerExecutable.runRelays(broker: broker, physical: launchers, nonces: nonces) }
        var failure: (any Error)?
        do { try await body(broker, task) } catch { failure = error }
        await broker.fail(.terminal)
        _ = await outcome(task)
        if let failure { throw failure }
    }
    // Brings LANE to STAGE: IDLE; OPEN with the challenge written; a stream admitted, its tunnel
    // reading the lane; or, after a host-first idle end, the drain reading the old stream (one of its
    // records already read by the tunnel, and its logical EOF too for drainedEOF).
    private func reach(_ stage: LaneStage, _ h: Harness, _ lane: LaneView) async throws {
        if stage == .idle { try await lane.settled(); return }
        let nonce = try await lane.open()
        if stage == .handshake { try await lane.settled(); return }
        lane.launcher.data(setup(control(), nonce)); try await lane.settled()
        if stage == .tunnel { return }
        await h.clock.waitForWaiters(2)                                              // the run's and the slot's watches
        h.clock.set(160, 30); h.clock.tick()                                        // idle: the slot ends alone
        #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
        lane.launcher.data(guestRecord(Data([5])) + (stage == .drainedEOF ? guestRecord(Data()) : Data()))
        try await lane.settled()
    }

    @Test(.timeLimit(.minutes(1))) func lane_survives_many_guest_first_closes() async throws {
        // P40: a launcher END ends only its stream, wherever it falls: before the control, inside the
        // proof (no sequence is consumed), inside a guest record, or mid-tunnel. The broker answers with
        // END alone, never DATA after the launcher's END. Forty such ends on one lane, then a full tunnel.
        let origins = (0..<20).map { _ in StallingStream() }, last = MemoryStream([Data([9])])
        let h = try Harness(connector: FakeConnector(queued: origins.map { $0 as any ByteStream } + [last]))
        let launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { broker, _ in
            let lane = LaneView(launcher)
            var sequence = 1, admitted = 0
            for i in 0..<40 {
                let nonce = try await lane.open(), guest = setup(control(sequence: sequence), nonce)
                switch i % 4 {
                case 0: break                                                        // before the control
                case 1: launcher.data(guest.prefix(guest.count - 7))                 // inside the proof
                case 2: launcher.data(guest + Data([0, 5, 1, 2]))                    // inside a guest record
                default: launcher.data(guest + guestRecord(Data([1, 2, 3])))         // mid-tunnel
                }
                if i % 4 >= 2 { try await lane.settled() }                           // admitted: the tunnel reads the lane
                launcher.end()
                #expect(try await lane.brokerEnd() == [.end], "stream \(i)")
                if i % 4 >= 2 {
                    #expect(origins[admitted].written == (i % 4 == 3 ? Data([1, 2, 3]) : Data()), "stream \(i)")
                    admitted += 1; sequence += 1                                     // only an admitted stream uses its sequence
                }
            }
            #expect(h.connector.calls.count == 20)
            let nonce = try await lane.open()
            launcher.data(setup(control(sequence: sequence), nonce) + guestRecord(Data([1, 2])) + guestRecord(Data()))
            #expect(try await lane.brokerEnd() == [.data(guestRecord(Data([9]))), .data(Data([0, 0])), .end])
            launcher.end()
            #expect(last.written == Data([1, 2])); #expect(last.ends == 1)
            #expect(!launcher.isClosed, "the run has not failed")
            let probe = try await broker.accept(control: control(sequence: sequence + 1), stream: MemoryStream()); probe.close()
        }
    }

    @Test(.timeLimit(.minutes(1))) func lane_survives_many_host_first_idle_ends() async throws {
        // P38(b), P40: an idle slot ends only itself. The broker writes the logical EOF (DATA 00 00), then
        // END; the launcher answers END and the lane is IDLE again. Forty times, then a full tunnel.
        let origins = (0..<40).map { _ in StallingStream() }, last = MemoryStream([Data([9])])
        let h = try Harness(connector: FakeConnector(queued: origins.map { $0 as any ByteStream } + [last]), duration: 100000)
        let launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { broker, _ in
            let lane = LaneView(launcher)
            var now = 10
            for (i, origin) in origins.enumerated() {
                let nonce = try await lane.open()
                launcher.data(setup(control(sequence: i + 1), nonce))
                try await lane.settled()
                await h.clock.waitForWaiters(2)                                      // the run's and the slot's watches
                now += 20; h.clock.set(160, now); h.clock.tick()                     // 20 ms without progress
                #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end], "stream \(i)")
                await origin.closed.wait()
                #expect(origin.written.isEmpty)
                launcher.end()
            }
            let nonce = try await lane.open()
            launcher.data(setup(control(sequence: 41), nonce) + guestRecord(Data([1, 2])) + guestRecord(Data()))
            #expect(try await lane.brokerEnd() == [.data(guestRecord(Data([9]))), .data(Data([0, 0])), .end])
            launcher.end()
            #expect(last.written == Data([1, 2]))
            #expect(!launcher.isClosed, "the run has not failed")
            let probe = try await broker.accept(control: control(sequence: 42), stream: MemoryStream()); probe.close()
        }
    }

    @Test(.timeLimit(.minutes(1))) func challenge_written_only_after_open() async throws {
        // P40: an IDLE lane writes nothing before OPEN. After OPEN the broker writes exactly one DATA
        // record, the challenge frame, and then waits for the stream's control.
        let h = try Harness(), launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { _, _ in
            await launcher.waitUntilDrained()
            #expect(launcher.output.isEmpty, "no broker byte before OPEN")
            launcher.open()
            await launcher.waitUntilDrained()
            #expect(launcher.output == laneDataRecord(guestRecord(brokerNonce(0))))
        }
        // C4/R5: a nonce source that fails, or gives a value that is not 16 bytes, fails closed after
        // OPEN with nothing written. An IDLE lane never asks it: its pipe EOF is the lane's failure.
        for source in [ConstantBrokerNonces(nil), ConstantBrokerNonces(Data(count: 15)), ConstantBrokerNonces(Data(count: 17))] {
            let quiet = BufferedStream(laneOpenRecord + laneDataRecord(setup(control(), brokerNonce(700))))
            do { _ = try await RelayChannel(physical: quiet, nonces: source).next(); Issue.record("Challenge without a 16-byte nonce") }
            catch { #expect(error as? BrokerFailure == .identity) }
            #expect(quiet.output.isEmpty)
            do { _ = try await RelayChannel(physical: BufferedStream(Data()), nonces: source).next(); Issue.record("An empty lane gave a stream") }
            catch { #expect(error is LaneFailure, "the nonce source is asked only after OPEN") }
        }
    }

    @Test(.timeLimit(.minutes(1))) func old_stream_bytes_never_reach_next_stream() async throws {
        // (1) After a host-first END: the old stream's late DATA, then END, then OPEN. The late bytes
        // would make a valid control and proof for the next challenge. They are read as the old
        // stream's records and discarded (P41): never forwarded, never parsed as the next setup. The
        // next stream gets a fresh challenge and only its own control is admitted.
        let oldOrigin = StallingStream(), newOrigin = MemoryStream()
        let h = try Harness(connector: FakeConnector(queued: [oldOrigin, newOrigin]))
        let launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { _, _ in
            let lane = LaneView(launcher)
            let n1 = try await lane.open()
            launcher.data(setup(control(), n1))
            try await lane.settled(); await h.clock.waitForWaiters(2)
            h.clock.set(160, 30); h.clock.tick()                                    // host-first idle end
            #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
            await oldOrigin.closed.wait()
            launcher.data(setup(control(sequence: 2), brokerNonce(1)) + guestRecord(Data([5, 5])) + guestRecord(Data()))
            launcher.end()
            let n2 = try await lane.open()
            #expect(n2 == brokerNonce(1) && n2 != n1, "a fresh challenge")
            launcher.data(setup(control(sequence: 3), n2) + guestRecord(Data([7])) + guestRecord(Data()))
            #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
            launcher.end()
            #expect(oldOrigin.written.isEmpty, "nothing reaches the old tunnel's origin after END")
            #expect(newOrigin.written == Data([7]))
            #expect(h.connector.calls.count == 2, "the late control was never admitted")
        }
        // (2) After a launcher END the broker writes no DATA for that stream: a write or a logical EOF
        // on it fails, and only the broker's END follows before the next stream.
        let other = FakeLauncher()
        defer { other.close() }
        let channel = RelayChannel(physical: other, nonces: CountingBrokerNonces(start: 1400))
        other.open(); other.data(setup(control(), brokerNonce(1400))); other.end()
        let request = try await channel.next()
        do { _ = try await request.stream.read(maxBytes: 4096); Issue.record("Read past the launcher's END") }
        catch { #expect(error is GuestStreamClosed) }
        do { _ = try await request.stream.write(Data([9])); Issue.record("DATA written after the launcher's END") }
        catch { #expect(error is GuestStreamClosed) }
        do { try await request.stream.endWrite(); Issue.record("Logical EOF written after the launcher's END") }
        catch { #expect(error is GuestStreamClosed) }
        request.stream.close()
        other.open(); other.data(setup(control(sequence: 2), brokerNonce(1401)))
        let second = try await channel.next()
        #expect(second.control == control(sequence: 2))
        #expect(other.records == [.data(guestRecord(brokerNonce(1400))), .end, .data(guestRecord(brokerNonce(1401)))])
    }

    // After crossing ENDs: a stream ended by its own END before its control, then a full tunnel.
    private func afterCrossing(_ lane: LaneView, sequence: Int, origin: MemoryStream) async throws {
        _ = try await lane.open(); lane.launcher.end()
        #expect(try await lane.brokerEnd() == [.end], "the next stream ends once, by its own END")
        let nonce = try await lane.open()
        lane.launcher.data(setup(control(sequence: sequence), nonce) + guestRecord(Data([4])) + guestRecord(Data()))
        #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
        lane.launcher.end()
        #expect(origin.written == Data([4]))
        #expect(!lane.launcher.isClosed, "the run has not failed")
    }

    @Test(.timeLimit(.minutes(1))) func crossing_ends_free_the_lane_once() async throws {
        // P40: ENDs that cross free the lane once. Each side sends one END per stream; the launcher's
        // END for the old stream is never taken for the next stream's, and the next OPEN starts a stream.
        // (1) The launcher's END waits unread while the slot is pending; the slot goes idle and the
        // broker's logical EOF and END cross it.
        do {
            let d = Deferred<[NumericAddress]>(), origin = MemoryStream()
            let h = try Harness(resolver: try FakeResolver([NumericAddress("8.8.8.8")], deferred: d), connector: FakeConnector(queued: [origin]))
            let launcher = FakeLauncher()
            try await laneRun(h, [launcher]) { _, _ in
                let lane = LaneView(launcher)
                let nonce = try await lane.open()
                launcher.data(setup(control(), nonce))
                await untilCancelled { await d.waitEntered() }                       // pending in resolve
                launcher.end()
                await h.clock.waitForWaiters(2)
                h.clock.set(160, 30); h.clock.tick()                                // the pending slot goes idle
                #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
                try await afterCrossing(lane, sequence: 2, origin: origin)
            }
        }
        // (2) Mid-tunnel: the launcher's END and the idle end race.
        do {
            let origin = MemoryStream()
            let h = try Harness(connector: FakeConnector(queued: [StallingStream(), origin]))
            let launcher = FakeLauncher()
            try await laneRun(h, [launcher]) { _, _ in
                let lane = LaneView(launcher)
                let nonce = try await lane.open()
                launcher.data(setup(control(), nonce))
                try await lane.settled(); await h.clock.waitForWaiters(2)
                launcher.end(); h.clock.set(160, 30); h.clock.tick()                // the two ENDs cross
                let first = try await lane.brokerEnd()
                #expect(first == [.end] || first == [.data(Data([0, 0])), .end], "one END, no DATA after it: \(first)")
                try await afterCrossing(lane, sequence: 2, origin: origin)
            }
        }
    }

    @Test(.timeLimit(.minutes(1))) func guest_bytes_cannot_forge_lane_records() async throws {
        // P40: guest bytes travel only inside DATA payloads. Guest records holding the bytes of an END,
        // an OPEN or a DATA header stay guest data both ways, however the DATA records split them.
        let origin = MemoryStream([Data([3, 0, 0, 1, 0, 0]), Data([2, 0, 0])])
        let h = try Harness(connector: FakeConnector(queued: [origin]))
        let launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { _, _ in
            let lane = LaneView(launcher)
            let nonce = try await lane.open()
            launcher.data(setup(control(), nonce) + guestRecord(Data([3, 0, 0])) + guestRecord(Data([1, 0, 0, 2, 0, 0])))
            launcher.data(Data([0, 3])); launcher.data(Data([3, 0, 0]))              // a record whose payload is an END's bytes
            launcher.data(Data([0, 0]))                                              // the guest's logical EOF
            #expect(try await lane.brokerEnd() == [.data(guestRecord(Data([3, 0, 0, 1, 0, 0]))), .data(guestRecord(Data([2, 0, 0]))),
                                                  .data(Data([0, 0])), .end])
            launcher.end()
            #expect(origin.written == Data([3, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0])); #expect(origin.ends == 1)
            #expect(!launcher.isClosed, "the run has not failed")
        }
    }

    @Test(.timeLimit(.minutes(1))) func guest_records_reassembled_across_data_records() async throws {
        // P40: guest records (control, proof, data, logical EOF) are parsed from the DATA payload byte
        // stream. One DATA for everything, one DATA per byte, and mixed sizes over one-byte pipe reads
        // give the same tunnel.
        let guest = setup(control(), brokerNonce(0)) + guestRecord(Data(repeating: 1, count: 300)) + guestRecord(Data([2]))
            + guestRecord(Data([3, 3])) + guestRecord(Data())
        var mixed = [Data](), offset = 0, sizes = [1, 2, 5, 64, 3, 200, 7]
        while offset < guest.count {
            let size = min(sizes[mixed.count % sizes.count], guest.count - offset)
            mixed.append(Data(guest[(guest.startIndex + offset)..<(guest.startIndex + offset + size)])); offset += size
        }
        var results = [(Data, [LaneRecord], Int)]()
        for (pieces, chunk) in [([guest], 4096), (guest.map { Data([$0]) }, 4096), (mixed, 1)] {
            let origin = MemoryStream([Data([8, 9])])
            let h = try Harness(connector: FakeConnector(queued: [origin]))
            let launcher = FakeLauncher(chunk: chunk)
            try await laneRun(h, [launcher]) { _, _ in
                let lane = LaneView(launcher)
                #expect(try await lane.open() == brokerNonce(0))
                pieces.forEach { launcher.data($0) }
                let records = try await lane.brokerEnd()
                launcher.end()
                results.append((origin.written, records, h.connector.calls.count))
            }
        }
        try #require(results.count == 3)
        for result in results {
            #expect(result.0 == Data(repeating: 1, count: 300) + Data([2, 3, 3]))
            #expect(result.1 == [.data(guestRecord(Data([8, 9]))), .data(Data([0, 0])), .end])
            #expect(result.2 == 1)
        }
    }

    @Test(.timeLimit(.minutes(1))) func malformed_lane_record_fails_run_transport() async throws {
        // P40: a malformed lane record fails the whole run as transport at once, in every state, and
        // every lane closes.
        let cases: [(String, LaneStage, Data)] = [
            ("unknown type", .idle, Data([9, 0, 0])), ("type 0", .idle, Data([0, 0, 0])),
            ("DATA while IDLE", .idle, laneDataRecord(Data([5]))), ("END while IDLE", .idle, laneEndRecord),
            ("OPEN with a length", .idle, Data([1, 0, 1, 0])),
            ("OPEN while live", .handshake, laneOpenRecord), ("DATA of length 0", .handshake, Data([2, 0, 0])),
            ("DATA over 16384", .handshake, Data([2, 0x40, 0x01])), ("DATA of 65535", .handshake, Data([2, 0xff, 0xff])),
            ("END with a length", .handshake, Data([3, 0, 1, 0])), ("unknown type while live", .handshake, Data([4, 0, 0])),
            ("OPEN mid-tunnel", .tunnel, laneOpenRecord), ("DATA of length 0 mid-tunnel", .tunnel, Data([2, 0, 0])),
            ("END with a length mid-tunnel", .tunnel, Data([3, 0, 1, 0])), ("unknown type mid-tunnel", .tunnel, Data([0x83, 0, 0])),
            ("OPEN while draining", .draining, laneOpenRecord), ("OPEN while draining after the EOF", .drainedEOF, laneOpenRecord),
            ("DATA of length 0 while draining", .draining, Data([2, 0, 0])), ("DATA over 16384 while draining", .draining, Data([2, 0x40, 0x01])),
        ]
        for (name, stage, bytes) in cases {
            let h = try Harness(connector: FakeConnector(queued: [StallingStream()]))
            let launcher = FakeLauncher(), sibling = FakeLauncher()
            try await laneRun(h, [launcher, sibling]) { broker, task in
                let lane = LaneView(launcher)
                try await reach(stage, h, lane)
                launcher.send(bytes)
                await launcher.waitUntilDrained()
                guard launcher.isClosed else { Issue.record("\(name): the run went on"); throw LaneTestStop() }
                #expect(await outcome(task) as? BrokerFailure == .transport, "\(name)")
                #expect(sibling.isClosed, "\(name): every lane closes")
                do { _ = try await broker.accept(control: control(sequence: 9), stream: MemoryStream()); Issue.record("\(name): the run went on") }
                catch { #expect(error as? BrokerFailure == .terminal, "\(name)") }
            }
        }
        // The limit itself is valid: one DATA of exactly 16384 bytes carries four full guest records.
        let origin = MemoryStream()
        let h = try Harness(connector: FakeConnector(queued: [origin]), bytes: 20000)
        let launcher = FakeLauncher()
        try await laneRun(h, [launcher]) { _, _ in
            let lane = LaneView(launcher)
            let nonce = try await lane.open()
            launcher.data(setup(control(), nonce))
            let full = (1...4).reduce(Data()) { $0 + guestRecord(Data(repeating: UInt8($1), count: 4094)) }
            #expect(full.count == 16384)
            launcher.data(full); launcher.data(guestRecord(Data()))
            #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
            launcher.end()
            #expect(origin.written.count == 4 * 4094)
        }
    }

    @Test(.timeLimit(.minutes(1))) func lane_pipe_eof_or_write_failure_fails_run_transport() async throws {
        // P40 (reverses P39(b)): the launcher's pipe ending, or a failed write on it, means the launcher
        // is gone. The whole run fails as transport in every state, and every lane closes.
        for stage in [LaneStage.idle, .handshake, .tunnel, .draining] {
            let h = try Harness(connector: FakeConnector(queued: [StallingStream()]))
            let launcher = FakeLauncher(), sibling = FakeLauncher()
            try await laneRun(h, [launcher, sibling]) { broker, task in
                let lane = LaneView(launcher)
                try await reach(stage, h, lane)
                if stage == .handshake { launcher.data(guestRecord(control()).prefix(9)) }      // inside the control
                let before = launcher.records.count
                launcher.endPipe()
                await launcher.waitForRecords { $0.count > before }
                guard launcher.isClosed, launcher.records.count == before else { Issue.record("Pipe EOF at \(stage): the run went on"); throw LaneTestStop() }
                #expect(await outcome(task) as? BrokerFailure == .transport, "\(stage)")
                #expect(sibling.isClosed)
                do { _ = try await broker.accept(control: control(sequence: 9), stream: MemoryStream()); Issue.record("Pipe EOF at \(stage): the run went on") }
                catch { #expect(error as? BrokerFailure == .terminal) }
            }
        }
        // A failed write: the challenge, DATA toward the guest, its logical EOF, the idle end's EOF and
        // END, the broker's END after a launcher END, and the pending path's logical EOF.
        enum Failing { case challenge, data, logicalEOF, idleEnd, end, pending }
        for failing in [Failing.challenge, .data, .logicalEOF, .idleEnd, .end, .pending] {
            let d = Deferred<[NumericAddress]>()
            let resolver = try FakeResolver([NumericAddress("8.8.8.8")], deferred: failing == .pending ? d : nil)
            let origin: any ByteStream
            switch failing {
            case .data: origin = MemoryStream([Data([7])])                               // DATA toward the guest
            case .logicalEOF: origin = MemoryStream()                                    // the origin's EOF at once
            default: origin = StallingStream()
            }
            let h = try Harness(resolver: resolver, connector: FakeConnector(queued: [origin]))
            let launcher = FakeLauncher(), sibling = FakeLauncher()
            launcher.failWrites(after: failing == .challenge ? 0 : 21)                   // 21: the challenge record
            try await laneRun(h, [launcher, sibling]) { broker, task in
                let lane = LaneView(launcher)
                if failing == .challenge { launcher.open() } else {
                    let nonce = try await lane.open()
                    if failing == .end { launcher.end() } else { launcher.data(setup(control(), nonce)) }
                    if failing == .idleEnd { try await lane.settled() }
                    if failing == .pending { await untilCancelled { await d.waitEntered() } }
                    if failing == .idleEnd || failing == .pending { await h.clock.waitForWaiters(2); h.clock.set(160, 30); h.clock.tick() }
                }
                await launcher.closed.wait()
                #expect(launcher.failedWrite.isSignalled, "\(failing)")
                #expect(await outcome(task) as? BrokerFailure == .transport, "\(failing)")
                #expect(sibling.isClosed, "\(failing)")
                do { _ = try await broker.accept(control: control(sequence: 9), stream: MemoryStream()); Issue.record("\(failing): the run went on") }
                catch { #expect(error as? BrokerFailure == .terminal) }
            }
        }
    }

    @Test(.timeLimit(.minutes(1))) func drain_after_host_end_keeps_record_checks() async throws {
        // P41: after the broker's END the old stream is drained up to the launcher's END. Its guest
        // records are still parsed with their checks and discarded. An oversized record, or a first
        // length byte that proves one, fails the run as limits; any byte after the guest's logical EOF
        // fails it as a protocol violation (as today, where such bytes are read as the next control).
        let violations: [(String, LaneStage, Data, BrokerFailure)] = [
            ("oversized record", .draining, Data([0x10, 0x01, 1]), .limits),
            ("first length byte over 0x10", .draining, Data([0x11]), .limits),
            ("byte after the logical EOF", .drainedEOF, Data([7]), .invalidControl),
            ("record after the logical EOF", .drainedEOF, guestRecord(Data([7])), .invalidControl),
            ("the logical EOF and a byte in one DATA", .draining, Data([0, 0, 7]), .invalidControl),
        ]
        for (name, stage, late, code) in violations {
            let h = try Harness(connector: FakeConnector(queued: [StallingStream()]))
            let launcher = FakeLauncher()
            try await laneRun(h, [launcher]) { _, task in
                let lane = LaneView(launcher)
                try await reach(stage, h, lane)
                let before = launcher.records.count
                launcher.data(late); launcher.end(); launcher.open()                   // a drain without checks would serve OPEN
                await launcher.waitForRecords { $0.count > before }
                guard launcher.isClosed, launcher.records.count == before else { Issue.record("\(name): drained without the record checks"); throw LaneTestStop() }
                #expect(await outcome(task) as? BrokerFailure == code, "\(name)")
            }
        }
        // A launcher END inside a drained record, after the logical EOF, or after more records and the
        // EOF ends only that stream; the next stream follows on the lane.
        for (name, stage, late) in [("END inside a drained record", LaneStage.draining, Data([0, 5, 1, 2])),
                                    ("END after the logical EOF", .drainedEOF, Data()),
                                    ("records, the EOF, then END", .draining, guestRecord(Data([6, 6])) + guestRecord(Data()))] {
            let origin = MemoryStream()
            let h = try Harness(connector: FakeConnector(queued: [StallingStream(), origin]))
            let launcher = FakeLauncher()
            try await laneRun(h, [launcher]) { _, _ in
                let lane = LaneView(launcher)
                try await reach(stage, h, lane)
                if !late.isEmpty { launcher.data(late) }
                launcher.end()
                let nonce = try await lane.open()
                launcher.data(setup(control(sequence: 2), nonce) + guestRecord(Data([4])) + guestRecord(Data()))
                #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end], "\(name)")
                launcher.end()
                #expect(origin.written == Data([4]), "\(name)")
            }
        }
    }

    @Test(.timeLimit(.minutes(1))) func idle_ended_slot_still_fails_run_on_guest_protocol_violation() async throws {
        // Fix round 1, I-1, on a lane: after a host-first idle end, the tunnel's read in progress still
        // checks the guest's next record. An oversized record, or a first length byte that proves one
        // (then the launcher's END), fails the whole run as limits. It is never a per-slot end.
        for (late, ends) in [(Data([0x10, 0x01, 1]), false), (Data([0x11]), true)] {
            let h = try Harness(connector: FakeConnector(queued: [StallingStream()]))
            let launcher = FakeLauncher()
            try await laneRun(h, [launcher]) { broker, task in
                let lane = LaneView(launcher)
                try await reach(.tunnel, h, lane)
                await h.clock.waitForWaiters(2); h.clock.set(160, 30); h.clock.tick()  // host-first idle end
                #expect(try await lane.brokerEnd() == [.data(Data([0, 0])), .end])
                launcher.data(late); if ends { launcher.end() }
                await launcher.closed.wait()
                #expect(await outcome(task) as? BrokerFailure == .limits)
                do { _ = try await broker.accept(control: control(sequence: 2), stream: MemoryStream()); Issue.record("Protocol violation absorbed by a per-slot end") }
                catch { #expect(error as? BrokerFailure == .terminal) }
            }
        }
    }

    @Test(.timeLimit(.minutes(1))) func length_prefix_first_byte_out_of_range_is_violation_even_at_eof() async throws {
        // Fix round 1 (Minor 1 ruling), on a lane: a launcher END right after a length byte that already
        // proves an out-of-range length is a protocol violation, not a per-stream end. A first byte that
        // still allows a valid length, then END, ends only that stream, and the next stream follows.
        let n = brokerNonce(1200), proof = proofFor(control(), n)
        func lane(_ data: Data) -> BufferedStream {
            BufferedStream(laneOpenRecord + laneDataRecord(data) + laneEndRecord + laneOpenRecord + laneDataRecord(setup(control(sequence: 2), n)))
        }
        // Setup frames: a control of 1...256 bytes (first byte at most 01), a proof of 32 (first byte 00).
        for (data, violation) in [(Data([0x02]), true), (Data([0xff]), true), (Data([0x01]), false),
                                  (guestRecord(control()) + Data([0x01]), true), (guestRecord(control()) + Data([0x00]), false)] {
            do {
                let request = try await RelayChannel(physical: lane(data), nonces: ConstantBrokerNonces(n)).next()
                if violation { Issue.record("Truncated setup admitted") } else { #expect(request.control == control(sequence: 2), "only that stream ended") }
            } catch { #expect(violation && error as? BrokerFailure == .invalidControl) }
        }
        // Records, read by the stream and by the drain: at most 4096 bytes (first byte at most 10).
        for (tail, violation) in [(Data([0x11]), true), (Data([0x10]), false)] {
            let request = try await RelayChannel(physical: lane(guestRecord(control()) + guestRecord(proof) + tail), nonces: ConstantBrokerNonces(n)).next()
            do { _ = try await request.stream.read(maxBytes: 4096); Issue.record("Truncated record read") }
            catch { if violation { #expect(error as? BrokerFailure == .limits) } else { #expect(error is GuestStreamClosed) } }
            let drained = RelayChannel(physical: lane(guestRecord(control()) + guestRecord(proof) + tail), nonces: ConstantBrokerNonces(n))
            let stream = try await drained.next(); try await stream.stream.endWrite(); stream.stream.close()
            do {
                let following = try await drained.next()
                if violation { Issue.record("Truncated drain reused the lane") } else { #expect(following.control == control(sequence: 2)) }
            } catch { #expect(violation && error as? BrokerFailure == .limits) }
        }
    }

    @Test(.timeLimit(.minutes(1))) func lane_setup_framing_and_stream_reuse_rules() async throws {
        let n = brokerNonce(20), next = laneOpenRecord + laneDataRecord(setup(control(sequence: 2), n))
        // A control outside 1...256 bytes or a proof frame that is not exactly 32 bytes is a protocol violation.
        for data in [Data([0, 0]), guestRecord(Data(repeating: 1, count: 257)),
                     guestRecord(control()) + guestRecord(Data(repeating: 1, count: 31)) + Data(repeating: 0, count: 64),
                     guestRecord(control()) + Data([0, 33]), guestRecord(control()) + Data([0, 0])] {
            let physical = BufferedStream(laneOpenRecord + laneDataRecord(data) + laneEndRecord + next)
            do { _ = try await RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n)).next(); Issue.record("Malformed setup framing") }
            catch { #expect(error as? BrokerFailure == .invalidControl) }
        }
        // P40: a launcher END before or inside the setup ends only that stream, with no sequence used:
        // the broker answers END and the lane serves the next OPEN.
        for data in [Data(), Data([0]), guestRecord(control()), guestRecord(control()) + Data([0, 32, 1])] {
            let physical = BufferedStream(laneOpenRecord + (data.isEmpty ? Data() : laneDataRecord(data)) + laneEndRecord + next)
            let request = try await RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n)).next()
            #expect(request.control == control(sequence: 2))
            #expect(laneRecords(physical.output) == [.data(guestRecord(n)), .end, .data(guestRecord(n))])
        }
        // An oversized guest record is a protocol violation; the lane serves no next stream before its
        // current one is closed.
        let physical = BufferedStream(laneOpenRecord + laneDataRecord(setup(control(), n) + guestRecord(Data(repeating: 1, count: 4097))))
        let channel = RelayChannel(physical: physical, nonces: ConstantBrokerNonces(n)), request = try await channel.next()
        do { _ = try await request.stream.read(maxBytes: 4096); Issue.record("Oversized opaque record") } catch { #expect(error as? BrokerFailure == .limits) }
        do { _ = try await channel.next(); Issue.record("Lane reused before its stream closed") } catch { #expect(error as? BrokerFailure == .terminal) }
    }

    @Test(.timeLimit(.minutes(1))) func lane_partial_framing_logical_eof_reuse_and_old_stream() async throws {
        // One-byte pipe reads and writes. Each stream's first broker DATA is its challenge; END closes
        // the first stream before the second's OPEN is served; the old stream can no longer write.
        let n1 = brokerNonce(1), n2 = brokerNonce(2), p1 = proofFor(control(), n1), p2 = proofFor(control("BACKEND", sequence: 2), n2)
        let physical = BufferedStream(laneOpenRecord + laneDataRecord(guestRecord(control()) + guestRecord(p1) + guestRecord(Data([0, 255, 1])) + guestRecord(Data()))
                                      + laneEndRecord + laneOpenRecord + laneDataRecord(guestRecord(control("BACKEND", sequence: 2)) + guestRecord(p2) + guestRecord(Data())))
        let channel = RelayChannel(physical: physical, nonces: CountingBrokerNonces(start: 1)), first = try await channel.next()
        #expect(first.control == control()); #expect(first.nonce == n1); #expect(first.proof == p1)
        #expect(try await first.stream.read(maxBytes: 4096) == Data([0, 255, 1])); #expect(try await first.stream.read(maxBytes: 4096) == Data())
        #expect(try await first.stream.write(Data([7, 8])) == 2); try await first.stream.endWrite(); first.stream.close()
        let second = try await channel.next()
        #expect(second.control == control("BACKEND", sequence: 2)); #expect(second.nonce == n2); #expect(second.proof == p2)
        #expect(try await second.stream.read(maxBytes: 4096) == Data()); try await second.stream.endWrite(); second.stream.close()
        #expect(laneRecords(physical.output) == [.data(guestRecord(n1)), .data(guestRecord(Data([7, 8]))), .data(Data([0, 0])), .end,
                                                 .data(guestRecord(n2)), .data(Data([0, 0]))])
        #expect(physical.closes == 0)
        do { _ = try await first.stream.write(Data([9])); Issue.record("Old stream wrote into the next one") } catch { #expect(error as? BrokerFailure == .terminal) }
    }
}

// Fix round 3 (controller ruling M-6): relay supervision keeps a fail-closed backstop.
extension BrokerTests {
    @Test(.timeLimit(.minutes(1))) func run_relays_with_no_lanes_fails_run_transport() async throws {
        // Lanes never retire (P40), so a lane task ends only by failing the run. If every lane task
        // still returns, here because there are none, supervision fails the run as transport rather
        // than return normally.
        let h = try Harness()
        do { try await BrokerExecutable.runRelays(broker: h.broker, physical: [], nonces: CountingBrokerNonces()); Issue.record("Relay supervision returned normally") }
        catch { #expect(error as? BrokerFailure == .transport) }
        do { _ = try await h.broker.accept(control: control(), stream: MemoryStream()); Issue.record("The run went on without relay supervision") }
        catch { #expect(error as? BrokerFailure == .terminal) }
    }
}
