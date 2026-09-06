import Foundation

public enum TimerMode: String, Codable, CaseIterable, Identifiable {
    case wake
    case nap

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .wake: return "Wake window"
        case .nap: return "Nap"
        }
    }

    public var shortTitle: String {
        switch self {
        case .wake: return "Wake"
        case .nap: return "Sleep"
        }
    }
}

public struct SleepEntry: Codable, Equatable, Identifiable {
    public let id: UUID
    public var mode: TimerMode
    public var startedAt: Date
    public var endedAt: Date
    public var duration: TimeInterval

    public init(
        id: UUID = UUID(),
        mode: TimerMode,
        startedAt: Date,
        endedAt: Date,
        duration: TimeInterval
    ) {
        self.id = id
        self.mode = mode
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.duration = max(0, duration)
    }
}

public struct ActiveTimer: Equatable {
    public var mode: TimerMode?
    public var startedAt: Date?
    public var accumulatedDuration: TimeInterval
    public var lastResumedAt: Date?
    public var isPaused: Bool

    public init() {
        mode = nil
        startedAt = nil
        accumulatedDuration = 0
        lastResumedAt = nil
        isPaused = false
    }

    public var isRunning: Bool { mode != nil }
}
