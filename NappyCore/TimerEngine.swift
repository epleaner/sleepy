import Foundation

public struct TimerEngine {
    public private(set) var active = ActiveTimer()

    public init() {}

    /// Stops the current mode and starts another one. The returned entry is the stopped mode.
    @discardableResult
    public mutating func start(mode: TimerMode, at now: Date) -> SleepEntry? {
        if active.mode == mode {
            return nil
        }

        let stoppedEntry = stop(at: now)
        active = ActiveTimer()
        active.mode = mode
        active.startedAt = now
        active.lastResumedAt = now
        return stoppedEntry
    }

    /// Stops the current mode and returns its accumulated duration.
    public mutating func stop(at now: Date) -> SleepEntry? {
        guard let mode = active.mode, let startedAt = active.startedAt else {
            return nil
        }

        let entry = SleepEntry(
            mode: mode,
            startedAt: startedAt,
            endedAt: now,
            duration: elapsed(at: now)
        )
        active = ActiveTimer()
        return entry
    }

    public mutating func togglePause(at now: Date) {
        guard active.mode == .nap else { return }

        if active.isPaused {
            active.isPaused = false
            active.lastResumedAt = now
        } else {
            active.accumulatedDuration = elapsed(at: now)
            active.isPaused = true
            active.lastResumedAt = nil
        }
    }

    public func elapsed(at now: Date) -> TimeInterval {
        guard active.mode != nil else { return 0 }
        guard !active.isPaused, let lastResumedAt = active.lastResumedAt else {
            return active.accumulatedDuration
        }
        return max(0, active.accumulatedDuration + now.timeIntervalSince(lastResumedAt))
    }
}
