import Foundation
import Darwin
import CryptoKit

public enum BrokerFailure: String, Error, Sendable { case invalidControl, identity, expired, replay, capacity, address, transport, clock, limits, cancelled, terminal, descriptor, bootstrap }
public enum Destination: String, Sendable { case frontend = "FRONTEND", backend = "BACKEND" }
// C4 (E3, R5): the host challenges every guest vsock stream. It writes a 16-byte nonce first;
// the guest proxy answers with its control frame and then
//   proof = HMAC-SHA256(k_vsock, "acceptance:vsock-stream:v1\0" || nonce || runId (32 ASCII hex)
//                       || sequence (8-byte big-endian)),
// k_vsock = ChannelKeys.derive(capability, "vsock-stream"). The broker verifies the proof in
// constant time before sequence admission. A future VZ relay forwards bytes only.
public protocol BrokerNonceSource: Sendable { func nonce() throws -> Data }  // exactly 16 bytes
public struct SystemBrokerNonceSource: BrokerNonceSource {
    public init() {}
    public func nonce() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 16); arc4random_buf(&bytes, bytes.count); return Data(bytes)
    }
}
enum VsockStreamProof {
    static let domain = Data("acceptance:vsock-stream:v1\0".utf8)
    static func compute(key: Data, nonce: Data, runID: String, sequence: Int) -> Data {
        var message = domain
        message.append(nonce); message.append(contentsOf: Array(runID.utf8))
        withUnsafeBytes(of: UInt64(truncatingIfNeeded: sequence).bigEndian) { message.append(contentsOf: $0) }
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }
}
// P38: per-slot ends. Neither is a BrokerFailure, so any caller that does not handle one maps it
// to .transport and fails the run (fail closed).
struct SlotEnded: Error { let guestClosed: Bool }  // one tunnel ended alone: idle, or its guest closed
struct GuestStreamClosed: Error {}                 // the guest closed its stream without a logical EOF
public struct ClockSample: Sendable {
    public let wall: Int, monotonic: Int
    public init(wall: Int, monotonic: Int) { self.wall = wall; self.monotonic = monotonic }
}
public protocol BrokerClock: Sendable { func sample() throws -> ClockSample; func wait(milliseconds: Int) async throws }
public protocol ByteStream: Sendable {
    func read(maxBytes: Int) async throws -> Data
    func write(_ data: Data) async throws -> Int
    func endWrite() async throws
    // Must interrupt pending I/O; repeated close has no further effect.
    func close()
}
public protocol Resolver: Sendable { func resolve(host: String) async throws -> [NumericAddress] }
public protocol Connector: Sendable { func connect(address: NumericAddress, port: UInt16) async throws -> any ByteStream }
public struct NumericAddress: Sendable, Equatable {
    public let text: String
    let octets: [UInt8], family: Int32
    public init(_ text: String) throws {
        guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) || $0 == 46 || $0 == 58 }) else { throw BrokerFailure.address }
        var bytes = [UInt8](repeating:0,count:text.contains(":") ? 16 : 4)
        let family: Int32 = text.contains(":") ? AF_INET6 : AF_INET
        if family == AF_INET {
            let parts = text.split(separator:".",omittingEmptySubsequences:false)
            guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && ($0.count == 1 || $0.first != "0") && UInt8($0) != nil }) else { throw BrokerFailure.address }
        }
        guard text.withCString({ p in bytes.withUnsafeMutableBytes { inet_pton(family,p,$0.baseAddress) } }) == 1 else { throw BrokerFailure.address }
        self.text = text; self.octets = bytes; self.family = family
    }
    public var isPublic: Bool {
        let b = octets
        if family == AF_INET {
            if [0,10,127].contains(b[0]) || b[0] >= 224 { return false }
            if b[0] == 100 && (64...127).contains(b[1]) { return false }
            if b[0] == 169 && b[1] == 254 || b[0] == 172 && (16...31).contains(b[1]) { return false }
            if b[0] == 192 && (b[1] == 168 || b[1] == 0 && (b[2] == 0 || b[2] == 2) || b[1] == 88 && b[2] == 99) { return false }
            if b[0] == 198 && ((18...19).contains(b[1]) || b[1] == 51 && b[2] == 100) { return false }
            if b[0] == 203 && b[1] == 0 && b[2] == 113 { return false }
            return true
        }
        // Accept only global-unicast space. This excludes mapped/compatible,
        // NAT64, ULA, link-local, multicast and unspecified representations.
        guard b[0] & 0xe0 == 0x20 else { return false }
        if b[0] == 0x20 && b[1] == 0x02 { return false } // 6to4 embeds IPv4
        if b[0] == 0x20 && b[1] == 0x01 && b[2] < 2 { return false } // protocol assignments /23
        if b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8 { return false }
        if b[0] == 0x3f && b[1] == 0xff && b[2] & 0xf0 == 0 { return false }
        return true
    }
}
public struct BrokerLimits: Sendable, Equatable {
    public let bytes: Int, idleMs: Int
    public init(bytes: Int, idleMs: Int) { self.bytes = bytes; self.idleMs = idleMs }
}
public struct BrokerManifest: Sendable {
    public let identity: String, limits: BrokerLimits, durationMs: Int
    public init(identity: String, limits: BrokerLimits, durationMs: Int) { self.identity = identity; self.limits = limits; self.durationMs = durationMs }
}
public struct RunBinding: Sendable {
    public let runID: String, capability: Data, expiresAt: Int, firstSequence: Int
    public let manifest: BrokerManifest, configIdentity: String, origins: [Destination: String]
    public var durationMs: Int { manifest.durationMs }
    public init(runID: String, capability: Data, expiresAt: Int, firstSequence: Int, manifest: BrokerManifest, configIdentity: String, origins: [Destination: String]) {
        self.runID = runID; self.capability = capability; self.expiresAt = expiresAt; self.firstSequence = firstSequence
        self.manifest = manifest; self.configIdentity = configIdentity; self.origins = origins
    }
}
private final class OwnedStream: @unchecked Sendable {
    let stream: any ByteStream
    private let lock = NSLock(); private var closed = false
    init(_ stream: any ByteStream) { self.stream = stream }
    func close() { let first = lock.withLock { if closed { return false }; closed = true; return true }; if first { stream.close() } }
}

private protocol PendingWork: Sendable {
    func cancel()
}

// One pending external operation per slot. Cancellation wakes its owner without
// waiting for an uncooperative callback. A late stream result is disposed once.
private final class PendingOperation<Value: Sendable>: PendingWork, @unchecked Sendable {
    private let lock = NSLock()
    private let discard: @Sendable (Value) -> Void
    private var worker: Task<Void, Never>?
    private var continuation: CheckedContinuation<Value, any Error>?
    private var result: Result<Value, any Error>?
    private var finished = false
    private var cancelled = false

    init(
        discard: @escaping @Sendable (Value) -> Void = { _ in },
        operation: @escaping @Sendable () async throws -> Value
    ) {
        self.discard = discard
        if Task.isCancelled {
            cancelled = true
            return
        }
        let created = Task {
            do {
                try Task.checkCancellation()
                self.complete(.success(try await operation()))
            } catch {
                self.complete(.failure(error))
            }
        }
        lock.withLock {
            if !finished, !cancelled { worker = created }
        }
    }

