import Foundation
import CryptoKit

// C3 (E3, T10-10): one key per channel, derived from the 32-byte run capability:
//   derive(capability,label) = HMAC-SHA256(key:capability,
//       "acceptance:key-derivation:v1\0" || label || "\0")
// for exactly two labels. The guest proxy receives only the vsock-stream key
// (R6); the host and the bootstrap keep the capability, and the topology
// handoff MAC uses only the topology-admission key.
enum ChannelKeys {
    static let vsockStream = "vsock-stream", topologyAdmission = "topology-admission"
    private static let domain = Data("acceptance:key-derivation:v1\0".utf8)

    static func derive(capability:Data,label:String) throws -> Data {
        // Byte comparison: String equality is canonical equivalence, not identity.
        let bytes = Array(label.utf8)
        guard capability.count == 32,
              bytes == Array(vsockStream.utf8) || bytes == Array(topologyAdmission.utf8)
              else { throw VMFailure.admissionUnavailable }
        var message = domain
        message.append(contentsOf:bytes); message.append(0)
        return Data(HMAC<SHA256>.authenticationCode(for:message,using:SymmetricKey(data:capability)))
    }
}
