// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NappyCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "NappyCore", targets: ["NappyCore"])
    ],
    targets: [
        .target(name: "NappyCore", path: "NappyCore"),
        .testTarget(name: "NappyCoreTests", dependencies: ["NappyCore"], path: "NappyCoreTests")
    ]
)
