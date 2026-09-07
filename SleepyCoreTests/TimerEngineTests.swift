import Foundation
import Testing
@testable import SleepyCore

struct TimerEngineTests {
    @Test func switchingModesSavesStoppedModeAndStartsNext() {
        var engine = TimerEngine()
        let morning = Date(timeIntervalSince1970: 1_000)
        let napStart = Date(timeIntervalSince1970: 1_075)

        #expect(engine.start(mode: .wake, at: morning) == nil)
        let stopped = engine.start(mode: .nap, at: napStart)

        #expect(stopped?.mode == .wake)
        #expect(stopped?.duration == 75)
        #expect(engine.active.mode == .nap)
        #expect(engine.active.startedAt == napStart)
    }

    @Test func pausingAndResumingNapKeepsOneAccumulatedDuration() {
        var engine = TimerEngine()
        let start = Date(timeIntervalSince1970: 2_000)
        _ = engine.start(mode: .nap, at: start)
        engine.togglePause(at: Date(timeIntervalSince1970: 2_030))

        #expect(engine.active.isPaused)
        #expect(engine.elapsed(at: Date(timeIntervalSince1970: 2_100)) == 30)

        engine.togglePause(at: Date(timeIntervalSince1970: 2_100))
        #expect(!engine.active.isPaused)
        #expect(engine.elapsed(at: Date(timeIntervalSince1970: 2_145)) == 75)

        let entry = engine.stop(at: Date(timeIntervalSince1970: 2_160))
        #expect(entry?.duration == 90)
    }

    @Test func pauseDoesNothingToWakeTimer() {
        var engine = TimerEngine()
        let start = Date(timeIntervalSince1970: 3_000)
        _ = engine.start(mode: .wake, at: start)
        engine.togglePause(at: Date(timeIntervalSince1970: 3_030))

        #expect(!engine.active.isPaused)
        #expect(engine.elapsed(at: Date(timeIntervalSince1970: 3_060)) == 60)
    }
}
