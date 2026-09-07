import SwiftUI

struct TimerView: View {
    @ObservedObject var model: BabyTimerModel

    private var isCueTime: Bool {
        model.activeMode == .wake && model.elapsed >= 75 * 60
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Sleepy")
                        .font(.largeTitle.bold())
                    Text(Date.now, style: .date)
                        .foregroundStyle(.secondary)

                    timerCard
                    dailyTotals
                    modeControls
                    todayEntries
                }
                .padding()
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationBarHidden(true)
        }
    }

    @ViewBuilder
    private var timerCard: some View {
        if let mode = model.activeMode {
            VStack(spacing: 18) {
                Label(mode.title, systemImage: mode == .nap ? "moon.fill" : "sun.max.fill")
                    .font(.headline)
                    .foregroundStyle(mode == .nap ? .indigo : .orange)
                Text(timerText(model.elapsed))
                    .font(.system(size: 62, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .accessibilityLabel("\(mode.title), \(timerText(model.elapsed))")
                if model.isPaused {
                    Label("Paused", systemImage: "pause.circle.fill")
                        .foregroundStyle(.secondary)
                } else if isCueTime {
                    Label("Look for sleep cues", systemImage: "eye.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.indigo)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(.indigo.opacity(0.12), in: Capsule())
                        .accessibilityLabel("Sleep cue reminder: look for sleep cues")
                }

                if mode == .nap {
                    Button(model.isPaused ? "Resume nap" : "Pause nap", systemImage: model.isPaused ? "play.fill" : "pause.fill") {
                        model.toggleNapPause()
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(model.isPaused ? "Resume nap" : "Pause nap")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .padding(.horizontal, 20)
            .background(.background, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 12, y: 5)
        }
    }

    private var modeControls: some View {
        HStack(spacing: 12) {
            modeButton(.wake)
            modeButton(.nap)
        }
    }

    private func modeButton(_ mode: TimerMode) -> some View {
        Button {
            model.start(mode)
        } label: {
            Label(mode == .wake ? "Start wake" : "Start nap", systemImage: mode == .wake ? "sun.max.fill" : "moon.fill")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(mode == .wake ? .orange : .indigo)
        .disabled(model.activeMode == mode)
        .accessibilityIdentifier(mode == .wake ? "Start wake timer" : "Start nap timer")
    }
    private var todayEntries: some View {
        let dayStart = model.todayTotals().dayStart
        let entries = dayStart.map { start in
            model.entries.filter { $0.startedAt >= start && $0.startedAt <= Date.now }
        } ?? []

        return VStack(alignment: .leading, spacing: 10) {
            Text("Today's entries")
                .font(.headline)
            if entries.isEmpty {
                Text("No completed windows today.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entries) { entry in
                    HomeEntryRow(entry: entry)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }


    private var dailyTotals: some View {
        let totals = model.todayTotals()
        return VStack(alignment: .leading, spacing: 12) {
            Text("Today's totals")
                .font(.headline)
            HStack(spacing: 12) {
                DailyTotalCard(title: "Total wake", duration: totals.wakeDuration, color: .orange, systemImage: "sun.max.fill")
                DailyTotalCard(title: "Total sleep", duration: totals.napDuration, color: .indigo, systemImage: "moon.fill")
            }
            Text(
                totals.dayStart.map { "Day started at \(entryTimeFormatter.string(from: $0))" }
                    ?? "Day starts with the first wake after 6:30 AM."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct DailyTotalCard: View {
    let title: String
    let duration: TimeInterval?
    let color: Color
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
            Text(durationText(duration))
                .font(.title2.bold().monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(durationText(duration))")
    }
}

private struct HomeEntryRow: View {
    let entry: SleepEntry

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: entry.mode == .nap ? "moon.fill" : "sun.max.fill")
                .foregroundStyle(entry.mode == .nap ? .indigo : .orange)
            Text(entry.mode.shortTitle)
                .font(.subheadline.weight(.semibold))
            Text(entryTimeFormatter.string(from: entry.startedAt))
                .foregroundStyle(.secondary)
            Spacer()
            Text(durationText(entry.duration))
                .font(.subheadline.monospacedDigit())
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.mode.shortTitle), \(entryTimeFormatter.string(from: entry.startedAt)), \(durationText(entry.duration))")
    }
}
