import Foundation
import OSLog
import UserNotifications

/// A tap on a notification, handed to the UI so it can open the thread.
nonisolated struct NotificationTap: Sendable, Hashable {
    var mailboxId: String
    var threadId: String
}

/// Local notifications for new mail and fired reminders.
///
/// The Worker's push path is Web Push (VAPID), which iOS only honours for a
/// web app added to the Home Screen — a native build can't subscribe to it. So
/// alerts here are raised locally: from the SSE stream while the app is running
/// and from an opportunistic background refresh otherwise.
@MainActor
final class Notifications {
    static let shared = Notifications()
    nonisolated private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "notifications")

    private let delegate = Delegate()
    /// Set by the app so a tap can route into the thread.
    var onTap: ((NotificationTap) -> Void)?

    private init() {
        delegate.owner = self
        UNUserNotificationCenter.current().delegate = delegate
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            Self.log.error("authorization failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    var authorizationStatus: UNAuthorizationStatus {
        get async { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    }

    func newMail(
        threadId: String, mailboxId: String,
        sender: String, subject: String, preview: String, level: NotifyLevel
    ) {
        guard level != .none else { return }
        let content = UNMutableNotificationContent()
        content.title = sender
        content.subtitle = subject.nilIfBlank ?? "(no subject)"
        content.body = preview
        content.sound = .default
        content.threadIdentifier = mailboxId
        content.userInfo = ["mailboxId": mailboxId, "threadId": threadId]
        // "Time sensitive" is what the mailbox's `high` tier is for: it breaks
        // through Focus, which is exactly the promise of that setting.
        content.interruptionLevel = level == .important ? .timeSensitive : .active
        submit(id: "mail-\(threadId)", content: content)
    }

    func reminderFired(reminderId: String, mailboxId: String, threadId: String, subject: String, note: String?) {
        let content = UNMutableNotificationContent()
        content.title = "Reminder"
        content.subtitle = subject.nilIfBlank ?? "(no subject)"
        content.body = note?.nilIfBlank ?? "You asked to be reminded about this thread."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.userInfo = ["mailboxId": mailboxId, "threadId": threadId]
        submit(id: "reminder-\(reminderId)", content: content)
    }

    func sendFailed(draftId: String, error: String) {
        let content = UNMutableNotificationContent()
        content.title = "Scheduled send failed"
        content.body = error
        content.sound = .default
        submit(id: "send-failed-\(draftId)", content: content)
    }

    private func submit(id: String, content: UNNotificationContent) {
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { Self.log.error("post failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    /// Once a thread is read anywhere, its alert is stale — the hub tells every
    /// device, so this runs on `thread_read` as well as on local reads.
    func dismiss(threadId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ["mail-\(threadId)"])
        BackgroundRefresh.forget(threadId: threadId)
    }

    /// "Mark all read" doesn't enumerate threads, so drop the mailbox's alerts.
    func dismissAll(mailboxId: String) async {
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications()
            .filter { $0.request.content.threadIdentifier == mailboxId }
            .map(\.request.identifier)
        guard !ids.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count)
    }

    private final class Delegate: NSObject, UNUserNotificationCenterDelegate {
        weak var owner: Notifications?

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            // In-app banners still make sense: the reader may be in another
            // mailbox entirely.
            [.banner, .sound, .list]
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let info = response.notification.request.content.userInfo
            guard let mailboxId = info["mailboxId"] as? String,
                  let threadId = info["threadId"] as? String
            else { return }
            await MainActor.run {
                owner?.onTap?(NotificationTap(mailboxId: mailboxId, threadId: threadId))
            }
        }
    }
}
