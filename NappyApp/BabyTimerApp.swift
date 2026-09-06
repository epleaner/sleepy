import SwiftUI

@main
struct BabyTimerApp: App {
    @StateObject private var model = BabyTimerModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}
