import AcceptanceCore
import Foundation
import Darwin

// Compiled in M3, never executed by its tests. No operational mode has a default.
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if let invocation = try HostDispatch.bootstrapInvocation(arguments) {
        // This is the bounded production composition entry. It cannot open the
        // supplied paths or start a VM until signed/native authority constructs
        // the fixed probe, observation, owned lifecycle/Task8 activation ports,
        // and an independently qualified inventory of executable member bytes.
        // Archive component digests alone cannot supply that inventory. Task8's
        // native waiting-child activation/helper embedding remains unavailable;
        // the Task10-only adapter does not introduce an activation protocol.
        _ = try VMHost.bootstrapCheck(invocation:invocation)
    }
    let command = try HostDispatch.parse(arguments)
    // bootstrap-check is intentionally present in the finite CLI but has no
    // operational native probe/run constructor in M4. HostDispatch therefore
    // fails closed before opening a manifest, release, VM, listener, or probe.
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
