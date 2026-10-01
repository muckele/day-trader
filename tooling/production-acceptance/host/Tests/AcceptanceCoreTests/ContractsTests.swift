import Foundation
import Testing
@testable import AcceptanceCore

@Suite struct ContractsTests {
    private func vectors() throws -> [String: [[String: String]]] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/vectors.json"))) as? [String: [[String: String]]])
    }
    private func reject(_ group: String) throws {
        let cases = try #require(try vectors()["rejected"]?.filter { $0["group"] == group })
        try #require(!cases.isEmpty)
        for v in cases {
            let rawKind = try #require(v["kind"])
            let kind = try #require(FrameKind(rawValue: rawKind))
            #expect(throws: ContractError.invalidFrame) { try Contracts.decode(Data(try #require(v["json"]).utf8), kind: kind) }
        }
    }
    @Test func unknown_field_rejected() throws { try reject("unknown_field_rejected") }
    @Test func duplicate_key_rejected() throws { try reject("duplicate_key_rejected") }
    @Test func oversized_frame_rejected() throws { try reject("oversized_frame_rejected") }
    @Test func arbitrary_url_host_rejected() throws { try reject("arbitrary_url_host_rejected") }
    @Test func invalid_phase_event_rejected() throws { try reject("invalid_phase_event_rejected") }
    @Test func private_fields_not_public() throws { try reject("private_fields_not_public") }
    @Test func runtime_identity_requires_exact_hashes() throws { try reject("runtime_identity_requires_exact_hashes") }
    @Test func malformed_values_rejected() throws { try reject("malformed_values_rejected") }
    @Test func canonical_receipt_bytes_equal() throws {
        let cases = try #require(try vectors()["accepted"])
        try #require(!cases.isEmpty)
        for v in cases {
            let rawKind = try #require(v["kind"])
            let kind = try #require(FrameKind(rawValue: rawKind))
            let decoded = try Contracts.decode(Data((" \n" + (try #require(v["json"])) + " \t").utf8), kind: kind)
            #expect(try Contracts.canonicalBytes(decoded) == Data(try #require(v["canonical"]).utf8))
        }
    }
    @Test func public_run_total_bounded() throws {
        let v = try #require(try vectors()["accepted"]?.first(where: { $0["name"] == "public_phase" }))
        let frame = try Contracts.decode(Data(try #require(v["json"]).utf8), kind: .publicRecord)
        let size = Data(try #require(v["canonical"]).utf8).count
        let count = 262144 / size
        let budget = PublicRunBudget()
        for _ in 0..<count { try budget.append(frame) }
        #expect(budget.usedBytes == count * size)
        #expect(throws: ContractError.invalidFrame) { try budget.append(frame) }
        #expect(budget.usedBytes == count * size)
        let c = try #require(try vectors()["accepted"]?.first(where: { $0["kind"] == "CONTROL" }))
        let control = try Contracts.decode(Data(try #require(c["json"]).utf8), kind: .control)
        #expect(throws: ContractError.invalidFrame) { try budget.append(control) }
    }
    @Test func schema_unavailable_or_malformed_fails_closed() throws {
        #expect(throws: ContractError.invalidFrame) { try Contracts.loadSchema(at: URL(fileURLWithPath: "/__acceptance_missing_schema__")) }
        #expect(throws: ContractError.invalidFrame) { try Contracts.loadSchema(at: URL(fileURLWithPath: #filePath)) }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        var malformed = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/schema.json"))) as? [String: Any])
        var frames = try #require(malformed["frames"] as? [String: [String: Any]])
        frames["CONTROL"]?["schema"] = ["type": "object"]
        malformed["frames"] = frames
        let malformedData = try JSONSerialization.data(withJSONObject: malformed)
        #expect(throws: ContractError.invalidFrame) { try Contracts.loadSchema(data: malformedData) }
    }
    @Test func strict_utf8_rejected() throws {
        #expect(throws: ContractError.invalidFrame) { try Contracts.decode(Data([0xff]), kind: .control) }
    }
}