    func value() async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let immediate = lock.withLock { () -> Result<Value, any Error>? in
                    if cancelled { return .failure(CancellationError()) }
                    if let result {
                        self.result = nil
                        return result
                    }
                    self.continuation = continuation
                    return nil
                }
                if let immediate { continuation.resume(with: immediate) }
            }
        } onCancel: {
            self.cancel()
        }
    }

    func cancel() {
        let pending = lock.withLock { () -> (Task<Void, Never>?, CheckedContinuation<Value, any Error>?, Value?) in
            guard !cancelled else { return (nil, nil, nil) }
            cancelled = true
            let task = worker
            let waiter = continuation
            let unused: Value?
            if case .success(let value) = result { unused = value } else { unused = nil }
            worker = nil
            continuation = nil
            result = nil
            return (task, waiter, unused)
        }
        // Task.cancel invokes a native connector's close handler synchronously.
        pending.0?.cancel()
        pending.1?.resume(throwing: CancellationError())
        if let unused = pending.2 { discard(unused) }
    }

    private func complete(_ value: Result<Value, any Error>) {
        let outcome = lock.withLock { () -> (CheckedContinuation<Value, any Error>?, Bool) in
            guard !cancelled, !finished else { return (nil, true) }
            finished = true
            worker = nil
            if let continuation {
                self.continuation = nil
                return (continuation, false)
            }
            result = value
            return (nil, false)
        }
        if outcome.1 {
            if case .success(let unused) = value { discard(unused) }
        } else {
            outcome.0?.resume(with: value)
        }
    }
}
public final class Tunnel: @unchecked Sendable {
    fileprivate let id: UUID, broker: EgressBroker, input: OwnedStream, output: OwnedStream
    private let lock = NSLock(); private var started = false, closed = false
    fileprivate init(id:UUID,broker:EgressBroker,input:OwnedStream,output:OwnedStream) { self.id = id; self.broker = broker; self.input = input; self.output = output }
    public func close() {
        lock.withLock { closed = true }
        input.close()
        output.close()
        Task { await broker.finish(id) }
    }
    public func run() async throws {
        guard lock.withLock({
            if started || closed { return false }
            started = true
            return true
        }) else { throw BrokerFailure.terminal }
        try await withTaskCancellationHandler {
            do {
                try await withThrowingTaskGroup(of: Int.self) { group in
                    group.addTask { try await self.pump(self.input.stream,self.output.stream,toGuest:false); return 1 }
                    group.addTask { try await self.pump(self.output.stream,self.input.stream,toGuest:true); return 1 }
                    var done = 0
                    do {
                        while let result = try await group.next() {
                            done += result
                            if done == 2 { group.cancelAll(); break }
                        }
                    } catch {
                        group.cancelAll()
                        await broker.fail(error as? BrokerFailure ?? .transport)
                        throw error
                    }
                }
                await broker.finish(id)
            } catch {
                await broker.fail(error as? BrokerFailure ?? .transport)
                throw error as? BrokerFailure ?? .transport
            }
        } onCancel: {
            input.close()
            output.close()
            Task { await self.broker.fail(.cancelled) }
        }
    }
    private func pump(_ source: any ByteStream, _ destination: any ByteStream, toGuest: Bool) async throws {
        var ended = false
        do {
            try await forward(source, destination, ended: &ended)
        } catch {
            // P38: a per-slot end (idle, or the guest's physical close) ends this tunnel only.
            // The pump toward the guest sends its logical EOF first (b), unless the guest has
            // closed its stream (c). Every other error still fails the run, and a protocol or limit
            // violation fails it even after the slot ended (fix round 1, I-1).
            if let failure = error as? BrokerFailure, failure == .limits || failure == .invalidControl { throw error }
            if error is GuestStreamClosed { await broker.endSlot(id, guestClosed: true) }
            guard let end = await broker.endedSlot(id) else { throw error }
            if toGuest, !ended, !end.guestClosed {
                // P39(b): if that write fails, the guest's side has gone: still this slot only.
                do { try await destination.endWrite() } catch is GuestStreamClosed { await broker.endSlot(id, guestClosed: true) }
            }
        }
    }
    private func forward(_ source: any ByteStream, _ destination: any ByteStream, ended: inout Bool) async throws {
        while true {
            try lock.withLock { guard !closed else { throw BrokerFailure.terminal } }
            try Task.checkCancellation()
            try await broker.check(id)
            let data = try await source.read(maxBytes:4096)
            try lock.withLock { guard !closed else { throw BrokerFailure.terminal } }
            try Task.checkCancellation()
            try await broker.check(id)
            guard data.count <= 4096 else { throw BrokerFailure.limits }
            if data.isEmpty {
                try await destination.endWrite()
                ended = true
                try await broker.check(id)
                return
            }
            try await broker.reserveBytes(data.count,id:id)
            var offset = 0
            while offset < data.count {
                try lock.withLock { guard !closed else { throw BrokerFailure.terminal } }
                try Task.checkCancellation()
                try await broker.check(id)
                let remaining = Data(data.dropFirst(offset))
                let n = try await destination.write(remaining)
                try lock.withLock { guard !closed else { throw BrokerFailure.terminal } }
                try Task.checkCancellation()
                try await broker.check(id)
                guard n > 0, n <= remaining.count else { throw BrokerFailure.transport }
                offset += n
                try await broker.progress(id)
            }
        }
    }
}
public actor EgressBroker {
    private struct Slot {
        let input: OwnedStream
        var output: OwnedStream?
        var lastProgress: Int
        var watch: Task<Void, Never>?
        var pending: (any PendingWork)?
        var ended = false, guestClosed = false  // P38: ended alone; its guest closed first
    }
    private let release: VerifiedRelease, authority: ReleaseAuthority, binding: RunBinding, limits: BrokerLimits
    private let resolver: any Resolver, connector: any Connector, clock: any BrokerClock
    private let physicalOwners: [OwnedStream]
    private let runEnd: Int
    private var last: ClockSample
    // P38(a): the lowest sequence the next stream may use; sequences strictly increase, with gaps.
    private var sequence: Int
    // C4: k_vsock, derived from the run capability (R6), and every challenge already answered.
    private let vsockKey: Data
    private var answered = Set<Data>()
    private var usedBytes = 0
    private var failure: BrokerFailure?
    private var slots = [UUID: Slot]()
    private var lifetimeWatch: Task<Void, Never>?
    public init(
        release: VerifiedRelease,
        authority: ReleaseAuthority,
        binding: RunBinding,
        limits: BrokerLimits,
        resolver: any Resolver,
        connector: any Connector,
        clock: any BrokerClock,
        physicalChannels: [any ByteStream] = []
    ) throws {
        let sample: ClockSample
        do {
            sample = try clock.sample()
        } catch {
            throw BrokerFailure.clock
        }
        guard sample.wall >= 0, sample.monotonic >= 0,
              sample.wall <= 9007199254740991, sample.monotonic <= 9007199254740991 else {
            throw BrokerFailure.clock
        }
        guard limits.bytes > 0, limits.bytes <= 9007199254740991,
              limits.idleMs > 0, limits.idleMs <= 9007199254740991,
              binding.durationMs > 0, binding.durationMs <= 1200000,
              binding.durationMs <= 9007199254740991 - sample.monotonic,
              binding.expiresAt > sample.wall, binding.expiresAt - sample.wall <= 1200000,
              binding.expiresAt <= 9007199254740991,
              binding.firstSequence > 0, binding.firstSequence <= 9007199254740991 else {
            throw BrokerFailure.limits
        }
        // R6: the host keeps the run capability and derives k_vsock from it (C3); there is no
        // second, "authenticated" capability. Stream proofs use only k_vsock (C4).
        guard let vsockKey = try? ChannelKeys.derive(capability:binding.capability,label:ChannelKeys.vsockStream),
              let r = ReceiptVerifier.inspectRelease(release,authority:authority,atWallTime:sample.wall), r["runId"] as? String == binding.runID,
              r["configIdentity"] as? String == binding.configIdentity,
              binding.manifest.identity.utf8.count == 64,
              binding.manifest.identity.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              binding.manifest.limits == limits,
              let releaseOrigins = r["origins"] as? [String: String], binding.origins.count == 2,
              binding.origins[.frontend] == releaseOrigins["FRONTEND"],
              binding.origins[.backend] == releaseOrigins["BACKEND"] else {
            throw BrokerFailure.identity
        }
        self.release = release
        self.authority = authority
        self.binding = binding
        self.vsockKey = vsockKey
        self.limits = limits
        self.resolver = resolver
        self.connector = connector
        self.clock = clock
        physicalOwners = physicalChannels.map(OwnedStream.init)
        last = sample
        runEnd = sample.monotonic + binding.durationMs
        sequence = binding.firstSequence
        // Overall expiry owns the physical transport even before a first tunnel
        // or while every logical slot is idle between sequential connections.
        Task { await self.startLifetimeWatch() }
    }
    private func startLifetimeWatch() {
        guard failure == nil, lifetimeWatch == nil else { return }
        lifetimeWatch = Task {
            do {
                while self.failure == nil {
                    let sample = try self.validate()
                    let delay = try self.authorityDelay(sample)
                    try await self.waitForClock(milliseconds: delay)
                    try Task.checkCancellation()
                }
            } catch {
                if error is CancellationError, Task.isCancelled { return }
                self.fail(error as? BrokerFailure ?? .clock)
            }
        }
    }
    private func authorityDelay(_ sample: ClockSample) throws -> Int {
        guard let expires = ReceiptVerifier.releaseUseDeadline(release, authority: authority, atWallTime: sample.wall),
              expires > sample.wall else {
            fail(.expired)
            throw BrokerFailure.expired
        }
        return min(expires - sample.wall, binding.expiresAt - sample.wall, runEnd - sample.monotonic)
    }
    private func validate() throws -> ClockSample {
        guard failure == nil else { throw BrokerFailure.terminal }
        let sample: ClockSample
        do {
            sample = try clock.sample()
        } catch {
            fail(.clock)
            throw BrokerFailure.clock
        }
        guard sample.wall >= last.wall, sample.monotonic >= last.monotonic,
              sample.wall <= 9007199254740991, sample.monotonic <= 9007199254740991 else {
            fail(.clock)
            throw BrokerFailure.clock
        }
        last = sample
        guard sample.wall < binding.expiresAt, sample.monotonic < runEnd,
              let r = ReceiptVerifier.inspectRelease(release, authority: authority, atWallTime: sample.wall),
              r["runId"] as? String == binding.runID else {
            fail(.expired)
            throw BrokerFailure.expired
        }
        return sample
    }
    public func accept(request: RelayRequest) async throws -> Tunnel {
        let input = OwnedStream(request.stream)
        return try await withTaskCancellationHandler {
            try await admit(request:request,input:input)
        } onCancel: {
            input.close()
            Task { await self.fail(.cancelled) }
        }
    }
    private func admit(request: RelayRequest, input: OwnedStream) async throws -> Tunnel {
        var reserved: UUID?
        do {
            try Task.checkCancellation()
            let sample = try validate()
            let f: ValidatedFrame
            do {
                f = try Contracts.decode(request.control, kind: .control)
            } catch {
                throw BrokerFailure.invalidControl
            }
            let p = f.value["payload"] as! [String:Any]
            guard f.value["runId"] as? String == binding.runID, let claimed = f.value["sequence"] as? Int else { throw BrokerFailure.identity }
            // C4: the stream's proof, compared in constant time before sequence admission. Each
            // challenge value answers one stream only.
            let expected = VsockStreamProof.compute(key: vsockKey, nonce: request.nonce, runID: binding.runID, sequence: claimed)
            guard request.nonce.count == 16, request.proof.count == expected.count,
                  zip(expected, request.proof).reduce(UInt8(0), { $0 | ($1.0 ^ $1.1) }) == 0,
                  answered.insert(request.nonce).inserted else { throw BrokerFailure.identity }
            // P38(a): strictly increasing, gaps allowed (a guest stream closed before its control
            // was delivered); never a repeat or a decrease.
            guard claimed >= sequence else { throw BrokerFailure.replay }
            // T9-7 (C9): the proxy and the broker are phase-unaware. The guest sends CONTROL.phase
            // and .event as fixed constants, so this check is not phase enforcement; the route
            // gate is the phase authority for egress.
            guard let destination = Destination(rawValue: p["destination"] as! String),
                  !["DONE", "FAILED", "FINALIZE"].contains(p["phase"] as! String),
                  p["event"] as? String != "abort" else { throw BrokerFailure.invalidControl }
            guard slots.count < 16 else { throw BrokerFailure.capacity }
            guard let r = ReceiptVerifier.inspectRelease(release, authority: authority, atWallTime: sample.wall),
                  let origins = r["origins"] as? [String: String],
                  let origin = origins[destination.rawValue], origin.hasPrefix("https://") else {
                throw BrokerFailure.identity
            }
            let host = String(origin.dropFirst(8))
            let id = UUID()
            reserved = id
            slots[id] = Slot(input: input, lastProgress: sample.monotonic)
            sequence = claimed + 1
            // This watchdog starts while the slot is pending, before DNS or connect.
            slots[id]?.watch = Task {
                do {
                    try await self.watch(id)
                } catch {
                    if error is CancellationError, Task.isCancelled { return }
                    if error is SlotEnded { return }  // P38: per slot, never a run failure
                    self.fail(error as? BrokerFailure ?? .clock)
                }
            }
            let resolving = PendingOperation { [resolver] in
                try await resolver.resolve(host: host)
            }
            slots[id]?.pending = resolving
            let answers = try await resolving.value()
            slots[id]?.pending = nil
            try Task.checkCancellation()
            try check(id)
            guard slots[id] != nil else { throw BrokerFailure.terminal }
            guard !answers.isEmpty, answers.allSatisfy(\.isPublic) else { throw BrokerFailure.address }
            let address = answers[0]
            let connecting = PendingOperation<any ByteStream>(discard: { $0.close() }) { [connector] in
                try await connector.connect(address: address, port: 443)
            }
            slots[id]?.pending = connecting
            let output = OwnedStream(try await connecting.value())
            slots[id]?.pending = nil
            // Take ownership immediately, even when the final checks will fail.
            guard slots[id] != nil else {
                output.close()
                throw BrokerFailure.terminal
            }
            slots[id]?.output = output
            try Task.checkCancellation()
            try check(id)
            guard slots[id] != nil else { throw BrokerFailure.terminal }
            return Tunnel(id: id, broker: self, input: input, output: output)
        } catch {
            // P38(b): a pending slot that went idle ends only itself. Its guest stream gets the
            // logical EOF before it closes. A failed physical write on its lane is that lane's end
            // (P39(b)); any other failure to write it is a run failure.
            if let reserved, let end = endedSlot(reserved) {
                var failed = false
                if !end.guestClosed {
                    do { try await input.stream.endWrite() } catch is GuestStreamClosed {} catch { failed = true }
                }
                input.close(); finish(reserved)
                guard !failed else { fail(.transport); throw BrokerFailure.transport }
                throw end
            }
            input.close()
            if let reserved { finish(reserved) }
            let code: BrokerFailure = error is CancellationError ? .cancelled : error as? BrokerFailure ?? .transport
            // A failed admission cannot become a retry or a resumed run.
            fail(code)
            throw code
        }
    }
    public func fail(_ code: BrokerFailure) {
        guard failure == nil else { return }
        failure = code
        lifetimeWatch?.cancel()
        let owned = slots.values
        slots.removeAll()
        for slot in owned {
            slot.watch?.cancel()
            slot.pending?.cancel()
            slot.input.close()
            slot.output?.close()
        }
        physicalOwners.forEach { $0.close() }
    }
    fileprivate func finish(_ id:UUID) {
        guard let slot = slots.removeValue(forKey:id) else { return }
        slot.watch?.cancel()
        slot.pending?.cancel()
        slot.input.close()
        slot.output?.close()
    }
    // P38: end one slot without failing the run. Its origin connection closes now; its tunnel then
    // sends the guest a logical EOF (unless the guest closed first) and finishes.
    fileprivate func endSlot(_ id: UUID, guestClosed: Bool) {
        guard failure == nil, let slot = slots[id] else { return }
        if guestClosed { slots[id]?.guestClosed = true }
        guard !slot.ended else { return }
        slots[id]?.ended = true
        slot.watch?.cancel()
        slot.pending?.cancel()
        slot.output?.close()
    }
    fileprivate func endedSlot(_ id: UUID) -> SlotEnded? {
        guard failure == nil, let slot = slots[id], slot.ended else { return nil }
        return SlotEnded(guestClosed: slot.guestClosed)
    }
    fileprivate func check(_ id: UUID) throws {
        let sample = try validate()
        guard let slot = slots[id] else { throw BrokerFailure.terminal }
        if slot.ended { throw SlotEnded(guestClosed: slot.guestClosed) }
        guard sample.monotonic - slot.lastProgress < limits.idleMs else {
            // T9-2, P38(b): an idle slot closes only itself; the run continues.
            endSlot(id, guestClosed: false)
            throw SlotEnded(guestClosed: false)
        }
    }
    fileprivate func progress(_ id: UUID) throws {
        try check(id)
        slots[id]?.lastProgress = last.monotonic
    }
    fileprivate func reserveBytes(_ n: Int, id: UUID) throws {
        try check(id)
        guard n <= limits.bytes - usedBytes else {
            fail(.limits)
            throw BrokerFailure.limits
        }
        usedBytes += n
    }
    private func waitForClock(milliseconds: Int) async throws {
        do {
            try await clock.wait(milliseconds: milliseconds)
        } catch {
            if error is CancellationError, Task.isCancelled { throw error }
            throw BrokerFailure.clock
        }
    }
    fileprivate func watch(_ id: UUID) async throws {
        while true {
            try check(id)
            guard let slot = slots[id] else { return }
            let delay = min(limits.idleMs - (last.monotonic - slot.lastProgress), try authorityDelay(last))
            try await waitForClock(milliseconds: delay)
            try Task.checkCancellation()
        }
    }
    public var activeCount: Int { slots.count }
}
public struct NumericSocketAddress: Sendable {
    public let family: Int32, port: UInt16, bytes: Data, scopeID: UInt32
    public init(address: NumericAddress, port: UInt16) throws {
        guard port == 443, address.isPublic else { throw BrokerFailure.address }
        family = address.family; self.port = port; scopeID = 0
        if family == AF_INET {
            var a = sockaddr_in(); a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); a.sin_family = sa_family_t(AF_INET); a.sin_port = port.bigEndian
            withUnsafeMutableBytes(of:&a.sin_addr) { $0.copyBytes(from:address.octets) }; bytes = withUnsafeBytes(of:a) { Data($0) }
        } else {
            var a = sockaddr_in6(); a.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size); a.sin6_family = sa_family_t(AF_INET6); a.sin6_port = port.bigEndian; a.sin6_scope_id = 0
            withUnsafeMutableBytes(of:&a.sin6_addr) { $0.copyBytes(from:address.octets) }; bytes = withUnsafeBytes(of:a) { Data($0) }
        }
    }
}
public struct BrokerDescriptor: Sendable {
    public enum Role: Sendable { case null, bootstrap, relayRead, relayWrite, terminal, console, privateEvidence, other }
    public let fd:Int32, role:Role
    public init(fd:Int32,role:Role) { self.fd = fd; self.role = role }
}
public enum BrokerBootstrap {
    public static func audit(_ inventory:[BrokerDescriptor],arguments:[String],environment:[String:String]) throws {
        guard arguments.isEmpty, environment.isEmpty, inventory.count == 36, Set(inventory.map(\.fd)) == Set((0...35).map(Int32.init)) else { throw BrokerFailure.descriptor }
        for d in inventory { let expected: BrokerDescriptor.Role = d.fd < 3 ? .null : d.fd == 3 ? .bootstrap : d.fd % 2 == 0 ? .relayRead : .relayWrite; guard d.role == expected else { throw BrokerFailure.descriptor } }
    }
}

