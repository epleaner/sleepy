// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SleepyCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SleepyCore", targets: ["SleepyCore"])
    ],
    targets: [
        .target(name: "SleepyCore", path: "SleepyCore"),
        .testTarget(name: "SleepyCoreTests", dependencies: ["SleepyCore"], path: "SleepyCoreTests")
    ]
)
