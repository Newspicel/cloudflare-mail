import Foundation
import OSLog
import UniformTypeIdentifiers

/// What the composer was opened for.
struct ComposeContext: Identifiable {
    enum Kind {
        case new
        case reply(message: Message, replyAll: Bool)
        case forward(message: Message)
        case draft(Draft)
    }

    let id = UUID()
    var kind: Kind
    /// Preferred sending mailbox; falls back to the first writable one.
    var mailboxId: String?
    var initialBody: String?
    var initialSubject: String?
    var initialTo: [AddressObject] = []
}

@Observable
final class ComposeModel {
    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "compose")

    private let client: APIClient
    private unowned let app: AppModel
    private unowned let mail: MailStore
    let context: ComposeContext

    // Fields
    var mailboxId: String = ""
    var to: [AddressObject] = []
    var cc: [AddressObject] = []
    var bcc: [AddressObject] = []
    var subject = ""
    var body = ""
    var format: EditorFormat = .text
    var attachments: [DraftAttachment] = []
    var showsCcBcc = false

    /// Reply/forward context. The server re-quotes the original from its stored
    /// `.eml` at send time, so the app only carries the reference.
    private(set) var quote: MessageQuoteRef?
    private(set) var inReplyTo: String?
    private(set) var references: [String] = []

    // Options
    var followUpDays: Int?
    var scheduledDate: Date?

    // Status
    private(set) var draftId: String?
    private(set) var isSending = false
    private(set) var isUploading = false
    private(set) var isSavingDraft = false
    private(set) var blockedRecipients: [String] = []
    private(set) var signature: String?

    private var saveTask: Task<Void, Never>?
    private var loadedSignatureFor: String?
    /// Set once the message is sent or discarded: an autosave that was already
    /// in flight must not resurrect it as a fresh draft.
    private var isClosed = false

    init(context: ComposeContext, client: APIClient, app: AppModel, mail: MailStore) {
        self.context = context
        self.client = client
        self.app = app
        self.mail = mail
        configure()
    }

    // ─── Setup ──────────────────────────────────────────────────────────────

    private func configure() {
        let fallback = context.mailboxId ?? mail.writableMailboxes.first?.id ?? ""
        mailboxId = fallback
        to = context.initialTo
        if let initial = context.initialBody { body = initial }
        if let initial = context.initialSubject { subject = initial }

        switch context.kind {
        case .new:
            break

        case .reply(let message, let replyAll):
            mailboxId = context.mailboxId ?? message.mailboxId
            subject = Self.prefixed(message.subject, with: "Re:")
            quote = MessageQuoteRef(messageId: message.id, kind: .reply)
            inReplyTo = message.messageIdHdr
            references = (message.references ?? []) + [message.messageIdHdr].compactMap(\.self)
            // Reply goes back to the sender — or, replying to something this
            // mailbox sent, back to whoever it was sent to. Reply-all adds the
            // other recipients minus this mailbox's own address.
            let own = mail.mailbox(id: message.mailboxId)?.address.lowercased()
            if message.isInbound {
                to = [message.sender]
            } else {
                to = Self.deduplicated(message.toAddrs)
                if to.isEmpty { to = [message.sender] }
            }
            if replyAll {
                let chosen = Set(to.map { $0.address.lowercased() })
                let others = (message.toAddrs + (message.ccAddrs ?? []))
                    .filter {
                        let address = $0.address.lowercased()
                        return address != own && address != message.fromAddr.lowercased() && !chosen.contains(address)
                    }
                cc = Self.deduplicated(others)
                showsCcBcc = !cc.isEmpty
            }

        case .forward(let message):
            mailboxId = context.mailboxId ?? message.mailboxId
            subject = Self.prefixed(message.subject, with: "Fwd:")
            quote = MessageQuoteRef(messageId: message.id, kind: .forward)

        case .draft(let draft):
            draftId = draft.id
            mailboxId = draft.mailboxId
            to = draft.toAddrs
            cc = draft.ccAddrs ?? []
            bcc = draft.bccAddrs ?? []
            subject = draft.subject
            body = draft.body
            format = draft.format
            attachments = draft.attachments
            quote = draft.quote
            inReplyTo = draft.inReplyTo
            references = draft.references ?? []
            showsCcBcc = !(draft.ccAddrs ?? []).isEmpty || !(draft.bccAddrs ?? []).isEmpty
            scheduledDate = draft.scheduledFor
        }

        if case .draft = context.kind {} else {
            format = app.prefs.composeDefaultMode ?? .text
        }
    }

    private static func prefixed(_ subject: String, with prefix: String) -> String {
        let trimmed = subject.trimmingCharacters(in: .whitespaces)
        guard !trimmed.lowercased().hasPrefix(prefix.lowercased()) else { return trimmed }
        return trimmed.isEmpty ? prefix : "\(prefix) \(trimmed)"
    }

    private static func deduplicated(_ people: [AddressObject]) -> [AddressObject] {
        var seen = Set<String>()
        return people.filter { seen.insert($0.address.lowercased()).inserted }
    }

    /// Signatures live in mailbox settings; fetch once per chosen mailbox and
    /// append to a fresh body so the reader can edit it before sending.
    func loadSignature() async {
        guard !mailboxId.isEmpty, loadedSignatureFor != mailboxId else { return }
        loadedSignatureFor = mailboxId
        do {
            let settings = try await client.mailboxSettings(mailboxId)
            guard let signature = settings.signature?.nilIfBlank else {
                self.signature = nil
                return
            }
            self.signature = signature
            if case .draft = context.kind { return }
            guard !body.contains(signature) else { return }
            body = body.isEmpty ? "\n\n-- \n\(signature)" : "\(body)\n\n-- \n\(signature)"
        } catch {
            Self.log.debug("signature lookup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // ─── Validation ─────────────────────────────────────────────────────────

    var canSend: Bool {
        !to.isEmpty && !mailboxId.isEmpty && !isSending && !isUploading
    }

    var fromMailbox: MailboxSummary? { mail.mailbox(id: mailboxId) }

    var hasContent: Bool {
        !to.isEmpty || !subject.isEmpty || !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
    }

    /// The deployment-wide blocklist rejects outbound to blocked addresses, so
    /// warn before the send round-trip rather than after it fails.
    func checkRecipients() async {
        let addresses = (to + cc + bcc).map(\.address)
        guard !addresses.isEmpty else {
            blockedRecipients = []
            return
        }
        do {
            blockedRecipients = try await client.blockedRecipients(addresses)
        } catch {
            blockedRecipients = []
        }
    }

    // ─── Attachments ────────────────────────────────────────────────────────

    func attach(data: Data, filename: String, contentType: String) async {
        isUploading = true
        defer { isUploading = false }
        do {
            let uploaded = try await client.uploadAttachment(
                data: data, filename: filename, contentType: contentType
            )
            attachments.append(
                DraftAttachment(
                    r2Key: uploaded.r2Key, filename: uploaded.filename,
                    contentType: uploaded.contentType, sizeBytes: uploaded.sizeBytes,
                    inline: false, contentId: nil
                )
            )
            scheduleDraftSave()
        } catch {
            app.handle(error)
        }
    }

    func attach(fileAt url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            await attach(data: data, filename: url.lastPathComponent, contentType: type)
        } catch {
            app.handle(error)
        }
    }

    func removeAttachment(_ attachment: DraftAttachment) {
        attachments.removeAll { $0.r2Key == attachment.r2Key }
        scheduleDraftSave()
    }

    var attachmentsTotal: Int { attachments.reduce(0) { $0 + $1.sizeBytes } }

    // ─── Drafts ─────────────────────────────────────────────────────────────

    /// Debounced autosave. The composer is a sheet the reader can swipe away,
    /// so anything typed should already be on the server by then.
    func scheduleDraftSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await self?.saveDraft(silent: true)
        }
    }

    @discardableResult
    func saveDraft(silent: Bool) async -> Bool {
        guard !isClosed, hasContent, !mailboxId.isEmpty else { return false }
        isSavingDraft = true
        defer { isSavingDraft = false }
        let input = DraftInput(
            mailboxId: draftId == nil ? mailboxId : nil,
            to: to,
            cc: cc.isEmpty ? nil : cc,
            bcc: bcc.isEmpty ? nil : bcc,
            subject: subject,
            body: body,
            format: format,
            inReplyTo: inReplyTo,
            references: references.isEmpty ? nil : references,
            quote: quote,
            attachments: attachments
        )
        do {
            if let draftId {
                _ = try await client.updateDraft(draftId, input)
            } else {
                let created = try await client.createDraft(input)
                if isClosed {
                    // Sent or discarded while this save was on the wire.
                    try? await client.deleteDraft(created.id)
                    return false
                }
                draftId = created.id
            }
            if !silent { app.show("Draft saved.", kind: .success) }
            return true
        } catch {
            if !silent { app.handle(error) }
            Self.log.debug("draft save failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func discardDraft() async {
        saveTask?.cancel()
        isClosed = true
        guard let draftId else { return }
        do {
            try await client.deleteDraft(draftId)
            self.draftId = nil
        } catch {
            app.handle(error)
        }
    }

    /// Whether closing without a prompt would still leave a draft behind —
    /// everything typed was deleted again, but an autosave already ran.
    var hasStaleDraft: Bool { draftId != nil && !hasContent }

    // ─── Sending ────────────────────────────────────────────────────────────

    private func payload() -> SendMessageInput {
        SendMessageInput(
            mailboxId: mailboxId,
            fromAddress: nil,
            to: to,
            cc: cc.isEmpty ? nil : cc,
            bcc: bcc.isEmpty ? nil : bcc,
            subject: subject,
            text: body,
            html: nil,
            inReplyTo: inReplyTo,
            references: references.isEmpty ? nil : references,
            quote: quote,
            attachments: attachments.isEmpty ? nil : attachments,
            followUpDays: followUpDays
        )
    }

    /// Returns true when the composer should close.
    func send() async -> Bool {
        guard canSend else { return false }
        isSending = true
        defer { isSending = false }
        saveTask?.cancel()
        do {
            let result = try await client.sendMessage(payload())
            isClosed = true
            if let draftId { try? await client.deleteDraft(draftId) }
            if let warning = result.pgpWarning {
                app.show(warning, kind: .info)
            } else {
                app.show("Sent.", kind: .success)
            }
            await mail.refreshEverything()
            return true
        } catch {
            app.handle(error)
            return false
        }
    }

    /// Deferred send. The server replays the resolved payload at the chosen
    /// time, so a draft has to exist first for it to hang off.
    func schedule(at date: Date) async -> Bool {
        guard canSend else { return false }
        isSending = true
        defer { isSending = false }
        guard await saveDraft(silent: true), let draftId else {
            app.show("Couldn't save the draft to schedule it.", kind: .failure)
            return false
        }
        do {
            try await client.scheduleDraft(draftId, sendAt: date, payload: payload())
            isClosed = true
            app.show("Scheduled for \(date.formatted(date: .abbreviated, time: .shortened)).", kind: .success)
            await mail.refreshEverything()
            return true
        } catch {
            app.handle(error)
            return false
        }
    }
}
