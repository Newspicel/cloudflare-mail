import Foundation

/// A copy of the mailbox list that survives outside a signed-in session.
///
/// App Intents, Focus filters and Shortcuts are asked to describe themselves
/// when the app isn't running and has no network — the Focus settings screen
/// wants mailbox names the moment you tap it. Rather than have those paths
/// carry an API client and a cookie, the store writes a small snapshot every
/// time it refreshes and they read that.
nonisolated struct MailboxSnapshot: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var address: String
    var title: String
    var unread: Int
    var type: MailboxType

    private static let key = "cfmail.mailboxSnapshot"

    static func save(_ mailboxes: [MailboxSummary]) {
        let snapshot = mailboxes.map {
            MailboxSnapshot(
                id: $0.id, address: $0.address, title: $0.title,
                unread: $0.unread, type: $0.type
            )
        }
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func load() -> [MailboxSnapshot] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let snapshot = try? JSONDecoder().decode([MailboxSnapshot].self, from: data)
        else { return [] }
        return snapshot
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    static func first(id: String) -> MailboxSnapshot? {
        load().first { $0.id == id }
    }

    static var totalUnread: Int {
        load().reduce(0) { $0 + $1.unread }
    }
}
