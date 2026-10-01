import Foundation
import CryptoKit

public enum ReceiptKind: String, CaseIterable {
    case release = "RELEASE_RECEIPT", restart = "RESTART_RECEIPT", ledger = "LEDGER_RECEIPT"
    case maintenance = "MAINTENANCE_RECEIPT", db = "DB_RECEIPT"
    fileprivate var frameKind: FrameKind { FrameKind(rawValue: rawValue)! }
}
public enum ReceiptError: Error { case identityMismatch, signatureInvalid, expired, replay, readinessFailed, budgetExceeded, observationFailed }
private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func hex(_ string: String, count: Int) throws -> Data {
    guard string.utf8.count == count * 2, string.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw ReceiptError.signatureInvalid }
    var bytes = [UInt8](); var index = string.startIndex
    while index < string.endIndex { let next = string.index(index, offsetBy: 2); guard let byte = UInt8(string[index..<next], radix: 16) else { throw ReceiptError.signatureInvalid }; bytes.append(byte); index = next }
    return Data(bytes)
}
private func equivalent(_ a: [String: Any], _ b: [String: Any]) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
private func bindings(_ value: [String: Any]) -> [String: Any] {
    var f = value; var p = f["payload"] as! [String: Any]
    for key in ["issuedAt", "expiresAt", "keyId", "signature"] { p.removeValue(forKey: key) }; f["payload"] = p; return f
}
// Share this private replay boundary across verifier contexts within the same run.
public final class ReceiptReplayState {
    fileprivate let lock = NSRecursiveLock()
    fileprivate var receipts = Set<String>(), nonces = Set<String>()
    public init() {}
}
public final class TrustContext {
    fileprivate let expected: [String: [String: Any]], keys: [String: Curve25519.Signing.PublicKey]
    fileprivate let now: () -> Int, maxAgeMs: Int, deadline: Int, notBefore: [String: Int], replay: ReceiptReplayState
    fileprivate var lastNow: Int?
    fileprivate init(releaseExpected: [String: Any], key: Data, maxAgeMs: Int, notBefore: Int, deadline: Int, time: ReleaseTime) throws {
        guard key.count == 32, maxAgeMs > 0, maxAgeMs <= 9007199254740991,
              deadline > 0, deadline <= 9007199254740991, notBefore >= 0, notBefore < deadline else { throw ReceiptError.identityMismatch }
        self.expected = [ReceiptKind.release.rawValue: releaseExpected]
        self.keys = [ReceiptKind.release.rawValue: try Curve25519.Signing.PublicKey(rawRepresentation: key)]
        self.now = { time.wall }; self.maxAgeMs = maxAgeMs; self.deadline = deadline
        self.notBefore = [ReceiptKind.release.rawValue: notBefore]; self.replay = ReceiptReplayState()
    }
    public init(options: [String: Any], now: @escaping () -> Int, replay: ReceiptReplayState = ReceiptReplayState()) throws {
        let copy = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: options)) as? [String: Any]
        guard let copy, let expected = copy["expected"] as? [String: [String: Any]], let rawKeys = copy["publicKeys"] as? [String: String], let maxAgeMs = copy["maxAgeMs"] as? Int, let deadline = copy["deadline"] as? Int,
              maxAgeMs > 0, maxAgeMs <= 9007199254740991, deadline > 0, deadline <= 9007199254740991,
              Set(expected.keys) == Set(ReceiptKind.allCases.map(\.rawValue)), Set(rawKeys.keys) == Set(expected.keys) else { throw ReceiptError.identityMismatch }
        guard rawKeys[ReceiptKind.release.rawValue] == rawKeys[ReceiptKind.restart.rawValue] else { throw ReceiptError.signatureInvalid }
        let notBefore: [String: Int]
        if let supplied = copy["notBefore"] { guard let times = supplied as? [String: Int] else { throw ReceiptError.identityMismatch }; notBefore = times }
        else { notBefore = Dictionary(uniqueKeysWithValues: ReceiptKind.allCases.map { ($0.rawValue, 0) }) }
        guard Set(notBefore.keys) == Set(expected.keys), notBefore.values.allSatisfy({ $0 >= 0 && $0 < deadline }) else { throw ReceiptError.identityMismatch }
        var keys = [String: Curve25519.Signing.PublicKey]()
        for kind in ReceiptKind.allCases {
            let raw = try hex(rawKeys[kind.rawValue]!, count: 32); keys[kind.rawValue] = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
            var frame = expected[kind.rawValue]!
            guard var p = frame["payload"] as? [String: Any], !["issuedAt", "expiresAt", "keyId", "signature"].contains(where: { p[$0] != nil }) else { throw ReceiptError.identityMismatch }
            p["issuedAt"] = 0; p["expiresAt"] = 1; p["keyId"] = digest(raw); p["signature"] = String(repeating: "0", count: 128); frame["payload"] = p
            let decoded = try Contracts.decode(JSONSerialization.data(withJSONObject: frame), kind: kind.frameKind)
            guard equivalent(bindings(decoded.value), expected[kind.rawValue]!) else { throw ReceiptError.identityMismatch }
        }
        let release = expected[ReceiptKind.release.rawValue]!, releasePayload = release["payload"] as! [String: Any]
        for kind in ReceiptKind.allCases { guard expected[kind.rawValue]!["runId"] as? String == release["runId"] as? String else { throw ReceiptError.identityMismatch } }
        for kind in [ReceiptKind.ledger, .maintenance, .db] { guard (expected[kind.rawValue]!["payload"] as! [String: Any])["configIdentity"] as? String == releasePayload["configIdentity"] as? String else { throw ReceiptError.identityMismatch } }
        let restart = expected[ReceiptKind.restart.rawValue]!["payload"] as! [String: Any]
        for key in ["intendedApp", "environment", "backendRegistryDigest", "backendPlatformDigest"] { guard restart[key] as? String == releasePayload[key] as? String else { throw ReceiptError.identityMismatch } }
        let maintenance = expected[ReceiptKind.maintenance.rawValue]!["payload"] as! [String: Any], db = expected[ReceiptKind.db.rawValue]!["payload"] as! [String: Any]
        guard maintenance["identityComparisonId"] as? String == db["identityComparisonId"] as? String else { throw ReceiptError.identityMismatch }
        self.expected = expected; self.keys = keys; self.now = now; self.maxAgeMs = maxAgeMs; self.deadline = deadline; self.notBefore = notBefore; self.replay = replay
    }
}
// File-private constructors ensure external callers cannot forge a nominal result.
public final class VerifiedReceipt {
    public let kind: ReceiptKind
    fileprivate let frame: ValidatedFrame, trust: TrustContext
    fileprivate init(frame: ValidatedFrame, kind: ReceiptKind, trust: TrustContext) { self.frame = frame; self.kind = kind; self.trust = trust }
}
public final class AssetEntry {
    public let path: String, hash: String, size: Int, mime: String
    fileprivate let release: VerifiedReceipt
    fileprivate init(_ entry: [String: Any], release: VerifiedReceipt) { path = entry["path"] as! String; hash = entry["hash"] as! String; size = entry["size"] as! Int; mime = entry["mime"] as! String; self.release = release }
    fileprivate var metadata: [String: Any] { ["path": path, "hash": hash, "size": size, "mime": mime] }
}
public final class AssetManifest {
    public let entries: [AssetEntry]
    fileprivate let release: VerifiedReceipt, runId: String, digest: String
    fileprivate init(entries: [AssetEntry], release: VerifiedReceipt, runId: String, digest: String) { self.entries = entries; self.release = release; self.runId = runId; self.digest = digest }
}
public struct AssetProof { public let entryId: String, hash: String; public let sizeMatch: Bool, hashMatch: Bool, mimeMatch: Bool }
public enum ReceiptVerifier {
    private static func validate(_ frame: ValidatedFrame, trust: TrustContext) throws {
        let p = frame.value["payload"] as! [String: Any], now = trust.now()
        guard now >= 0, now <= 9007199254740991, trust.lastNow == nil || now >= trust.lastNow! else { throw ReceiptError.expired }; trust.lastNow = now
        let issued = p["issuedAt"] as! Int, expires = p["expiresAt"] as! Int
        guard now < trust.deadline, issued >= trust.notBefore[frame.kind.rawValue]!, issued <= now, expires > now, expires <= trust.deadline, now - issued <= trust.maxAgeMs else { throw ReceiptError.expired }
        guard equivalent(bindings(frame.value), trust.expected[frame.kind.rawValue]!) else { throw ReceiptError.identityMismatch }
        if frame.kind == .restartReceipt {
            guard p["sameConfig"] as! Bool, p["success"] as! Bool, p["action"] as! String == "backend-restart-only" else { throw ReceiptError.identityMismatch }
            let completed = p["completedAt"] as! Int; guard completed <= now else { throw ReceiptError.expired }
            let ids = (trust.expected[ReceiptKind.release.rawValue]!["payload"] as! [String: Any])["expectedInstances"] as! [String]
            let pre = p["preInstances"] as! [[String: Any]], post = p["postInstances"] as! [[String: Any]]
            for rows in [pre, post] { guard rows.count == ids.count, Set(rows.map { $0["id"] as! String }) == Set(ids) else { throw ReceiptError.identityMismatch } }
            for before in pre { guard let after = post.first(where: { $0["id"] as! String == before["id"] as! String }), (after["startedAt"] as! Int) > (before["startedAt"] as! Int), (after["startedAt"] as! Int) <= completed else { throw ReceiptError.identityMismatch } }
        }
        if frame.kind == .maintenanceReceipt || frame.kind == .dbReceipt {
            // Bool is checked by key, avoiding NSNumber integer/Boolean bridging.
            let boolKeys = frame.kind == .maintenanceReceipt ? ["comparisonComplete","ownerExactMatch","accountExactMatch","uniquePreexistingSettings","paperOnly","automationDisabled","schedulerSuppressed","notificationWorkersSuppressed","noAutomationLease","noProtectionLease","noTradingWork","noCloseWork","noReconciliationWork","noReservations","exclusiveWindow"] : ["comparisonComplete","ownerExactMatch","accountExactMatch","uniquePreexistingSettings","economicUnchanged","configurationUnchanged","concurrentWritesAccounted","ttlAccounted","snapshotConsistent"]
            guard boolKeys.allSatisfy({ p[$0] as? Bool == true }), (p["comparisonScope"] as! [String: Bool]).values.allSatisfy({ $0 }) else { throw ReceiptError.readinessFailed }
            let allowed = p["allowedDeltas"] as! [String: Int], logout = frame.kind == .dbReceipt && p["interval"] as? String == "LOGOUT"
            guard allowed["ownerSessionGenerationIncrement"] == (logout ? 1 : 0) else { throw ReceiptError.identityMismatch }
            if frame.kind == .dbReceipt { guard equivalent(p["observedDeltas"] as! [String: Any], p["allowedDeltas"] as! [String: Any]) else { throw ReceiptError.identityMismatch } }
        }
        if frame.kind == .ledgerReceipt { guard p["canonicalAdapter"] as! String == "alpaca-paper", (p["PAPER"] as! [String: Int])["fullRunReserved"] == 14, (p["stock"] as! [String: Int])["fullRunReserved"] == 0 else { throw ReceiptError.budgetExceeded } }
    }
    public static func verify(_ data: Data, kind: ReceiptKind, trust: TrustContext) throws -> VerifiedReceipt {
        trust.replay.lock.lock(); defer { trust.replay.lock.unlock() }
        let frame = try Contracts.decode(data, kind: kind.frameKind), p = frame.value["payload"] as! [String: Any], key = trust.keys[kind.rawValue]!
        guard p["keyId"] as! String == digest(key.rawRepresentation), key.isValidSignature(try hex(p["signature"] as! String, count: 64), for: try Contracts.receiptSigningBytes(frame)) else { throw ReceiptError.signatureInvalid }
        try validate(frame, trust: trust)
        let replayId = digest(try Contracts.receiptSigningBytes(frame))
        guard !trust.replay.receipts.contains(replayId), kind != .restart || !trust.replay.nonces.contains(p["nonce"] as! String) else { throw ReceiptError.replay }
        trust.replay.receipts.insert(replayId); if kind == .restart { trust.replay.nonces.insert(p["nonce"] as! String) }
        return VerifiedReceipt(frame: frame, kind: kind, trust: trust)
    }
    public static func inspect(_ receipt: VerifiedReceipt, kind: ReceiptKind, trust: TrustContext) -> [String: Any]? {
        trust.replay.lock.lock(); defer { trust.replay.lock.unlock() }
        guard receipt.trust === trust, receipt.kind == kind else { return nil }
        do { try validate(receipt.frame, trust: trust) } catch { return nil }
        var result = receipt.frame.value["payload"] as! [String: Any]
        for key in ["signature", "nonce", "identityComparisonId", "preInstances", "postInstances"] { result.removeValue(forKey: key) }
        if kind == .restart { result["configIdentity"] = (trust.expected[ReceiptKind.release.rawValue]!["payload"] as! [String: Any])["configIdentity"] }
        result["kind"] = kind.rawValue; result["runId"] = receipt.frame.value["runId"]; result["sequence"] = receipt.frame.value["sequence"]; return result
    }
    public static func verifyAssets(_ data: Data, release: VerifiedReceipt) throws -> AssetManifest {
        guard let r = inspect(release, kind: .release, trust: release.trust) else { throw ReceiptError.identityMismatch }
        let f = try Contracts.decode(data, kind: .assetManifest), d = digest(try Contracts.canonicalBytes(f))
        guard f.value["runId"] as? String == r["runId"] as? String, d == r["assetManifestDigest"] as? String else { throw ReceiptError.identityMismatch }
        let rows = (f.value["payload"] as! [String: Any])["entries"] as! [[String: Any]]
        for row in rows { let path = row["path"] as! String; guard !path.hasSuffix(".map"), path != "/static/js/acceptance-missing.js", !["/", "/login", "/robo", "/portfolio", "/activity"].contains(path), !path.contains("//"), !path.contains("/../"), !path.contains("/./") else { throw ReceiptError.identityMismatch } }
        return AssetManifest(entries: rows.map { AssetEntry($0, release: release) }, release: release, runId: f.value["runId"] as! String, digest: d)
    }
    public static func inspectAssets(_ assets: AssetManifest, release: VerifiedReceipt) -> [String: Any]? {
        guard assets.release === release, inspect(release, kind: .release, trust: release.trust) != nil else { return nil }
        return ["runId": assets.runId, "digest": assets.digest, "entries": assets.entries.map(\.metadata)]
    }
    public static func validateAssetResponse(_ entry: AssetEntry, body: Data?, contentType: String) throws -> AssetProof {
        guard inspect(entry.release, kind: .release, trust: entry.release.trust) != nil, let body, body.count == entry.size, digest(body) == entry.hash, contentType == entry.mime else { throw ReceiptError.observationFailed }
        return AssetProof(entryId: "frontend-asset:" + entry.path, hash: entry.hash, sizeMatch: true, hashMatch: true, mimeMatch: true)
    }
}

