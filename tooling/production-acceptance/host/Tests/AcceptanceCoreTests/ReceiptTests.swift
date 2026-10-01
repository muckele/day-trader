import Foundation
import CryptoKit
import Testing
@testable import AcceptanceCore

@Suite(.serialized) struct ReceiptTests {
    func directory() throws -> URL { URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["RECEIPT_EXCHANGE"])) }
    func fixture() throws -> [String: Any] { try #require(JSONSerialization.jsonObject(with: Data(contentsOf: directory().appendingPathComponent("node.json"))) as? [String: Any]) }
    func trust(_ f: [String: Any], now: Int = 160) throws -> TrustContext { try TrustContext(options: #require(f["options"] as? [String: Any]), now: { now }) }
    func positive(_ f: [String: Any], _ kind: ReceiptKind) throws -> Data { let rows = try #require(f["positive"] as? [[String: String]]); return Data(try #require(rows.first { $0["kind"] == kind.rawValue }?["json"]).utf8) }
    @Test func all_five_valid_receipts_and_nominal_expiry() throws {
        let f = try fixture()
        for kind in ReceiptKind.allCases { let t = try trust(f); let h = try ReceiptVerifier.verify(positive(f,kind), kind: kind, trust: t); #expect(ReceiptVerifier.inspect(h,kind:kind,trust:t)?["kind"] as? String == kind.rawValue); #expect(ReceiptVerifier.inspect(h,kind:kind,trust:try trust(f)) == nil) }
    }
    @Test func bad_signature_wrong_signer_expired_future_issuance_denied() throws { try reject(prefixes:["bad_signature_","wrong_signer_","expired_","future_issuance_","stale_","wrong_domain_"]) }
    @Test func duplicate_unknown_fields_denied() throws { try reject(prefixes:["unknown_fields_","duplicate_fields_"]) }
    @Test func wrong_nonce_digest_action_app_environment_operationId_denied() throws { try reject(prefixes:["release_binding_","restart_binding_","wrong_run_","wrong_sequence_","key_in_receipt_"]) }
    @Test func missing_instance_same_config_completion_denied() throws { try reject(prefixes:["missing_instance","unchanged_start_time","restart_predicate_","future_completion","completion_before_post_start"]) }
    @Test func maintenance_DB_predicates_private_comparison_deltas_and_ledger_denied() throws { try reject(prefixes:["predicate_","comparison_","unapproved_delta_","db_","ledger_"]) }
    func reject(prefixes: [String]) throws {
        let f = try fixture(), rows = try #require(f["negative"] as? [[String: Any]])
        let selected = rows.filter { row in prefixes.contains { (row["name"] as? String ?? "").hasPrefix($0) } }; try #require(!selected.isEmpty)
        for row in selected { let rawKind = try #require(row["kind"] as? String); let kind = try #require(ReceiptKind(rawValue: rawKind)), json = try #require(row["json"] as? String), clock = try #require(row["clock"] as? Int); #expect(throws: (any Error).self, "\(row["name"]!)") { _ = try ReceiptVerifier.verify(Data(json.utf8),kind:kind,trust:try trust(f,now:clock)) } }
    }
    @Test func replay_denied() throws { let f = try fixture(); for kind in ReceiptKind.allCases { let t = try trust(f), bytes = try positive(f,kind); _ = try ReceiptVerifier.verify(bytes,kind:kind,trust:t); #expect(throws: (any Error).self) { _ = try ReceiptVerifier.verify(bytes,kind:kind,trust:t) } } }
    @Test func asset_bytes_size_mime_hash_mismatch_and_missing_body_denied() throws {
        let f = try fixture(), t = try trust(f), r = try ReceiptVerifier.verify(positive(f,.release),kind:.release,trust:t), bytes = Data(try #require(f["asset"] as? String).utf8), a = try ReceiptVerifier.verifyAssets(bytes,release:r)
        let body = try hex(#require(f["assetBody"] as? String)), e = try #require(a.entries.first)
        let proof = try ReceiptVerifier.validateAssetResponse(e,body:body,contentType:e.mime); #expect(proof.hashMatch && proof.sizeMatch && proof.mimeMatch); #expect(proof.entryId == "frontend-asset:/static/app.js")
        for (value,mime) in [(Data("wrong".utf8),e.mime),(Data(repeating:0,count:body.count),e.mime),(body,"text/plain")] { #expect(throws: (any Error).self) { _ = try ReceiptVerifier.validateAssetResponse(e,body:value,contentType:mime) } }
        #expect(throws: (any Error).self) { _ = try ReceiptVerifier.validateAssetResponse(e,body:nil,contentType:e.mime) }
        #expect(throws: (any Error).self) { _ = try ReceiptVerifier.verifyAssets(Data(),release:r) }
        let options = try #require(f["options"] as? [String:Any]); let expected = try #require(options["expected"] as? [String:[String:Any]]); let releasePayload = try #require(expected[ReceiptKind.release.rawValue]?["payload"] as? [String:Any]); let digest = try #require(releasePayload["assetManifestDigest"] as? String)
        #expect(ReceiptVerifier.inspectAssets(a,release:r)?["digest"] as? String == digest)
    }
    @Test func later_use_expiry_denied() throws {
        let f = try fixture(); final class Clock { var value = 160 }; let clock = Clock(); let t = try TrustContext(options:#require(f["options"] as? [String:Any]),now:{clock.value}); let r = try ReceiptVerifier.verify(positive(f,.release),kind:.release,trust:t); let a = try ReceiptVerifier.verifyAssets(Data(try #require(f["asset"] as? String).utf8),release:r); clock.value = 200
        #expect(ReceiptVerifier.inspect(r,kind:.release,trust:t) == nil); #expect(ReceiptVerifier.inspectAssets(a,release:r) == nil)
        #expect(throws:(any Error).self) { _ = try ReceiptVerifier.validateAssetResponse(a.entries[0],body:Data("synthetic application bytes".utf8),contentType:a.entries[0].mime) }
    }
    func hex(_ string: String) throws -> Data { var bytes = [UInt8](); var index = string.startIndex; while index < string.endIndex { let next = string.index(index,offsetBy:2); bytes.append(try #require(UInt8(string[index..<next],radix:16)));index = next };return Data(bytes) }
    @Test func actual_node_generated_verified_swift_and_swift_generated_exchange() throws {
        let f = try fixture(), rows = try #require(f["positive"] as? [[String:String]])
        let key = Curve25519.Signing.PrivateKey(), other = Curve25519.Signing.PrivateKey(), raw = key.publicKey.rawRepresentation
        let keyHex = raw.map { String(format:"%02x",$0) }.joined(), keyId = SHA256.hash(data:raw).map { String(format:"%02x",$0) }.joined()
        var options = try #require(f["options"] as? [String:Any]), keys = try #require(options["publicKeys"] as? [String:String])
        for kind in ReceiptKind.allCases { keys[kind.rawValue] = keyHex }; options["publicKeys"] = keys
        var positive = [[String:String]](), negative = [[String:String]]()
        func encode(_ x:Any)throws->String {
            if let o=x as? [String:Any] { return "{" + (try o.keys.sorted().map { try encode($0)+":"+encode(o[$0]!) }).joined(separator:",") + "}" }
            if let a=x as? [Any] { return "["+(try a.map(encode)).joined(separator:",")+"]" }
            return String(decoding:try JSONSerialization.data(withJSONObject:x,options:[.fragmentsAllowed,.withoutEscapingSlashes]),as:UTF8.self)
        }
        func wire(_ f:[String:Any])throws->String { String(decoding:try JSONSerialization.data(withJSONObject:f,options:.withoutEscapingSlashes),as:UTF8.self) }
        for row in rows {
            let kind = try #require(ReceiptKind(rawValue:row["kind"]!)), json = Data(row["json"]!.utf8)
            let nodeFrame = try Contracts.decode(json,kind:FrameKind(rawValue:kind.rawValue)!)
            #expect(try Contracts.receiptSigningBytes(nodeFrame).map { String(format:"%02x",$0) }.joined() == row["signingBytes"])
            let nodeTrust = try trust(f); _ = try ReceiptVerifier.verify(json,kind:kind,trust:nodeTrust)
            var frame = try #require(JSONSerialization.jsonObject(with:json) as? [String:Any]), p = try #require(frame["payload"] as? [String:Any])
            p["keyId"] = keyId; p["signature"] = String(repeating:"0",count:128);frame["payload"] = p
            var unsigned = frame; var up = p;up.removeValue(forKey:"signature");unsigned["payload"] = up
            let canonical = try encode(unsigned), signedBytes = Data(("acceptance:v1:"+kind.rawValue+"\0"+canonical).utf8)
            p["signature"] = try key.signature(for:signedBytes).map { String(format:"%02x",$0) }.joined();frame["payload"] = p
            let producedJSON = try wire(frame);positive.append(["kind":kind.rawValue,"json":producedJSON,"signingBytes":signedBytes.map { String(format:"%02x",$0) }.joined()])
            let ownTrust = try TrustContext(options:options,now:{160}), h = try ReceiptVerifier.verify(Data(producedJSON.utf8),kind:kind,trust:ownTrust)
            #expect(ReceiptVerifier.inspect(h,kind:kind,trust:ownTrust)?["kind"] as? String == kind.rawValue)
            for mode in ["tampered","wrong-domain","wrong-signer"] {
                var bad = frame, bp = p
                if mode == "tampered" { bp["signature"] = String(repeating:"f",count:128) }
                if mode == "wrong-domain" { bp["signature"] = try key.signature(for:Data(("acceptance:v1:OTHER\0"+canonical).utf8)).map { String(format:"%02x",$0) }.joined() }
                if mode == "wrong-signer" { bp["signature"] = try other.signature(for:signedBytes).map { String(format:"%02x",$0) }.joined() }
                bad["payload"] = bp;let badJSON = try wire(bad);negative.append(["kind":kind.rawValue,"mode":mode,"json":badJSON])
                #expect(throws:ReceiptError.signatureInvalid) { _ = try ReceiptVerifier.verify(Data(badJSON.utf8),kind:kind,trust:TrustContext(options:options,now:{160})) }
            }
        }
        let result:[String:Any] = ["options":options,"positive":positive,"negative":negative]
        try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.withoutEscapingSlashes]).write(to:directory().appendingPathComponent("swift.json"))
    }
    @Test func fixed_full_envelope_signing_vectors() throws {
        let root = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try #require(JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("contracts/vectors.json"))) as? [String:[[String:String]]])
        let hashes = ["531a9ee685524c8aa10f6ba99366687c01f6ad58c3f3f7c861ac3975508bc262","6acfbd00b53e5d5629054e47b026a76e7e9cfc3689dc56c8a434183536ed0cfd","606479840f537bb81e5577c06387ddd32ffd53d46f7acfd3cf06ae1bf2e031d9","f0a3ed4e7431f17360ed4a739b9ee417e18e4ddbfd017190475814593a71193e","2b90177772eb4ecf6f1501b63e6ca1d17f98d7e93f53bbda7b72fbbc704009e2"]
        for (i,kind) in ReceiptKind.allCases.enumerated() { let row = try #require(fixture["accepted"]?.first { $0["kind"] == kind.rawValue });let frame = try Contracts.decode(Data(row["json"]!.utf8),kind:FrameKind(rawValue:kind.rawValue)!);#expect(try SHA256.hash(data:Contracts.receiptSigningBytes(frame)).map { String(format:"%02x",$0) }.joined() == hashes[i]) }
        let asset = try Contracts.decode(Data(try #require(try self.fixture()["asset"] as? String).utf8),kind:.assetManifest)
        #expect(throws:ContractError.invalidFrame) { _ = try Contracts.receiptSigningBytes(asset) }
    }
    @Test func expected_false_predicates_are_denied_and_restart_key_is_same() throws {
        let f = try fixture(), originalOptions = try #require(f["options"] as? [String:Any]), negative = try #require(f["negative"] as? [[String:Any]])
        for row in negative where (row["name"] as? String ?? "").hasPrefix("predicate_") || (row["name"] as? String ?? "").hasPrefix("restart_predicate_") {
            let rawKind = try #require(row["kind"] as? String), kind = try #require(ReceiptKind(rawValue:rawKind)), json = try #require(row["json"] as? String)
            let frame = try #require(JSONSerialization.jsonObject(with:Data(json.utf8)) as? [String:Any]);var pin = frame;var payload = try #require(pin["payload"] as? [String:Any]);for key in ["issuedAt","expiresAt","keyId","signature"] { payload.removeValue(forKey:key) };pin["payload"] = payload
            var options = originalOptions, expected = try #require(options["expected"] as? [String:[String:Any]]);expected[rawKind] = pin;options["expected"] = expected
            #expect(throws:(any Error).self) { _ = try ReceiptVerifier.verify(Data(json.utf8),kind:kind,trust:TrustContext(options:options,now:{160})) }
        }
        var changed = originalOptions, keys = try #require(changed["publicKeys"] as? [String:String]);keys[ReceiptKind.restart.rawValue] = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.map { String(format:"%02x",$0) }.joined();changed["publicKeys"] = keys
        #expect(throws:ReceiptError.signatureInvalid) { _ = try TrustContext(options:changed,now:{160}) }
    }
    @Test func kind_confusion_multi_instance_coverage_and_pin_snapshot() throws {
        let f = try fixture(), options = try #require(f["options"] as? [String:Any])
        for (i,kind) in ReceiptKind.allCases.enumerated() {
            let wrong = ReceiptKind.allCases[(i+1) % ReceiptKind.allCases.count], data = try positive(f,kind), t = try trust(f)
            #expect(throws:ContractError.invalidFrame) { _ = try ReceiptVerifier.verify(data,kind:wrong,trust:t) }
        }
        var changed = options, expected = try #require(changed["expected"] as? [String:[String:Any]]), release = try #require(expected[ReceiptKind.release.rawValue]), payload = try #require(release["payload"] as? [String:Any])
        payload["expectedInstances"] = ["fixture","second"];release["payload"] = payload;expected[ReceiptKind.release.rawValue] = release;changed["expected"] = expected
        let incompleteTrust = try TrustContext(options:changed,now:{160}), restart = try positive(f,.restart)
        #expect(throws:ReceiptError.identityMismatch) { _ = try ReceiptVerifier.verify(restart,kind:.restart,trust:incompleteTrust) }
        let t = try TrustContext(options:options,now:{160}), r = try ReceiptVerifier.verify(positive(f,.release),kind:.release,trust:t)
        changed["expected"] = [:];#expect(ReceiptVerifier.inspect(r,kind:.release,trust:t) != nil)
        let replay = ReceiptReplayState(), one = try TrustContext(options:options,now:{160},replay:replay), two = try TrustContext(options:options,now:{160},replay:replay)
        _ = try ReceiptVerifier.verify(restart,kind:.restart,trust:one)
        #expect(throws:ReceiptError.replay) { _ = try ReceiptVerifier.verify(restart,kind:.restart,trust:two) }
    }
    @Test func selected_postrestart_trust_rejects_unexpired_old_maintenance() throws {
        let f = try fixture(), before = try trust(f), oldData = try positive(f,.maintenance), old = try ReceiptVerifier.verify(oldData,kind:.maintenance,trust:before)
        #expect(ReceiptVerifier.inspect(old,kind:.maintenance,trust:before) != nil)
        let post = try #require(f["postMaintenance"] as? [String:Any]), options = try #require(post["options"] as? [String:Any]), json = try #require(post["json"] as? String), after = try TrustContext(options:options,now:{160})
        #expect(ReceiptVerifier.inspect(old,kind:.maintenance,trust:after) == nil)
        #expect(throws:ReceiptError.expired) { _ = try ReceiptVerifier.verify(oldData,kind:.maintenance,trust:after) }
        let earlyJSON = try #require(post["earlyJSON"] as? String)
        #expect(throws:ReceiptError.expired) { _ = try ReceiptVerifier.verify(Data(earlyJSON.utf8),kind:.maintenance,trust:after) }
        let fresh = try ReceiptVerifier.verify(Data(json.utf8),kind:.maintenance,trust:after)
        #expect(ReceiptVerifier.inspect(fresh,kind:.maintenance,trust:after)?["sequence"] as? Int == 2)
    }
}
