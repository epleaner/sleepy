import XCTest

final class SleepyAppLaunchTests: XCTestCase {
    func testAppLaunchesToTimerTab() throws {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_RESET_STORE"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Today's totals"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Total wake"].exists)
        XCTAssertTrue(app.staticTexts["Total sleep"].exists)
        XCTAssertTrue(app.staticTexts["Today's entries"].exists)
    }
}
