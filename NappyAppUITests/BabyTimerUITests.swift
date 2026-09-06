import XCTest

final class BabyTimerUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["UITEST_RESET_STORE"]
        app.launch()
    }

    func testWakeToNapSwitchCreatesWakeEntry() {
        app.buttons["Start wake timer"].tap()
        app.buttons["Start nap timer"].tap()

        XCTAssertTrue(app.staticTexts["Nap"].waitForExistence(timeout: 2))
        app.tabBars.buttons["Entries"].tap()
        XCTAssertTrue(app.staticTexts["Wake"].waitForExistence(timeout: 2))
    }

    func testNapCanPauseAndResumeWithoutCreatingAnotherEntry() {
        app.buttons["Start nap timer"].tap()
        app.buttons["Pause nap"].tap()
        XCTAssertTrue(app.buttons["Resume nap"].exists)
        app.buttons["Resume nap"].tap()
        XCTAssertTrue(app.buttons["Pause nap"].exists)
    }

    func testEntryCanBeEditedAndDeleted() {
        app.buttons["Start wake timer"].tap()
        app.buttons["Start nap timer"].tap()
        app.tabBars.buttons["Entries"].tap()

        let wakeRow = app.cells.firstMatch
        XCTAssertTrue(wakeRow.waitForExistence(timeout: 2))
        wakeRow.tap()
        XCTAssertTrue(app.navigationBars["Edit entry"].waitForExistence(timeout: 2))
        app.buttons["Save"].tap()

        let wakeRowAfterSave = app.cells.firstMatch
        wakeRowAfterSave.swipeLeft()
        app.buttons["Delete"].tap()
        XCTAssertTrue(app.staticTexts["No entries yet"].waitForExistence(timeout: 2))
    }

    func testInsightsOffersTimeRanges() {
        app.tabBars.buttons["Insights"].tap()
        let ranges = app.segmentedControls.firstMatch
        XCTAssertTrue(ranges.waitForExistence(timeout: 2))
        ranges.buttons["This week"].tap()
        XCTAssertTrue(app.staticTexts["Not enough data"].exists)
    }
}
