import XCTest

final class NappyAppLaunchTests: XCTestCase {
    func testAppLaunchesToTimerTab() throws {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_RESET_STORE"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Ready when baby is"].waitForExistence(timeout: 3))
    }
}