// Narrow native-call ports. Tests must supply every result; no real defaults.
public protocol NativeIOCalls: Sendable {
    func configure(fd:Int32) throws
    func read(fd:Int32,maxBytes:Int) throws -> Data?
    func write(fd:Int32,data:Data) throws -> Int?
    func endWrite(fd:Int32) throws
    func close(fd:Int32)
    func wait() async throws
}
public protocol NativeSocketCalls: NativeIOCalls {
    func open(family:Int32) throws -> Int32
    func protectFromSIGPIPE(fd:Int32) throws
    func connect(fd:Int32,address:NumericSocketAddress) throws -> Bool
    func finishConnect(fd:Int32) throws -> Bool
}
public protocol NativeResolverCalls: Sendable {
    func resolve(query:String,family:Int32,socketType:Int32,flags:Int32) async throws -> [String]
}
public struct NativeResolver: Resolver {
    private let native: any NativeResolverCalls
    public init(native:any NativeResolverCalls) { self.native = native }
    public func resolve(host:String) async throws -> [NumericAddress] {
        guard !Task.isCancelled else { throw BrokerFailure.cancelled }
        let labels = host.split(separator:".",omittingEmptySubsequences:false)
        guard host.utf8.count <= 253, labels.count >= 2, !host.hasSuffix("."),
              labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 && $0.first != "-" && $0.last != "-" && $0.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }) }),
              (try? NumericAddress(host)) == nil else { throw BrokerFailure.address }
        do {
            // Absolute root-qualified query prevents system search-suffix expansion.
            let lookup = PendingOperation { [native] in
                try await native.resolve(query: host + ".", family: AF_UNSPEC, socketType: SOCK_STREAM, flags: AI_ADDRCONFIG | AI_NUMERICSERV)
            }
            let values = try await lookup.value()
            try Task.checkCancellation()
            return try values.map(NumericAddress.init)
        } catch is CancellationError { throw BrokerFailure.cancelled }
        catch { throw error as? BrokerFailure ?? .transport }
    }
}
public final class DescriptorStream: ByteStream, @unchecked Sendable {
    private let fd:Int32, native:any NativeIOCalls, lock = NSLock()
    private var closed = false, outputEnded = false
    public init(fd:Int32,native:any NativeIOCalls) throws {
        self.fd = fd; self.native = native
        do { try native.configure(fd:fd) } catch { native.close(fd:fd); throw BrokerFailure.transport }
    }
    fileprivate func withFD<T>(_ operation:(Int32) throws -> T) throws -> T {
        try lock.withLock { guard !closed else { throw BrokerFailure.terminal }; return try operation(fd) }
    }
    public func read(maxBytes:Int) async throws -> Data {
        guard maxBytes > 0, maxBytes <= 4096 else { throw BrokerFailure.limits }
        do {
            while true {
                try Task.checkCancellation()
                if let data = try withFD({ try native.read(fd:$0,maxBytes:maxBytes) }) {
                    guard data.count <= maxBytes else { throw BrokerFailure.limits }; return data
                }
                try await native.wait()
            }
        } catch is CancellationError { close(); throw BrokerFailure.cancelled }
        catch { close(); throw error as? BrokerFailure ?? .transport }
    }
    public func write(_ data:Data) async throws -> Int {
        guard !data.isEmpty, data.count <= 4096 else { throw BrokerFailure.limits }
        do {
            while true {
                try Task.checkCancellation()
                let result = try withFD { fd in guard !outputEnded else { throw BrokerFailure.terminal }; return try native.write(fd:fd,data:data) }
                if let result { guard result > 0, result <= data.count else { throw BrokerFailure.transport }; return result }
                try await native.wait()
            }
        } catch is CancellationError { close(); throw BrokerFailure.cancelled }
        catch { close(); throw error as? BrokerFailure ?? .transport }
    }
    public func endWrite() async throws {
        do { try withFD { fd in if !outputEnded { try native.endWrite(fd:fd); outputEnded = true } } }
        catch { close(); throw error as? BrokerFailure ?? .transport }
    }
    public func close() {
        lock.withLock { if !closed { closed = true; native.close(fd:fd) } }
    }
}
public struct NativeConnector: Connector {
    private let native:any NativeSocketCalls
    public init(native:any NativeSocketCalls) { self.native = native }
    public func connect(address:NumericAddress,port:UInt16) async throws -> any ByteStream {
        guard !Task.isCancelled else { throw BrokerFailure.cancelled }
        let a = try NumericSocketAddress(address:address,port:port)
        let fd:Int32
        do { fd = try native.open(family:a.family) } catch { throw BrokerFailure.transport }
        guard fd >= 0 else { throw BrokerFailure.transport }
        let stream = try DescriptorStream(fd:fd,native:native)
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                var connected = try stream.withFD { fd in
                    try native.protectFromSIGPIPE(fd: fd)
                    return try native.connect(fd: fd, address: a)
                }
                while !connected {
                    let waiting = PendingOperation { [native] in try await native.wait() }
                    try await waiting.value()
                    try Task.checkCancellation()
                    connected = try stream.withFD { try native.finishConnect(fd: $0) }
                }
                try Task.checkCancellation()
                return stream
            } catch {
                stream.close()
                throw error is CancellationError ? BrokerFailure.cancelled : error as? BrokerFailure ?? .transport
            }
        } onCancel: {
            stream.close()
        }
    }
}
public struct DescriptorFacts: Sendable {
    public enum Kind: Sendable { case null, pipe, other }
    public let fd:Int32, kind:Kind, direction:Int32, uid:UInt32, device:UInt64, inode:UInt64, tty:Bool
    public init(fd:Int32,kind:Kind,direction:Int32,uid:UInt32,device:UInt64,inode:UInt64,tty:Bool) {
        self.fd = fd; self.kind = kind; self.direction = direction; self.uid = uid; self.device = device; self.inode = inode; self.tty = tty
    }
}
extension BrokerBootstrap {
    public static func auditFacts(_ facts:[DescriptorFacts],uid:UInt32,arguments:[String],environment:[String:String]) throws {
        guard arguments.isEmpty, environment.isEmpty, facts.count == 36,
              Set(facts.map(\.fd)) == Set((0...35).map(Int32.init)) else { throw BrokerFailure.descriptor }
        var pipes = Set<String>()
        for f in facts {
            guard !f.tty else { throw BrokerFailure.descriptor }
            if f.fd < 3 { guard f.kind == .null else { throw BrokerFailure.descriptor }; continue }
            guard f.kind == .pipe, f.uid == uid, f.direction == (f.fd == 3 || f.fd % 2 == 0 ? O_RDONLY : O_WRONLY),
                  pipes.insert("\(f.device):\(f.inode)").inserted else { throw BrokerFailure.descriptor }
        }
    }
}
private func readExact(_ stream:any ByteStream,_ count:Int,_ lane:RelayState? = nil) async throws -> Data {
    guard count >= 0, count <= 32768 else { throw BrokerFailure.limits }
    var result = Data()
    while result.count < count {
        try Task.checkCancellation()
        let maxRead = min(4096,count - result.count), part = try await stream.read(maxBytes:maxRead)
        // P38(c): on a relay lane, the guest's physical close (at or inside a record) ends that lane only.
        if part.isEmpty, let lane { lane.lock.withLock { lane.physicalEnded = true }; throw GuestStreamClosed() }
        guard !part.isEmpty, part.count <= maxRead else { throw BrokerFailure.transport }
        result.append(part)
    }
    return result
}
private func writeAll(_ stream:any ByteStream,_ data:Data) async throws {
    var offset = 0
    while offset < data.count {
        try Task.checkCancellation()
        let part = Data(data.dropFirst(offset).prefix(4096)), n = try await stream.write(part)
        guard n > 0, n <= part.count else { throw BrokerFailure.transport }; offset += n
    }
}
// The first length byte is read and checked on its own: a byte that already proves an out-of-range
// length is a protocol violation at once, even if the guest's stream then ends (fix round 1).
private func readLength(_ stream:any ByteStream,_ lane:RelayState?,firstAtMost:UInt8,violation:BrokerFailure) async throws -> Int {
    let high = try await readExact(stream,1,lane)[0]
    guard high <= firstAtMost else { throw violation }
    return Int(high) << 8 | Int(try await readExact(stream,1,lane)[0])
}
private func framed(_ data:Data) -> Data { Data([UInt8(data.count >> 8),UInt8(data.count & 255)]) + data }
private final class RelayState: @unchecked Sendable {
    let lock = NSLock(); var inputEOF = false, outputEOF = false, closed = false, physicalEnded = false
}
private final class RelayStream: ByteStream, @unchecked Sendable {
    let physical:any ByteStream, state:RelayState
    init(_ physical:any ByteStream,_ state:RelayState) { self.physical = physical; self.state = state }
    func read(maxBytes:Int) async throws -> Data {
        guard maxBytes > 0, maxBytes <= 4096 else { throw BrokerFailure.limits }
        let ended = try state.lock.withLock { guard !state.closed else { throw BrokerFailure.terminal }; return state.inputEOF }
        if ended { return Data() }
        let n = try await readLength(physical,state,firstAtMost:0x10,violation:.limits)
        guard n <= 4096, n <= maxBytes else { throw BrokerFailure.limits }
        if n == 0 { state.lock.withLock { state.inputEOF = true }; return Data() }
        return try await readExact(physical,n,state)
    }
    func write(_ data:Data) async throws -> Int {
        guard !data.isEmpty, data.count <= 4096 else { throw BrokerFailure.limits }
        try state.lock.withLock { guard !state.closed, !state.outputEOF else { throw BrokerFailure.terminal } }
        try await toLane(framed(data)); return data.count
    }
    func endWrite() async throws {
        let already = try state.lock.withLock { guard !state.closed else { throw BrokerFailure.terminal }; return state.outputEOF }
        if !already { try await toLane(Data([0,0])); state.lock.withLock { state.outputEOF = true } }
    }
    // P39(b): a failed physical write means the guest's side of this lane has gone. Like the guest's
    // physical close it ends this slot and lane only; cancellation is not such a failure.
    private func toLane(_ data:Data) async throws {
        do { try await writeAll(physical,data) }
        catch let error where error is CancellationError || error as? BrokerFailure == .cancelled { throw error }
        catch { state.lock.withLock { state.physicalEnded = true }; throw GuestStreamClosed() }
    }
    func close() { state.lock.withLock { state.closed = true } }
}
public struct RelayRequest: Sendable { public let control:Data, nonce:Data, proof:Data, stream:any ByteStream }
public actor RelayChannel {
    private let physical:any ByteStream, nonces:any BrokerNonceSource
    private var previous:RelayState?, loading = false
    public init(physical:any ByteStream,nonces:any BrokerNonceSource) { self.physical = physical; self.nonces = nonces }
    public func next() async throws -> RelayRequest {
        guard !loading else { throw BrokerFailure.terminal }
        loading = true; defer { loading = false }
        if let previous { try await release(previous) }
        let state = RelayState()
        previous = state
        // C4: the challenge frame (length 16, then a fresh nonce) precedes the stream's control.
        guard let nonce = try? nonces.nonce(), nonce.count == 16 else { throw BrokerFailure.identity }
        try await writeAll(physical,framed(nonce))
        let n = try await readLength(physical,state,firstAtMost:0x01,violation:.invalidControl)
        guard n > 0, n <= 256 else { throw BrokerFailure.invalidControl }
        let control = try await readExact(physical,n,state)
        guard try await readLength(physical,state,firstAtMost:0x00,violation:.invalidControl) == 32 else { throw BrokerFailure.invalidControl }
        let proof = try await readExact(physical,32,state)
        return RelayRequest(control:control,nonce:nonce,proof:proof,stream:RelayStream(physical,state))
    }
    // The lane's previous stream: reusable after both logical EOFs. After a host-first close
    // (P38(b): the host's logical EOF written, the stream closed) the guest's remaining records of
    // it are read and discarded up to its logical EOF. After the guest's physical close (P38(c))
    // the lane is over.
    private func release(_ state:RelayState) async throws {
        let (closed,inputEOF,outputEOF,ended) = state.lock.withLock { (state.closed,state.inputEOF,state.outputEOF,state.physicalEnded) }
        if ended { throw GuestStreamClosed() }
        guard closed, outputEOF else { throw BrokerFailure.terminal }
        if inputEOF { return }
        // No deadline of its own: bounded by the run lifetime and the guest's own idle close.
        while true {
            let n = try await readLength(physical,state,firstAtMost:0x10,violation:.limits)
            guard n <= 4096 else { throw BrokerFailure.limits }
            if n == 0 { return }
            _ = try await readExact(physical,n,state)
        }
    }
}

