import SwiftUI

struct InsightsView: View {
    @ObservedObject var model: BabyTimerModel
    @State private var period: StatsPeriod = .day

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Time range", selection: $period) {
                        ForEach(StatsPeriod.allCases) { period in
                            Text(period.title).tag(period)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Time range")

                    let averages = model.averages(for: period)
                    Text(period.title)
                        .font(.title2.bold())
                    Text("Average completed window")
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        AverageCard(title: "Wake", value: durationText(averages.wakeAverage), color: .orange, count: averages.wakeCount)
                        AverageCard(title: "Sleep", value: durationText(averages.napAverage), color: .indigo, count: averages.napCount)
                    }

                    if averages.wakeCount == 0 && averages.napCount == 0 {
                        EmptyStateView(title: "Not enough data", systemImage: "chart.bar.xaxis", message: "Complete a wake window or nap to see averages.")
                    } else {
                        Text("Counts use entries started within the selected range. Paused nap time is excluded from duration.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Insights")
        }
    }
}

private struct AverageCard: View {
    let title: String
    let value: String
    let color: Color
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: title == "Sleep" ? "moon.fill" : "sun.max.fill")
                .font(.headline)
                .foregroundStyle(color)
            Text(value)
                .font(.title.bold().monospacedDigit())
            Text("\(count) \(count == 1 ? "entry" : "entries")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Average \(title.lowercased()) duration \(value), \(count) entries")
    }
}
