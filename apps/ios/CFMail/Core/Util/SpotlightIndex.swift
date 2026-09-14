import CoreSpotlight
import Foundation
import OSLog
import UniformTypeIdentifiers

/// Puts conversations into system search, so a thread turns up when you swipe
/// down on the Home Screen rather than only inside the app.
///
/// Only what the list already shows is indexed — participants, subject and the
/// AI gist. Message bodies stay on the server; the app has no local copy of
/// them and putting them in Spotlight would create one.
nonisolated enum SpotlightIndex {
    private static let log = Logger(subsystem: "dev.newspicel.cfmail", category: "spotlight")
    private static let domain = "dev.newspicel.cfmail.threads"

    /// Complete protection: subjects and gists are unreadable while the phone
    /// is locked, including from the Lock Screen's own search field. Indexing
    /// only ever runs with the app in the foreground, so nothing needs them
    /// earlier. Computed rather than stored because `CSSearchableIndex` isn't
    /// `Sendable`, and a handle is just a name — two of them address the same
    /// index.
    private static var index: CSSearchableIndex {
        CSSearchableIndex(name: "threads", protectionClass: .complete)
    }

    /// Identifier a Spotlight result carries back, so a tap can open the thread.
    static func identifier(threadId: String, mailboxId: String) -> String {
        "\(mailboxId)|\(threadId)"
    }

    static func parse(identifier: String) -> (mailboxId: String, threadId: String)? {
        let parts = identifier.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    static func index(_ threads: [MailThread], mailboxAddress: (String) -> String?) {
        guard !threads.isEmpty else { return }
        let items = threads.map { thread -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .emailMessage)
            attributes.title = thread.subject
            attributes.contentDescription = thread.aiSummary?.nilIfBlank
                ?? Fmt.participants(thread.participants)
            attributes.authorNames = thread.participants.map(\.displayName)
            attributes.authorEmailAddresses = thread.participants.map(\.address)
            attributes.contentModificationDate = thread.lastMsgAt
            if let address = mailboxAddress(thread.mailboxId) {
                attributes.accountIdentifier = address
            }
            // Keywords are what a one-word search actually matches on.
            attributes.keywords = ["mail", "cfmail"] + thread.participants.map(\.address)

            let item = CSSearchableItem(
                uniqueIdentifier: identifier(threadId: thread.id, mailboxId: thread.mailboxId),
                domainIdentifier: domain,
                attributeSet: attributes
            )
            // Mail ages out of usefulness; let the index forget it.
            item.expirationDate = Date(timeIntervalSinceNow: 90 * 24 * 3600)
            return item
        }

        index.indexSearchableItems(items) { error in
            if let error {
                log.debug("index failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    static func remove(threadId: String, mailboxId: String) {
        index.deleteSearchableItems(
            withIdentifiers: [identifier(threadId: threadId, mailboxId: mailboxId)]
        )
    }

    /// Signing out must take the index with it — those titles are mail.
    static func clear() {
        index.deleteSearchableItems(withDomainIdentifiers: [domain])
    }
}