// These implementations are compiled only in M2. No test invokes Darwin calls.
public struct DarwinNetworkCalls: NativeSocketCalls, NativeResolverCalls {
    public init() {}
    public func configure(fd:Int32) throws {
        let flags = fcntl(fd,F_GETFL)
        guard flags >= 0, fcntl(fd,F_SETFL,flags | O_NONBLOCK) == 0, fcntl(fd,F_SETFD,FD_CLOEXEC) == 0 else { throw BrokerFailure.transport }
    }
    public func open(family:Int32) throws -> Int32 {
        guard family == AF_INET || family == AF_INET6 else { throw BrokerFailure.address }
        let fd = Darwin.socket(family,SOCK_STREAM,IPPROTO_TCP)
        guard fd >= 0 else { throw BrokerFailure.transport }; return fd
    }
    public func protectFromSIGPIPE(fd:Int32) throws {
        var one:Int32 = 1
        guard setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&one,socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw BrokerFailure.transport }
    }
    public func connect(fd:Int32,address:NumericSocketAddress) throws -> Bool {
        let result = address.bytes.withUnsafeBytes { Darwin.connect(fd,$0.baseAddress!.assumingMemoryBound(to:sockaddr.self),socklen_t($0.count)) }
        if result == 0 { return true }
        if errno == EINPROGRESS || errno == EINTR { return false }
        throw BrokerFailure.transport
    }
    public func finishConnect(fd:Int32) throws -> Bool {
        var p = pollfd(fd:fd,events:Int16(POLLOUT),revents:0)
        let ready = Darwin.poll(&p,1,0)
        if ready == 0 { return false }
        guard ready > 0 else { if errno == EINTR { return false }; throw BrokerFailure.transport }
        var error:Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&length) == 0, error == 0 else { throw BrokerFailure.transport }
        return true
    }
    public func read(fd:Int32,maxBytes:Int) throws -> Data? {
        var data = Data(count:maxBytes)
        let n = data.withUnsafeMutableBytes { Darwin.read(fd,$0.baseAddress,maxBytes) }
        if n >= 0 { data.count = n; return data }
        if errno == EAGAIN || errno == EINTR { return nil }; throw BrokerFailure.transport
    }
    public func write(fd:Int32,data:Data) throws -> Int? {
        let n = data.withUnsafeBytes { Darwin.write(fd,$0.baseAddress,$0.count) }
        if n >= 0 { return n }
        if errno == EAGAIN || errno == EINTR { return nil }; throw BrokerFailure.transport
    }
    public func endWrite(fd:Int32) throws { guard Darwin.shutdown(fd,SHUT_WR) == 0 else { throw BrokerFailure.transport } }
    public func close(fd:Int32) { _ = Darwin.shutdown(fd,SHUT_RDWR); _ = Darwin.close(fd) }
    public func wait() async throws { try await Task.sleep(for:.milliseconds(1)) }
    public func resolve(query:String,family:Int32,socketType:Int32,flags:Int32) async throws -> [String] {
        let task = Task.detached {
            var hints = addrinfo(); hints.ai_family = family; hints.ai_socktype = socketType; hints.ai_protocol = IPPROTO_TCP; hints.ai_flags = flags
            var result:UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(query,"443",&hints,&result) == 0, let first = result else { throw BrokerFailure.transport }
            defer { freeaddrinfo(first) }
            var cursor:UnsafeMutablePointer<addrinfo>? = first, values = [String]()
            while let row = cursor {
                try Task.checkCancellation()
                let a = row.pointee
                guard a.ai_socktype == SOCK_STREAM, a.ai_protocol == IPPROTO_TCP, let pointer = a.ai_addr else { throw BrokerFailure.address }
                var text = [CChar](repeating:0,count:Int(INET6_ADDRSTRLEN))
                if a.ai_family == AF_INET, a.ai_addrlen >= MemoryLayout<sockaddr_in>.size {
                    var address = UnsafeRawPointer(pointer).assumingMemoryBound(to:sockaddr_in.self).pointee.sin_addr
                    guard inet_ntop(AF_INET,&address,&text,socklen_t(text.count)) != nil else { throw BrokerFailure.address }
                } else if a.ai_family == AF_INET6, a.ai_addrlen >= MemoryLayout<sockaddr_in6>.size {
                    let socket = UnsafeRawPointer(pointer).assumingMemoryBound(to:sockaddr_in6.self).pointee
                    guard socket.sin6_scope_id == 0 else { throw BrokerFailure.address }
                    var address = socket.sin6_addr
                    guard inet_ntop(AF_INET6,&address,&text,socklen_t(text.count)) != nil else { throw BrokerFailure.address }
                } else { throw BrokerFailure.address }
                values.append(String(decoding:text.prefix { $0 != 0 }.map { UInt8(bitPattern:$0) },as:UTF8.self)); cursor = a.ai_next
                guard values.count <= 256 else { throw BrokerFailure.address }
            }
            return values
        }
        // Cancellation cannot interrupt synchronous getaddrinfo. It releases the
        // owned wait promptly; the detached lookup later frees its own result.
        return try await withTaskCancellationHandler {
            try await PendingOperation { try await task.value }.value()
        } onCancel: {
            task.cancel()
        }
    }
}

