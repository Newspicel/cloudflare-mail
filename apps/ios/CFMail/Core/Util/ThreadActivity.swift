import Foundation

/// Handoff for an open conversation.
///
/// Two things come out of advertising this. Another device signed into the same
/// Apple Account and running cfmail offers to pick the thread up where you left
/// it. And because the activity carries a `webpageURL` pointing at the same
/// thread in the instance's web app, a Mac with no cfmail app installed hands
/// off to the browser instead — the Worker serves both, so it's the same mail
/// either way.
nonisolated enum ThreadActivity {
    static let type = "dev.cfmail.thread"

    private enum Key {
        static let thread = "threadId"
        static let mailbox = "mailboxId"
    }

    /// Build the activity for a thread. `baseURL` is the instance origin, which
    /// is what makes the browser fallback work.
    static func make(threadId: String, mailboxId: String, subject: String, baseURL: URL) -> NSUserActivity {
        let activity = NSUserActivity(activityType: type)
        activity.title = subject
        activity.userInfo = [Key.thread: threadId, Key.mailbox: mailboxId]
        activity.requiredUserInfoKeys = [Key.thread, Key.mailbox]
        activity.isEligibleForHandoff = true
        // Not eligible for search or prediction: Spotlight indexing is handled
        // deliberately elsewhere, with an expiry and a sign-out purge.
        activity.isEligibleForSearch = false
        activity.isEligibleForPrediction = false
        activity.webpageURL = webURL(threadId: threadId, mailboxId: mailboxId, baseURL: baseURL)
        return activity
    }

    /// The same conversation in the web app (`/app/m/<mailbox>/t/<thread>`).
    static func webURL(threadId: String, mailboxId: String, baseURL: URL) -> URL? {
        URL(string: "app/m/\(mailboxId)/t/\(threadId)", relativeTo: baseURL)?.absoluteURL
    }

    static func parse(_ activity: NSUserActivity) -> (threadId: String, mailboxId: String)? {
        guard let info = activity.userInfo,
              let threadId = info[Key.thread] as? String,
              let mailboxId = info[Key.mailbox] as? String
        else { return nil }
        return (threadId, mailboxId)
    }
}
