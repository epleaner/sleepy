import Foundation
import Testing
@testable import NappyCore

struct StatisticsTests {
    @Test func averagesFilterByCurrentPeriodAndMode() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = date("2026-09-05T12:00:00Z")
        let todayMorning = date("2026-09-05T08:00:00Z")
        let todayAfternoon = date("2026-09-05T10:00:00Z")
        let yesterday = date("2026-09-04T08:00:00Z")
        let yesterdayAfternoon = date("2026-09-04T13:00:00Z")
        let entries = [
            SleepEntry(mode: .wake, startedAt: todayMorning, endedAt: todayAfternoon, duration: 60 * 60),
            SleepEntry(mode: .wake, startedAt: yesterdayAfternoon, endedAt: yesterdayAfternoon, duration: 90 * 60),
            SleepEntry(mode: .nap, startedAt: todayMorning, endedAt: todayMorning, duration: 30 * 60),
            SleepEntry(mode: .nap, startedAt: yesterday, endedAt: yesterday, duration: 10 * 60)
        ]

        let averages = Statistics.averages(for: entries, period: .day, now: now, calendar: calendar)
        #expect(averages.wakeCount == 1)
        #expect(averages.wakeAverage == TimeInterval(60 * 60))
        #expect(averages.napCount == 1)
        #expect(averages.napAverage == TimeInterval(30 * 60))
    }

    @Test func weekAndMonthPeriodsUseCalendarBoundaries() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2
        let now = date("2026-09-05T12:00:00Z")
        let entries = [
            SleepEntry(mode: .wake, startedAt: date("2026-09-01T08:00:00Z"), endedAt: date("2026-09-01T09:00:00Z"), duration: 60),
            SleepEntry(mode: .nap, startedAt: date("2026-09-03T08:00:00Z"), endedAt: date("2026-09-03T09:00:00Z"), duration: 120),
            SleepEntry(mode: .wake, startedAt: date("2026-08-30T08:00:00Z"), endedAt: date("2026-08-30T09:00:00Z"), duration: 300)
        ]

        let week = Statistics.averages(for: entries, period: .week, now: now, calendar: calendar)
        #expect(week.wakeCount == 1)
        #expect(week.napCount == 1)

        let month = Statistics.averages(for: entries, period: .month, now: now, calendar: calendar)
        #expect(month.wakeCount == 1)
        #expect(month.napCount == 1)
    }

    @Test func allTimeAveragesIncludeEveryEntry() {
        let entries = [
            SleepEntry(mode: .wake, startedAt: date("2026-09-01T08:00:00Z"), endedAt: date("2026-09-01T09:00:00Z"), duration: 60),
            SleepEntry(mode: .wake, startedAt: date("2026-09-02T08:00:00Z"), endedAt: date("2026-09-02T09:00:00Z"), duration: 180),
            SleepEntry(mode: .nap, startedAt: date("2026-09-03T08:00:00Z"), endedAt: date("2026-09-03T09:00:00Z"), duration: 120)
        ]

        let averages = Statistics.averages(for: entries, period: .allTime)
        #expect(averages.wakeAverage == 120)
        #expect(averages.napAverage == 120)
        #expect(averages.wakeCount == 2)
        #expect(averages.napCount == 1)
    }

    @Test func entriesRoundTripThroughStore() {
        let defaults = UserDefaults(suiteName: "NappyCoreTests.store")!
        defaults.removePersistentDomain(forName: "NappyCoreTests.store")
        let store = EntryStore(defaults: defaults, key: "entries")
        let entry = SleepEntry(mode: .nap, startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 70), duration: 60)

        store.save([entry])

        #expect(store.load() == [entry])
        store.removeAll()
        #expect(store.load().isEmpty)
    }

    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }
}
