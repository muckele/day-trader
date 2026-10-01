import Foundation
import CoreFoundation

public enum FrameKind: String, CaseIterable, Sendable {
    case control = "CONTROL", releaseReceipt = "RELEASE_RECEIPT", restartReceipt = "RESTART_RECEIPT"
    case ledgerReceipt = "LEDGER_RECEIPT", maintenanceReceipt = "MAINTENANCE_RECEIPT", dbReceipt = "DB_RECEIPT"
    case assetManifest = "ASSET_MANIFEST", runtimeIdentity = "RUNTIME_IDENTITY", publicRecord = "PUBLIC_RECORD"
}
public enum ContractError: Error { case invalidFrame }
// No public initializer: only a successful bounded decode creates this immutable value.
public struct ValidatedFrame {
    let value: [String: Any]
    public let kind: FrameKind
}

// Scan syntax, integer spelling, nesting and decoded duplicate keys before JSONSerialization
// constructs the frame. All allocations are bounded by the declared frame byte ceiling.
private struct WireScanner {
    let bytes: [UInt8]
    var index = 0
    mutating func whitespace() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
    mutating func string() throws -> String {
        let start = index
        guard index < bytes.count, bytes[index] == 34 else { throw ContractError.invalidFrame }
        index += 1
        while index < bytes.count {
            let byte = bytes[index]; index += 1
            if byte == 34 {
                guard let result = try JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: .fragmentsAllowed) as? String else { throw ContractError.invalidFrame }
                return result
            }
            if byte == 92 { guard index < bytes.count else { throw ContractError.invalidFrame }; index += 1 }
        }
        throw ContractError.invalidFrame
    }
    mutating func value(depth: Int) throws {
        whitespace(); guard index < bytes.count else { throw ContractError.invalidFrame }
        let byte = bytes[index]
        if byte == 34 { _ = try string(); return }
        if byte == 123 || byte == 91 {
            guard depth < 8 else { throw ContractError.invalidFrame }
            let object = byte == 123; let end: UInt8 = object ? 125 : 93
            index += 1; whitespace(); var keys = Set<String>()
            if index < bytes.count && bytes[index] == end { index += 1; return }
            while true {
                whitespace()
                if object {
                    let key = try string(); guard keys.insert(key).inserted else { throw ContractError.invalidFrame }
                    whitespace(); guard index < bytes.count, bytes[index] == 58 else { throw ContractError.invalidFrame }; index += 1
                }
                try value(depth: depth + 1); whitespace()
                guard index < bytes.count else { throw ContractError.invalidFrame }
                if bytes[index] == end { index += 1; return }
                guard bytes[index] == 44 else { throw ContractError.invalidFrame }; index += 1
            }
        }
        for token in ["true", "false", "null"] {
            let word = Array(token.utf8)
            if bytes[index...].starts(with: word) { index += word.count; return }
        }
        let start = index
        if bytes[index] == 45 { index += 1 }
        guard index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 else { throw ContractError.invalidFrame }
        if bytes[index] == 48 { index += 1 } else { while index < bytes.count && bytes[index] >= 48 && bytes[index] <= 57 { index += 1 } }
        let token = String(decoding: bytes[start..<index], as: UTF8.self)
        guard token != "-0", let number = Int64(token), number >= -9007199254740991, number <= 9007199254740991 else { throw ContractError.invalidFrame }
    }
    mutating func scan() throws { try value(depth: 0); whitespace(); guard index == bytes.count else { throw ContractError.invalidFrame } }
}

