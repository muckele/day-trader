import AcceptanceCore
import Darwin

// Reject ambient authority without materializing argument/environment values.
// The trusted launcher supplies the fixed audited descriptor handoff only.
guard CommandLine.argc == 1 else { Darwin.exit(1) }
// crt_externs.h declares this system API, but Swift's Darwin import omits it.
// Resolve one fixed symbol with its C ABI; no library/path/plugin is loaded.
typealias EnvironmentPointer = @convention(c) () -> UnsafeMutablePointer<UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?>?
guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern:-2), "_NSGetEnviron") else { Darwin.exit(1) }
let environmentPointer = unsafeBitCast(symbol,to:EnvironmentPointer.self)
guard let container = environmentPointer(), let entries = container.pointee, entries.pointee == nil else { Darwin.exit(1) }

do {
    try await BrokerExecutable.run(
        native: DarwinNetworkCalls(),
        clock: SystemBrokerClock(),
        arguments: [],
        environment: [:]
    )
} catch {
    // No raw error, console input or opaque payload is printed.
    Darwin.exit(1)
}
