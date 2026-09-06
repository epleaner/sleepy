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

public struct DailyTotals: Equatable {
    public let dayStart: Date?
    public let wakeDuration: TimeInterval?
    public let napDuration: TimeInterval?

    public init(dayStart: Date?, wakeDuration: TimeInterval?, napDuration: TimeInterval?) {
        self.dayStart = dayStart
        self.wakeDuration = wakeDuration
        self.napDuration = napDuration
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

    public static func dailyTotals(
        for entries: [SleepEntry],
        activeMode: TimerMode? = nil,
        activeStartedAt: Date? = nil,
        activeDuration: TimeInterval = 0,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> DailyTotals {
        let calendarDayStart = calendar.startOfDay(for: now)
        guard let cutoff = calendar.date(byAdding: .minute, value: 390, to: calendarDayStart),
              let nextCalendarDay = calendar.date(byAdding: .day, value: 1, to: calendarDayStart) else {
            return DailyTotals(dayStart: nil, wakeDuration: nil, napDuration: nil)
        }

        var wakeStarts = entries
            .filter { $0.mode == .wake && $0.startedAt >= cutoff && $0.startedAt < nextCalendarDay }
            .map(\.startedAt)
        if activeMode == .wake,
           let activeStartedAt,
           activeStartedAt >= cutoff,
           activeStartedAt < nextCalendarDay {
            wakeStarts.append(activeStartedAt)
        }

        guard let dayStart = wakeStarts.min() else {
            return DailyTotals(dayStart: nil, wakeDuration: nil, napDuration: nil)
        }

        let relevantEntries = entries.filter {
            $0.startedAt >= dayStart && $0.startedAt <= now
        }
        var wakeDuration = relevantEntries.filter { $0.mode == .wake }.reduce(0) { $0 + $1.duration }
        var napDuration = relevantEntries.filter { $0.mode == .nap }.reduce(0) { $0 + $1.duration }

        if let activeMode,
           let activeStartedAt,
           activeStartedAt >= dayStart,
           activeStartedAt <= now {
            switch activeMode {
            case .wake:
                wakeDuration += max(0, activeDuration)
            case .nap:
                napDuration += max(0, activeDuration)
            }
        }

        return DailyTotals(
            dayStart: dayStart,
            wakeDuration: wakeDuration,
            napDuration: napDuration
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