// Release-only trust keeps broker processes free of maintenance/DB identity pins.
// It uses the same strict codec, binding, signature, time and replay verifier.
private final class ReleaseTime { var wall = -1 }
extension TrustContext {
    fileprivate convenience init(releaseFrame: ValidatedFrame, key: Data, maxAgeMs: Int, notBefore: Int, deadline: Int, time: ReleaseTime) throws {
        try self.init(releaseExpected: bindings(releaseFrame.value), key: key, maxAgeMs: maxAgeMs, notBefore: notBefore, deadline: deadline, time: time)
    }
}
public final class ReleaseAuthority: @unchecked Sendable {
    fileprivate let trust: TrustContext
    fileprivate let time: ReleaseTime
    public init(expectedRelease: Data, publicKey: Data, maxAgeMs: Int, notBefore: Int, deadline: Int) throws {
        let frame = try Contracts.decode(expectedRelease, kind: .releaseReceipt)
        let time = ReleaseTime()
        self.trust = try TrustContext(releaseFrame: frame, key: publicKey, maxAgeMs: maxAgeMs, notBefore: notBefore, deadline: deadline, time: time)
        self.time = time
    }
}
public final class VerifiedRelease: @unchecked Sendable {
    fileprivate let receipt: VerifiedReceipt, authority: ReleaseAuthority
    fileprivate init(_ receipt: VerifiedReceipt, _ authority: ReleaseAuthority) { self.receipt = receipt; self.authority = authority }
}
extension ReceiptVerifier {
    public static func verifyRelease(_ data: Data, authority: ReleaseAuthority, atWallTime: Int) throws -> VerifiedRelease {
        authority.trust.replay.lock.lock(); defer { authority.trust.replay.lock.unlock() }
        authority.time.wall = atWallTime
        return VerifiedRelease(try verify(data, kind: .release, trust: authority.trust), authority)
    }
    public static func inspectRelease(_ release: VerifiedRelease, authority: ReleaseAuthority, atWallTime: Int) -> [String: Any]? {
        guard release.authority === authority else { return nil }
        authority.trust.replay.lock.lock(); defer { authority.trust.replay.lock.unlock() }
        authority.time.wall = atWallTime
        return inspect(release.receipt, kind: .release, trust: authority.trust)
    }
}

extension ReceiptVerifier {
    // Pure deadline calculation after validation at the same qualified wall sample.
    // No trailing clock callback can age the admission after its final check.
    public static func releaseUseDeadline(_ release: VerifiedRelease, authority: ReleaseAuthority, atWallTime: Int) -> Int? {
        guard let payload = inspectRelease(release, authority: authority, atWallTime: atWallTime),
              let issued = payload["issuedAt"] as? Int, let expires = payload["expiresAt"] as? Int else { return nil }
        return min(expires, authority.trust.deadline, issued + authority.trust.maxAgeMs + 1)
    }
}
