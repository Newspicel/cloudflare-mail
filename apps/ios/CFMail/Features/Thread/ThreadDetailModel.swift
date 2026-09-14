import Foundation
import OSLog

/// State for one open conversation: the messages, their lazily-fetched bodies,
/// and the best-effort AI extras the mailbox may have enabled.
@Observable
final class ThreadDetailModel {
    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "thread")

    let threadId: String
    let mailboxId: String
    private let client: APIClient
    private unowned let app: AppModel
    private unowned let mail: MailStore

    private(set) var thread: MailThread?
    private(set) var messages: [Message] = []
    private(set) var bodies: [String: MessageBody] = [:]
    private(set) var loadingBodies: Set<String> = []
    private(set) var isLoading = true
    private(set) var error: String?

    var expanded: Set<String> = []

    // AI extras — only offered when the mailbox has `aiFeatures` on.
    private(set) var summaryBullets: [String]?
    private(set) var isSummarizing = false
    private(set) var smartReplies: [String] = []
    private(set) var isDrafting = false

    private(set) var unsubscribing = false

    init(threadId: String, mailboxId: String, client: APIClient, app: AppModel, mail: MailStore) {
        self.threadId = threadId
        self.mailboxId = mailboxId
        self.client = client
        self.app = app
        self.mail = mail
    }

    var mailbox: MailboxSummary? { mail.mailbox(id: mailboxId) }
    var canWrite: Bool { mailbox?.canWrite ?? false }
    var hasAI: Bool { mailbox?.aiFeatures ?? false }
    var subject: String { messages.last?.displaySubject ?? thread?.subject ?? "Conversation" }

    var latestInbound: Message? {
        messages.filter(\.isInbound).max(by: { $0.date < $1.date })
    }

    var newest: Message? { messages.max(by: { $0.date < $1.date }) }

    // ─── Loading ────────────────────────────────────────────────────────────

    func load(markRead: Bool) async {
        do {
            let detail = try await client.thread(threadId)
            thread = detail.thread
            messages = detail.messages.sorted { $0.date < $1.date }
            error = nil
            isLoading = false

            // Open the newest message; older ones stay collapsed like a thread
            // view should.
            if expanded.isEmpty, let newest {
                expanded = [newest.id]
                await loadBody(for: newest)
            }
            if markRead, detail.thread.isUnread {
                await setThreadRead()
            }
        } catch is CancellationError {
            return
        } catch {
            isLoading = false
            self.error = error.localizedDescription
            if let apiError = error as? APIError, apiError.isAuthFailure { app.handle(error) }
        }
    }

    func reload() async {
        await load(markRead: false)
    }

    func loadBody(for message: Message) async {
        guard bodies[message.id] == nil, !loadingBodies.contains(message.id) else { return }
        loadingBodies.insert(message.id)
        defer { loadingBodies.remove(message.id) }
        do {
            bodies[message.id] = try await client.messageBody(message.id)
        } catch {
            Self.log.debug("body failed: \(error.localizedDescription, privacy: .public)")
            app.handle(error)
        }
    }

    func toggle(_ message: Message) async {
        if expanded.contains(message.id) {
            expanded.remove(message.id)
        } else {
            expanded.insert(message.id)
            await loadBody(for: message)
        }
    }

    // ─── Message actions ────────────────────────────────────────────────────

    private func setThreadRead() async {
        do {
            try await client.patchThread(threadId, read: true)
            mail.noteThreadRead(threadId, mailboxId: mailboxId)
            applyLocally { $0.flags |= Flag.seen }
        } catch {
            Self.log.debug("mark read failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func markUnread() async {
        do {
            try await client.patchThread(threadId, read: false)
            applyLocally { $0.flags &= ~Flag.seen }
            await mail.loadList(reset: true)
            await mail.refreshCatalogue()
        } catch {
            app.handle(error)
        }
    }

    func toggleStar(_ message: Message) async {
        let next = !message.isStarred
        update(message.id) { $0.flags = next ? $0.flags | Flag.starred : $0.flags & ~Flag.starred }
        do {
            _ = try await client.patchMessage(message.id, starred: next)
        } catch {
            update(message.id) { $0.flags = message.flags }
            app.handle(error)
        }
    }

    func trashMessage(_ message: Message) async {
        do {
            _ = try await client.patchMessage(message.id, trash: true)
            messages.removeAll { $0.id == message.id }
            app.show("Message moved to Trash.", kind: .success) { [weak self] in
                guard let self else { return }
                _ = try? await self.client.patchMessage(message.id, trash: false)
                await self.reload()
            }
            await mail.loadCounts()
        } catch {
            app.handle(error)
        }
    }

    func deleteMessage(_ message: Message) async {
        do {
            try await client.deleteMessage(message.id)
            messages.removeAll { $0.id == message.id }
            await mail.loadList(reset: true)
        } catch {
            app.handle(error)
        }
    }

    /// Returns an https target the caller must open, when the sender offers no
    /// server-side opt-out (`performUnsubscribe` in mail/unsubscribe.ts).
    func unsubscribe(from message: Message) async -> URL? {
        guard !unsubscribing else { return nil }
        unsubscribing = true
        defer { unsubscribing = false }
        do {
            let result = try await client.unsubscribe(messageId: message.id)
            if result.status == "unsubscribed" {
                app.show("Unsubscribe request sent.", kind: .success)
                return nil
            }
            return result.url.flatMap(URL.init(string:))
        } catch {
            app.handle(error)
            return nil
        }
    }

    func requestBlock(_ message: Message, note: String?) async {
        do {
            let status = try await client.requestBlock(messageId: message.id, note: note)
            switch status {
            case "already-blocked": app.show("That sender is already blocked.", kind: .info)
            case "pending": app.show("You've already asked to block this sender.", kind: .info)
            default: app.show("Sent to an admin for review.", kind: .success)
            }
        } catch {
            app.handle(error)
        }
    }

    func trustSender(of message: Message) async {
        do {
            let result = try await client.trustSender(messageId: message.id)
            update(message.id) {
                $0.pgpVerify = result.verify
                $0.pgpKey = MessagePgpKey(
                    fingerprint: result.fingerprint, source: result.source, verified: true
                )
                $0.pgpKeyEvent = nil
            }
            app.show("Key saved for \(message.fromAddr).", kind: .success)
        } catch {
            app.handle(error)
        }
    }

    // ─── Bytes ──────────────────────────────────────────────────────────────

    /// The instance origin, used as the web view's base so the server's
    /// same-origin image-proxy and `cid:` attachment URLs resolve.
    var baseURL: URL { client.baseURL }

    func download(_ attachment: Attachment, of message: Message) async throws -> URL {
        try await client.downloadAttachment(messageId: message.id, attachment: attachment)
    }

    func downloadRaw(_ message: Message) async throws -> URL {
        try await client.downloadRawMessage(message)
    }

    func report(_ error: any Error) { app.handle(error) }

    // ─── AI extras ──────────────────────────────────────────────────────────

    func summarize() async {
        guard hasAI, !isSummarizing else { return }
        isSummarizing = true
        defer { isSummarizing = false }
        do {
            let bullets = try await client.threadSummary(threadId)
            summaryBullets = bullets
            if bullets.isEmpty { app.show("The summary came back empty.", kind: .info) }
        } catch {
            app.handle(error)
        }
    }

    func draftReplies() async {
        guard hasAI, !isDrafting, let message = latestInbound else { return }
        isDrafting = true
        defer { isDrafting = false }
        do {
            smartReplies = try await client.smartReply(messageId: message.id)
            if smartReplies.isEmpty { app.show("No suggestions this time.", kind: .info) }
        } catch {
            app.handle(error)
        }
    }

    // ─── Local edits ────────────────────────────────────────────────────────

    private func update(_ id: String, _ mutate: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        mutate(&messages[index])
    }

    private func applyLocally(_ mutate: (inout Message) -> Void) {
        for index in messages.indices where messages[index].isInbound {
            mutate(&messages[index])
        }
    }
}
