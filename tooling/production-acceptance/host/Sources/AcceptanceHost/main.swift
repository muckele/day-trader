import AcceptanceCore
import Foundation
import Darwin

// Compiled in M3, never executed by its tests. No operational mode has a default.
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if let invocation = try HostDispatch.bootstrapInvocation(arguments) {
        // This is the bounded production entry on a Darwin/arm64 host for a
        // Linux/aarch64 guest. It cannot open the supplied paths or start a VM
        // until signed/entitled native construction supplies the original host
        // channels, immutable executable-member population, guest descriptor
        // provenance, event-delivery fence and worker effect-boundary fence.
        // The offline v1 composition exercises the same evidence consumer but
        // deliberately carries none of that native source authority.
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
