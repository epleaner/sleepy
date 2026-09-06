import Foundation
import Combine

@MainActor
final class BabyTimerModel: ObservableObject {
    @Published private(set) var entries: [SleepEntry]
    @Published private(set) var activeMode: TimerMode?
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var isPaused = false

    private var engine = TimerEngine()
    private let store: EntryStore
    private var ticker: Timer?

    init(store: EntryStore = EntryStore()) {
        self.store = store
        if ProcessInfo.processInfo.arguments.contains("UITEST_RESET_STORE") {
            store.removeAll()
        }
        entries = store.load()
        sync(at: Date())
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sync(at: Date()) }
        }
    }

    deinit {
        ticker?.invalidate()
    }

    func start(_ mode: TimerMode) {
        if let completed = engine.start(mode: mode, at: Date()) {
            add(completed)
        }
        sync(at: Date())
    }

    func toggleNapPause() {
        engine.togglePause(at: Date())
        sync(at: Date())
    }

    func update(_ entry: SleepEntry) {
        entries = entries.map { $0.id == entry.id ? entry : $0 }.sorted { $0.startedAt > $1.startedAt }
        store.save(entries)
    }

    func delete(_ entry: SleepEntry) {
        entries.removeAll { $0.id == entry.id }
        store.save(entries)
    }

    func averages(for period: StatsPeriod, now: Date = Date()) -> DurationAverages {
        Statistics.averages(for: entries, period: period, now: now)
    }

    private func add(_ entry: SleepEntry) {
        entries.insert(entry, at: 0)
        store.save(entries)
    }

    private func sync(at now: Date) {
        activeMode = engine.active.mode
        elapsed = engine.elapsed(at: now)
        isPaused = engine.active.isPaused
    }
}
