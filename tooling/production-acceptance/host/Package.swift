// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ProductionAcceptance",
    platforms: [.macOS(.v14)],
    products: [.library(name: "AcceptanceCore", targets: ["AcceptanceCore"])],
    targets: [
        .target(name: "AcceptanceCore"),
        .testTarget(name: "AcceptanceCoreTests", dependencies: ["AcceptanceCore"])
    ]
)
