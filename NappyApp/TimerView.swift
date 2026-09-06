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
                    Text("Nappy")
                        .font(.largeTitle.bold())
                    Text(Date.now, style: .date)
                        .foregroundStyle(.secondary)

                    timerCard
                    modeControls
                    todaySummary
                }
                .padding()
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationBarHidden(true)
        }
    }

    @ViewBuilder
    private var timerCard: some View {
        VStack(spacing: 18) {
            if let mode = model.activeMode {
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
                } else {
                    Text(mode == .nap ? "Sleep time" : "Time since waking")
                        .foregroundStyle(.secondary)
                }

                if mode == .nap {
                    Button(model.isPaused ? "Resume nap" : "Pause nap", systemImage: model.isPaused ? "play.fill" : "pause.fill") {
                        model.toggleNapPause()
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(model.isPaused ? "Resume nap" : "Pause nap")
                }
            } else {
                Image(systemName: "moon.stars.fill")
                    .font(.system(size: 42))
                    .foregroundStyle(.indigo)
                Text("Ready when baby is")
                    .font(.title2.bold())
                Text("Start a wake timer when the day begins, or a nap timer when sleep starts.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
        .background(.background, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.06), radius: 12, y: 5)
    }

    private var modeControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.activeMode == nil ? "Start tracking" : "Switch timer")
                .font(.headline)
            HStack(spacing: 12) {
                modeButton(.wake)
                modeButton(.nap)
            }
            if model.activeMode != nil {
                Text("Switching saves the current entry first.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
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

    private var todaySummary: some View {
        let today = model.entries.filter { Calendar.current.isDateInToday($0.startedAt) }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Today")
                .font(.headline)
            Text(today.isEmpty ? "No completed windows yet." : "\(today.count) completed \(today.count == 1 ? "window" : "windows")")
                .foregroundStyle(.secondary)
            if let latest = today.first {
                Text("Latest: \(latest.mode.shortTitle) · \(durationText(latest.duration))")
                    .font(.subheadline)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