private struct BootstrapCursor {
    let data:Data; var offset = 0
    mutating func take(_ n:Int) throws -> Data { guard n >= 0, n <= data.count - offset else { throw BrokerFailure.bootstrap }; defer { offset += n }; return Data(data.dropFirst(offset).prefix(n)) }
    mutating func integer(_ n:Int) throws -> Int { let bytes = try take(n); var value:UInt64 = 0; for byte in bytes { value = value << 8 | UInt64(byte) }; guard value <= 9007199254740991 else { throw BrokerFailure.bootstrap }; return Int(value) }
    mutating func receipt() throws -> Data { let n = try integer(2); guard n > 0, n <= 16384 else { throw BrokerFailure.bootstrap }; return try take(n) }
}
public struct BootstrapConfiguration: Sendable {
    public let expectedRelease:Data, candidateRelease:Data, publicKey:Data, binding:RunBinding, limits:BrokerLimits
    public let maxAgeMs:Int, notBefore:Int, releaseDeadline:Int
    public static func decode(_ data:Data) throws -> BootstrapConfiguration {
        guard data.count <= 32768 else { throw BrokerFailure.bootstrap }
        var cursor = BootstrapCursor(data:data); guard try cursor.take(4) == Data("ABR1".utf8) else { throw BrokerFailure.bootstrap }
        let expected = try cursor.receipt(), candidate = try cursor.receipt(), key = try cursor.take(32)
        func hexString(_ d:Data) -> String { d.map { String(format:"%02x",$0) }.joined() }
        let run = try hexString(cursor.take(16)), capability = try cursor.take(32), manifest = try hexString(cursor.take(32)), config = try hexString(cursor.take(32))
        let maxAge = try cursor.integer(8), notBefore = try cursor.integer(8), deadline = try cursor.integer(8), expires = try cursor.integer(8), bytes = try cursor.integer(8), idle = try cursor.integer(8), duration = try cursor.integer(8), sequence = try cursor.integer(8)
        guard cursor.offset == data.count, maxAge > 0, notBefore < deadline, deadline > 0, expires > 0,
              bytes > 0, idle > 0, duration > 0, sequence > 0 else { throw BrokerFailure.bootstrap }
        _ = try Contracts.decode(candidate,kind:.releaseReceipt)
        let f = try Contracts.decode(expected,kind:.releaseReceipt), payload = f.value["payload"] as! [String:Any], map = payload["origins"] as! [String:String]
        let limits = BrokerLimits(bytes:bytes,idleMs:idle), binding = RunBinding(runID:run,capability:capability,expiresAt:expires,firstSequence:sequence,manifest:BrokerManifest(identity:manifest,limits:limits,durationMs:duration),configIdentity:config,origins:[.frontend:map["FRONTEND"]!, .backend:map["BACKEND"]!])
        return BootstrapConfiguration(expectedRelease:expected,candidateRelease:candidate,publicKey:key,binding:binding,limits:limits,maxAgeMs:maxAge,notBefore:notBefore,releaseDeadline:deadline)
    }
    public func makeBroker(resolver:any Resolver,connector:any Connector,clock:any BrokerClock,physicalChannels:[any ByteStream]) throws -> EgressBroker {
        let authority = try ReleaseAuthority(expectedRelease:expectedRelease,publicKey:publicKey,maxAgeMs:maxAgeMs,notBefore:notBefore,deadline:releaseDeadline)
        let sample: ClockSample
        do { sample = try clock.sample() } catch { throw BrokerFailure.clock }
        let release = try ReceiptVerifier.verifyRelease(candidateRelease,authority:authority,atWallTime:sample.wall)
        return try EgressBroker(release:release,authority:authority,binding:binding,limits:limits,resolver:resolver,connector:connector,clock:clock,physicalChannels:physicalChannels)
    }
}
extension BrokerBootstrap {
    public static func load(stream:any ByteStream,clock:any BrokerClock,timeoutMs:Int) async throws -> BootstrapConfiguration {
        let owned = OwnedStream(stream)
        guard timeoutMs > 0, timeoutMs <= 120000 else { owned.close(); throw BrokerFailure.bootstrap }
        defer { owned.close() }
        return try await withTaskCancellationHandler {
            do {
                return try await withThrowingTaskGroup(of:BootstrapConfiguration.self) { group in
                    group.addTask {
                        let prefix = try await readExact(stream,4)
                        let n = prefix.reduce(0) { ($0 << 8) | Int($1) }
                        guard n > 0, n <= 32768 else { throw BrokerFailure.bootstrap }
                        let data = try await readExact(stream,n)
                        guard try await stream.read(maxBytes:1).isEmpty else { throw BrokerFailure.bootstrap }
                        return try BootstrapConfiguration.decode(data)
                    }
                    group.addTask { try await clock.wait(milliseconds:timeoutMs); owned.close(); throw BrokerFailure.bootstrap }
                    do { let configuration = try await group.next()!; group.cancelAll(); return configuration }
                    catch { group.cancelAll(); owned.close(); throw error }
                }
            } catch { throw error as? BrokerFailure ?? .bootstrap }
        } onCancel: { owned.close() }
    }
}

