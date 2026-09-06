import Foundation

public enum StatsPeriod: String, CaseIterable, Identifiable {
    case day
    case week
    case month
    case allTime

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .day: return "Today"
        case .week: return "This week"
        case .month: return "This month"
        case .allTime: return "All time"
        }
    }
}

public struct DurationAverages: Equatable {
    public let wakeAverage: TimeInterval?
    public let napAverage: TimeInterval?
    public let wakeCount: Int
    public let napCount: Int

    public init(
        wakeAverage: TimeInterval?,
        napAverage: TimeInterval?,
        wakeCount: Int,
        napCount: Int
    ) {
        self.wakeAverage = wakeAverage
        self.napAverage = napAverage
        self.wakeCount = wakeCount
        self.napCount = napCount
    }
}

public enum Statistics {
    public static func averages(
        for entries: [SleepEntry],
        period: StatsPeriod,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> DurationAverages {
        let filtered = entries.filter { entry in
            guard let interval = interval(for: period, now: now, calendar: calendar) else {
                return true
            }
            return interval.contains(entry.startedAt)
        }

        let wakeDurations = filtered.filter { $0.mode == .wake }.map(\.duration)
        let napDurations = filtered.filter { $0.mode == .nap }.map(\.duration)
        return DurationAverages(
            wakeAverage: average(wakeDurations),
            napAverage: average(napDurations),
            wakeCount: wakeDurations.count,
            napCount: napDurations.count
        )
    }

    private static func average(_ durations: [TimeInterval]) -> TimeInterval? {
        guard !durations.isEmpty else { return nil }
        return durations.reduce(0, +) / Double(durations.count)
    }

    private static func interval(
        for period: StatsPeriod,
        now: Date,
        calendar: Calendar
    ) -> DateInterval? {
        switch period {
        case .day:
            return calendar.dateInterval(of: .day, for: now)
        case .week:
            return calendar.dateInterval(of: .weekOfYear, for: now)
        case .month:
            return calendar.dateInterval(of: .month, for: now)
        case .allTime:
            return nil
        }
    }
}
