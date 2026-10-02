// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ProductionAcceptance",
    platforms: [.macOS(.v14)],
    products: [.library(name: "AcceptanceCore", targets: ["AcceptanceCore"]), .executable(name: "acceptance-broker", targets: ["AcceptanceBroker"]), .executable(name: "acceptance-host", targets: ["AcceptanceHost"])],
    targets: [
        .target(name: "AcceptanceCore"),
        .executableTarget(name: "AcceptanceBroker", dependencies: ["AcceptanceCore"]),
        .executableTarget(name: "AcceptanceHost", dependencies: ["AcceptanceCore"]),
        .testTarget(name: "AcceptanceCoreTests", dependencies: ["AcceptanceCore"])
    ]
)
