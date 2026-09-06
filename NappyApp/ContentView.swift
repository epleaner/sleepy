import SwiftUI

struct ContentView: View {
    @ObservedObject var model: BabyTimerModel

    var body: some View {
        TabView {
            TimerView(model: model)
                .tabItem { Label("Timer", systemImage: "timer") }
                .accessibilityIdentifier("Timer tab")
            EntriesView(model: model)
                .tabItem { Label("Entries", systemImage: "list.bullet.rectangle") }
                .accessibilityIdentifier("Entries tab")
            InsightsView(model: model)
                .tabItem { Label("Insights", systemImage: "chart.bar.xaxis") }
                .accessibilityIdentifier("Insights tab")
        }
        .tint(.indigo)
    }
}

struct EmptyStateView: View {
    let title: String
    let systemImage: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .padding()
    }
}