public enum Contracts {
    // Source-tree deployment for M1. A future packaged host must supply its immutable
    // bundled schema through an explicit loader; never consult cwd, environment or network.
    private static var schemaURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("contracts/schema.json")
    }
    static func loadSchema(at url: URL) throws -> [String: Any] {
        do { return try loadSchema(data: Data(contentsOf: url)) } catch { throw ContractError.invalidFrame }
    }
    static func loadSchema(data: Data) throws -> [String: Any] {
        do {
            guard let schema = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  schema["schemaVersion"] as? Int == 1, schema["maxDepth"] as? Int == 8,
                  schema["publicRunMaxBytes"] as? Int == 262144,
                  let frames = schema["frames"] as? [String: [String: Any]],
                  Set(frames.keys) == Set(FrameKind.allCases.map(\.rawValue)),
                  let definitions = schema["definitions"] as? [String: [String: Any]], schema["phaseEvents"] is [String: [String]],
                  schema["canonicalDomain"] as? String == "acceptance:v1:",
                  Set(schema.keys) == Set(["schemaVersion", "maxDepth", "publicRunMaxBytes", "canonicalDomain", "phaseEvents", "definitions", "frames"]) else { throw ContractError.invalidFrame }
            for descriptor in definitions.values { try descriptorValid(descriptor, definitions: definitions) }
            for kind in FrameKind.allCases {
                let frame = frames[kind.rawValue]!
                let limit = kind == .control ? 256 : (kind == .publicRecord ? 4096 : 16384)
                guard Set(frame.keys) == Set(["maxBytes", "schema"]), frame["maxBytes"] as? Int == limit,
                      let descriptor = frame["schema"] as? [String: Any] else { throw ContractError.invalidFrame }
                try descriptorValid(descriptor, definitions: definitions)
            }
            return schema
        } catch { throw ContractError.invalidFrame }
    }
    private static func descriptorValid(_ rule: [String: Any], definitions: [String: [String: Any]], depth: Int = 0) throws {
        guard depth <= 16 else { throw ContractError.invalidFrame }
        if let ref = rule["ref"] as? String {
            guard Set(rule.keys) == Set(["ref"]), let target = definitions[ref] else { throw ContractError.invalidFrame }
            return try descriptorValid(target, definitions: definitions, depth: depth + 1)
        }
        switch rule["type"] as? String {
        case "object":
            guard let fields = rule["fields"] as? [String: [String: Any]], !fields.isEmpty else { throw ContractError.invalidFrame }
            for field in fields.values { try descriptorValid(field, definitions: definitions, depth: depth + 1) }
        case "array":
            guard let min = rule["min"] as? Int, let max = rule["max"] as? Int, min >= 0, max >= min, let item = rule["item"] as? [String: Any] else { throw ContractError.invalidFrame }
            try descriptorValid(item, definitions: definitions, depth: depth + 1)
        case "union":
            guard let tag = rule["tag"] as? String, !tag.isEmpty, let variants = rule["variants"] as? [String: [String: Any]], !variants.isEmpty else { throw ContractError.invalidFrame }
            for variant in variants.values { try descriptorValid(variant, definitions: definitions, depth: depth + 1) }
        case "enum":
            guard let values = rule["values"] as? [Any], !values.isEmpty, values.allSatisfy({ $0 is String || $0 is NSNumber }) else { throw ContractError.invalidFrame }
        case "string":
            guard let max = rule["max"] as? Int, max >= 0, let pattern = rule["pattern"] as? String, (try? NSRegularExpression(pattern: "\\A(?:" + pattern + ")\\z")) != nil else { throw ContractError.invalidFrame }
        case "integer":
            guard let min = rule["min"] as? Int64, let max = rule["max"] as? Int64, min >= 0, max >= min, max <= 9007199254740991 else { throw ContractError.invalidFrame }
        case "boolean": break
        default: throw ContractError.invalidFrame
        }
    }
    private static func integer(_ value: Any) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              String(cString: n.objCType) != "d", String(cString: n.objCType) != "f" else { return nil }
        return n.int64Value
    }
    private static func equal(_ a: Any, _ b: Any) -> Bool {
        if let a = a as? String, let b = b as? String { return a == b }
        if let a = a as? NSNumber, let b = b as? NSNumber {
            return (CFGetTypeID(a) == CFBooleanGetTypeID()) == (CFGetTypeID(b) == CFBooleanGetTypeID()) && a == b
        }
        return false
    }
    private static func check(_ value: Any, rule: [String: Any], definitions: [String: [String: Any]], depth: Int = 0) throws {
        guard depth <= 16 else { throw ContractError.invalidFrame }
        if let ref = rule["ref"] as? String {
            guard let target = definitions[ref] else { throw ContractError.invalidFrame }
            return try check(value, rule: target, definitions: definitions, depth: depth + 1)
        }
        switch rule["type"] as? String {
        case "object":
            guard let object = value as? [String: Any], let fields = rule["fields"] as? [String: [String: Any]], Set(object.keys) == Set(fields.keys) else { throw ContractError.invalidFrame }
            for (key, field) in fields { try check(object[key]!, rule: field, definitions: definitions, depth: depth + 1) }
        case "array":
            guard let array = value as? [Any], let min = rule["min"] as? Int, let max = rule["max"] as? Int, array.count >= min, array.count <= max, let item = rule["item"] as? [String: Any] else { throw ContractError.invalidFrame }
            for v in array { try check(v, rule: item, definitions: definitions, depth: depth + 1) }
        case "union":
            guard let object = value as? [String: Any], let tag = rule["tag"] as? String, let key = object[tag] as? String, let variants = rule["variants"] as? [String: [String: Any]], let variant = variants[key] else { throw ContractError.invalidFrame }
            try check(value, rule: variant, definitions: definitions, depth: depth + 1)
        case "enum":
            guard let values = rule["values"] as? [Any], values.contains(where: { equal($0, value) }) else { throw ContractError.invalidFrame }
        case "string":
            guard let string = value as? String, let max = rule["max"] as? Int, string.utf8.count <= max, let pattern = rule["pattern"] as? String,
                  let regex = try? NSRegularExpression(pattern: "\\A(?:" + pattern + ")\\z"), regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil else { throw ContractError.invalidFrame }
        case "integer":
            guard let number = integer(value), let min = rule["min"] as? Int64, let max = rule["max"] as? Int64, number >= min, number <= max else { throw ContractError.invalidFrame }
        case "boolean":
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw ContractError.invalidFrame }
        default: throw ContractError.invalidFrame
        }
    }
    private static func semantics(_ frame: [String: Any], kind: FrameKind, schema: [String: Any]) throws {
        let p = frame["payload"] as! [String: Any]
        if kind == .control {
            let events = schema["phaseEvents"] as! [String: [String]]
            guard events[p["phase"] as! String]?.contains(p["event"] as! String) == true else { throw ContractError.invalidFrame }
        }
        if let issued = p["issuedAt"] { guard integer(p["expiresAt"]!)! > integer(issued)! else { throw ContractError.invalidFrame } }
        func unique(_ values: [String]) throws { guard Set(values).count == values.count else { throw ContractError.invalidFrame } }
        if kind == .releaseReceipt {
            let origins = p["origins"] as! [String: String]; guard origins["FRONTEND"] != origins["BACKEND"] else { throw ContractError.invalidFrame }
            try unique(p["expectedInstances"] as! [String])
        }
        if kind == .restartReceipt { for name in ["preInstances", "postInstances"] { try unique((p[name] as! [[String: Any]]).map { $0["id"] as! String }) } }
        if kind == .assetManifest { try unique((p["entries"] as! [[String: Any]]).map { $0["path"] as! String }) }
        if kind == .ledgerReceipt {
            for name in ["PAPER", "stock"] {
                let a = p[name] as! [String: Any]
                let charged = integer(a["historicalCharged"]!)! + integer(a["unresolved"]!)! + integer(a["fullRunReserved"]!)!
                guard charged <= integer(a["ceiling"]!)!, integer(a["remaining"]!)! == integer(a["ceiling"]!)! - charged else { throw ContractError.invalidFrame }
            }
        }
    }
    public static func decode(_ data: Data, kind: FrameKind) throws -> ValidatedFrame {
        do {
            let schema = try loadSchema(at: schemaURL); let frames = schema["frames"] as! [String: [String: Any]]; let rule = frames[kind.rawValue]!
            guard let limit = rule["maxBytes"] as? Int, data.count <= limit, String(data: data, encoding: .utf8) != nil else { throw ContractError.invalidFrame }
            var scanner = WireScanner(bytes: Array(data)); try scanner.scan()
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], let descriptor = rule["schema"] as? [String: Any] else { throw ContractError.invalidFrame }
            try check(value, rule: descriptor, definitions: schema["definitions"] as! [String: [String: Any]])
            try semantics(value, kind: kind, schema: schema)
            return ValidatedFrame(value: value, kind: kind)
        } catch { throw ContractError.invalidFrame }
    }
    private static func encode(_ value: Any) throws -> String {
        if let object = value as? [String: Any] { return "{" + (try object.keys.sorted().map { try encode($0) + ":" + encode(object[$0]!) }).joined(separator: ",") + "}" }
        if let array = value as? [Any] { return "[" + (try array.map(encode)).joined(separator: ",") + "]" }
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        guard let result = String(data: bytes, encoding: .utf8) else { throw ContractError.invalidFrame }; return result
    }
    public static func canonicalBytes(_ frame: ValidatedFrame) throws -> Data { try Data(encode(frame.value).utf8) }
}
public final class PublicRunBudget {
    public private(set) var usedBytes = 0
    public init() {}
    public func append(_ frame: ValidatedFrame) throws {
        guard frame.kind == .publicRecord else { throw ContractError.invalidFrame }
        let count = try Contracts.canonicalBytes(frame).count
        guard count <= 262144 - usedBytes else { throw ContractError.invalidFrame }
        usedBytes += count
    }
}
