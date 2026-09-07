import Foundation
import UserNotifications

@MainActor
final class NotificationScheduler: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = NotificationScheduler()

    private let center = UNUserNotificationCenter.current()
    private var wakeSessionID: UUID?

    private enum Identifier {
        static let cue = "sleepy.wake.cue"
        static let nap = "sleepy.wake.nap"
    }

    private override init() {
        super.init()
    }

    func configure() {
        center.delegate = self
    }

    func beginWakeWindow(at start: Date) {
        let sessionID = UUID()
        wakeSessionID = sessionID
        cancelWakeNotifications()

        Task { @MainActor [weak self] in
            guard let self, self.wakeSessionID == sessionID else { return }
            guard await self.requestAuthorizationIfNeeded() else { return }
            guard self.wakeSessionID == sessionID else { return }
            self.scheduleWakeNotifications(startedAt: start)
        }
    }

    func endWakeWindow() {
        wakeSessionID = nil
        cancelWakeNotifications()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    private func requestAuthorizationIfNeeded() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            return false
        @unknown default:
            return false
        }
    }

    private func scheduleWakeNotifications(startedAt: Date) {
        let cue = UNMutableNotificationContent()
        cue.title = "Sleepy"
        cue.body = "Start looking for sleep cues"
        cue.sound = .default

        let nap = UNMutableNotificationContent()
        nap.title = "Sleepy"
        nap.body = "Time for a nap!"
        nap.sound = .default

        let now = Date()
        let cueDelay = max(1, (75 * 60) - now.timeIntervalSince(startedAt))
        let napDelay = max(1, (105 * 60) - now.timeIntervalSince(startedAt))
        center.add(UNNotificationRequest(
            identifier: Identifier.cue,
            content: cue,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: cueDelay, repeats: false)
        ))
        center.add(UNNotificationRequest(
            identifier: Identifier.nap,
            content: nap,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: napDelay, repeats: false)
        ))
    }

    private func cancelWakeNotifications() {
        center.removePendingNotificationRequests(withIdentifiers: [Identifier.cue, Identifier.nap])
        center.removeDeliveredNotifications(withIdentifiers: [Identifier.cue, Identifier.nap])
    }
}