public struct SystemBrokerClock: BrokerClock {
    public init() {}
    public func sample() throws -> ClockSample {
        let wall = Date().timeIntervalSince1970 * 1000
        let monotonic = DispatchTime.now().uptimeNanoseconds / 1_000_000
        guard wall.isFinite, wall >= 0, wall <= 9007199254740991, monotonic <= 9007199254740991 else { throw BrokerFailure.clock }
        return ClockSample(wall:Int(wall),monotonic:Int(monotonic))
    }
    public func wait(milliseconds:Int) async throws {
        guard milliseconds > 0, milliseconds <= 9007199254740991 else { throw BrokerFailure.clock }
        try await Task.sleep(for:.milliseconds(milliseconds))
    }
}
public protocol NativeDescriptorCalls: NativeIOCalls {
    var uid: UInt32 { get }
    func inventory() throws -> [DescriptorFacts]
    func preparePipeWrites() throws
}
extension DarwinNetworkCalls: NativeDescriptorCalls {
    public var uid: UInt32 { getuid() }
    public func preparePipeWrites() throws {
        // Broker-local SIGPIPE disposition prevents opaque pipe loss from bypassing cleanup.
        let previous = Darwin.signal(SIGPIPE,SIG_IGN)
        guard unsafeBitCast(previous,to:Int.self) != -1 else { throw BrokerFailure.transport }
    }
    public func inventory() throws -> [DescriptorFacts] {
        var null = stat()
        guard fstatat(AT_FDCWD,"/dev/null",&null,0) == 0 else { throw BrokerFailure.descriptor }
        let ceiling = getdtablesize()
        guard ceiling >= 36, ceiling <= 65536 else { throw BrokerFailure.descriptor }
        var facts = [DescriptorFacts]()
        for fd in 0..<ceiling {
            let flags = fcntl(fd,F_GETFL)
            if flags < 0 { guard errno == EBADF else { throw BrokerFailure.descriptor }; continue }
            guard fd <= 35 else { throw BrokerFailure.descriptor }
            var metadata = stat()
            guard fstat(fd,&metadata) == 0 else { throw BrokerFailure.descriptor }
            let type = metadata.st_mode & S_IFMT
            let kind: DescriptorFacts.Kind
            if type == S_IFCHR && metadata.st_rdev == null.st_rdev { kind = .null }
            else if type == S_IFIFO { kind = .pipe }
            else { kind = .other }
            facts.append(DescriptorFacts(fd:fd,kind:kind,direction:flags & O_ACCMODE,uid:metadata.st_uid,device:UInt64(UInt32(bitPattern:metadata.st_dev)),inode:metadata.st_ino,tty:isatty(fd) != 0))
        }
        return facts
    }
}
private final class PipePairStream: ByteStream, Sendable {
    let input: DescriptorStream, output: DescriptorStream
    init(input:DescriptorStream,output:DescriptorStream) { self.input = input; self.output = output }
    func read(maxBytes:Int) async throws -> Data { try await input.read(maxBytes:maxBytes) }
    func write(_ data:Data) async throws -> Int { try await output.write(data) }
    func endWrite() async throws { throw BrokerFailure.transport }
    func close() { input.close(); output.close() }
}
public enum BrokerExecutable {
    // Fixed descriptor roles are independently assigned by the trusted launcher.
    // Metadata audit cannot prove pipe purpose or who provisioned authority pins.
    public static func run(native:any NativeDescriptorCalls & NativeSocketCalls & NativeResolverCalls,clock:any BrokerClock,arguments:[String],environment:[String:String]) async throws {
        var owned = [DescriptorStream]()
        defer { owned.forEach { $0.close() } }
        do {
            try BrokerBootstrap.auditFacts(native.inventory(),uid:native.uid,arguments:arguments,environment:environment)
            try native.preparePipeWrites()
            let bootstrap = try DescriptorStream(fd:3,native:native); owned.append(bootstrap)
            var physical = [any ByteStream]()
            for slot in 0..<16 {
                let input = try DescriptorStream(fd:Int32(4 + 2 * slot),native:native); owned.append(input)
                let output = try DescriptorStream(fd:Int32(5 + 2 * slot),native:native); owned.append(output)
                physical.append(PipePairStream(input:input,output:output))
            }
            let configuration = try await BrokerBootstrap.load(stream:bootstrap,clock:clock,timeoutMs:120000)
            let broker = try configuration.makeBroker(resolver:NativeResolver(native:native),connector:NativeConnector(native:native),clock:clock,physicalChannels:physical)
            try await runRelays(broker: broker, physical: physical, nonces: SystemBrokerNonceSource())
        } catch { throw error as? BrokerFailure ?? .bootstrap }
    }

    // Shared finite relay supervision; tests inject only memory streams here.
    static func runRelays(broker: EgressBroker, physical: [any ByteStream], nonces: any BrokerNonceSource) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for pair in physical {
                group.addTask {
                    let channel = RelayChannel(physical: pair, nonces: nonces)
                    do {
                        while true {
                            try Task.checkCancellation()
                            let request: RelayRequest
                            do { request = try await channel.next() } catch is GuestStreamClosed { return }  // P38(c): lane over
                            do {
                                let tunnel = try await broker.accept(request: request)
                                try await tunnel.run()
                            } catch is SlotEnded { continue }  // P38: one slot ended; the lane goes on
                        }
                    } catch {
                        let code = error as? BrokerFailure ?? .transport
                        await broker.fail(code)
                        throw code
                    }
                }
            }
            do {
                // Observe the first failed child before draining pending siblings.
                while try await group.next() != nil {}
            } catch {
                group.cancelAll()
                await broker.fail(error as? BrokerFailure ?? .transport)
                throw error
            }
            // Every lane is over: the guest side is gone, which is transport loss for the run.
            await broker.fail(.transport)
            throw BrokerFailure.transport
        }
    }
}
