import AcceptanceCore
import Foundation
import Darwin

// Compiled in M3, never executed by its tests. No operational mode has a default.
do {
    let command = try HostDispatch.parse(Array(CommandLine.arguments.dropFirst()))
    let blockers = try HostDispatch.execute(command) { path,expected,base,kernel,initramfs in
        let url = URL(fileURLWithPath:path)
        let handle = try FileHandle(forReadingFrom:url); defer { try? handle.close() }
        let bytes = try handle.read(upToCount:65537) ?? Data()
        let manifest = try ApplianceManifest.decode(bytes)
        _ = try manifest.verifyArtifacts(locations:["base":URL(fileURLWithPath:base),"kernel":URL(fileURLWithPath:kernel),"initramfs":URL(fileURLWithPath:initramfs)],expectedManifestDigest:expected)
        return manifest.runtimeBlockers
    }
    print("ARTIFACT_BYTES_VALID; RUNTIME_UNAVAILABLE; " + blockers.map(\.rawValue).joined(separator:","))
} catch {
    let code = (error as? VMFailure)?.rawValue ?? (error as? ApplianceFailure)?.rawValue ?? "INVALID_INPUT"
    FileHandle.standardError.write(Data((code+"\n").utf8)); exit(78)
}
