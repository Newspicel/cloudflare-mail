import Foundation

// Request bodies. These mirror the Zod input schemas in
// packages/shared/src/schemas.ts; `nil` encodes as an absent key (never JSON
// null), which is what `.optional()` expects on the server.

nonisolated struct SendMessageInput: Codable, Sendable {
    var mailboxId: String
    var fromAddress: String?
    var to: [AddressObject]
    var cc: [AddressObject]?
    var bcc: [AddressObject]?
    var subject: String
    var text: String?
    var html: String?
    var inReplyTo: String?
    var references: [String]?
    var quote: MessageQuoteRef?
    var attachments: [DraftAttachment]?
    var followUpDays: Int?
}

nonisolated struct DraftInput: Codable, Sendable {
    var mailboxId: String?
    var fromAddress: String?
    var to: [AddressObject]?
    var cc: [AddressObject]?
    var bcc: [AddressObject]?
    var subject: String?
    var body: String?
    var format: EditorFormat?
    var inReplyTo: String?
    var references: [String]?
    var quote: MessageQuoteRef?
    var attachments: [DraftAttachment]?
}

nonisolated struct ScheduleDraftInput: Codable, Sendable {
    var sendAt: Int
    var payload: SendMessageInput
}

nonisolated struct LabelInput: Codable, Sendable {
    var mailboxId: String?
    var name: String?
    var color: String?
}

nonisolated struct FolderInput: Codable, Sendable {
    var name: String?
    var color: String?
    var position: Int?
}

nonisolated struct RuleInput: Codable, Sendable {
    var mailboxId: String?
    var name: String?
    var conditions: [RuleCondition]?
    var conditionMode: RuleConditionMode?
    var actions: [RuleAction]?
    var priority: Int?
    var enabled: Bool?
}

nonisolated struct ReminderInput: Codable, Sendable {
    var mailboxId: String?
    var threadId: String?
    var messageId: String?
    /// Epoch milliseconds — the server bounds it to the next year.
    var remindAt: Int?
    var note: String?
    var status: String?
}

nonisolated struct MailboxSettingsPatch: Codable, Sendable {
    var displayName: String?
    var signature: String?
    var replyTo: String?
    var spamFilter: SpamFilterLevel?
    var aiFeatures: Bool?
    var pgpMode: PgpMode?
    var pgpAutoFetch: Bool?
    var excludeFromAll: Bool?
}

nonisolated struct CreateMailboxInput: Codable, Sendable {
    var domainId: String
    var localPart: String
    var displayName: String?
    var type: MailboxType
    var signature: String?
    var replyTo: String?
    var ttlSeconds: Int?
}

nonisolated struct CreateTempMailboxInput: Codable, Sendable {
    var domainId: String
    var displayName: String?
    var ttlSeconds: Int
}

nonisolated struct CreateAppPasswordInput: Codable, Sendable {
    var mailboxId: String
    var name: String
}

nonisolated struct ThreadPatchInput: Codable, Sendable {
    var trashed: Bool?
    var spam: Bool?
    var read: Bool?
}

nonisolated struct MessagePatchInput: Codable, Sendable {
    var seen: Bool?
    var starred: Bool?
    var trash: Bool?
}

nonisolated struct MarkAllReadInput: Codable, Sendable {
    var mailboxId: String
    var view: MailView
}

nonisolated struct FileThreadsInput: Codable, Sendable {
    var threadIds: [String]
}

nonisolated struct SearchQuery: Sendable, Hashable {
    var q: String = ""
    var searchIn: SearchIn = .all
    var from: String?
    var to: String?
    var subject: String?
    var exclude: String?
    /// `YYYY-MM-DD`.
    var after: String?
    var before: String?
    var direction: MessageDirection?
    var hasAttachment: Bool?
    var folder: SearchFolder = .any
    var sort: SearchSort = .newest
    /// Blank or "all" searches every readable mailbox.
    var mailboxId: String?
    var limit: Int = 25
    var page: Int = 0

    /// True when nothing but the defaults is set — no point hitting the API.
    var isEmpty: Bool {
        q.trimmingCharacters(in: .whitespaces).isEmpty
            && from == nil && to == nil && subject == nil && exclude == nil
            && after == nil && before == nil && direction == nil
            && hasAttachment == nil && folder == .any
    }

    /// True when anything beyond the free-text box is narrowing the search.
    var hasFilters: Bool {
        from != nil || to != nil || subject != nil || exclude != nil || after != nil
            || before != nil || direction != nil || hasAttachment != nil
            || folder != .any || searchIn != .all || sort != .newest
    }

    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "q", value: q),
            URLQueryItem(name: "searchIn", value: searchIn.rawValue),
            URLQueryItem(name: "folder", value: folder.rawValue),
            URLQueryItem(name: "sort", value: sort.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "page", value: String(page)),
        ]
        func add(_ name: String, _ value: String?) {
            if let value, !value.isEmpty { items.append(URLQueryItem(name: name, value: value)) }
        }
        add("from", from)
        add("to", to)
        add("subject", subject)
        add("exclude", exclude)
        add("after", after)
        add("before", before)
        add("direction", direction?.rawValue)
        add("mailboxId", mailboxId)
        if let hasAttachment { add("hasAttachment", hasAttachment ? "true" : "false") }
        return items
    }
}

nonisolated enum SignInOutcome: Sendable {
    case signedIn
    case needsTwoFactor
}

// ─── The API surface ────────────────────────────────────────────────────────

extension APIClient {
    /// The combined "All mail" pseudo-mailbox id (`permissions.ts`).
    static let allMailboxes = "all"

    // Auth (Better Auth, mounted at /api/auth/*)

    func signIn(email: String, password: String) async throws -> SignInOutcome {
        struct Body: Encodable { var email: String; var password: String; var rememberMe: Bool }
        struct Response: Decodable { var twoFactorRedirect: Bool? }
        let res: Response = try await post(
            "api/auth/sign-in/email",
            body: Body(email: email, password: password, rememberMe: true)
        )
        return res.twoFactorRedirect == true ? .needsTwoFactor : .signedIn
    }

    func verifyTotp(code: String) async throws {
        struct Body: Encodable { var code: String; var trustDevice: Bool }
        try await send("POST", "api/auth/two-factor/verify-totp", body: Body(code: code, trustDevice: true))
    }

    func verifyBackupCode(code: String) async throws {
        struct Body: Encodable { var code: String }
        try await send("POST", "api/auth/two-factor/verify-backup-code", body: Body(code: code))
    }

    func signOut() async throws {
        try await send("POST", "api/auth/sign-out", body: EmptyBody())
    }

    func me() async throws -> MeUser? {
        let res: MeResponse = try await get("api/me")
        return res.user
    }

    func updateProfile(name: String? = nil, preferences: String? = nil) async throws {
        struct Body: Encodable { var name: String?; var preferences: String? }
        try await send("POST", "api/auth/update-user", body: Body(name: name, preferences: preferences))
    }

    func changePassword(current: String, new: String) async throws {
        struct Body: Encodable {
            var currentPassword: String
            var newPassword: String
            var revokeOtherSessions: Bool
        }
        try await send(
            "POST", "api/auth/change-password",
            body: Body(currentPassword: current, newPassword: new, revokeOtherSessions: false)
        )
    }

    func requestPasswordReset(email: String) async throws {
        struct Body: Encodable { var email: String; var redirectTo: String }
        try await send(
            "POST", "api/auth/request-password-reset",
            body: Body(email: email, redirectTo: baseURL.appendingPathComponent("reset-password").absoluteString)
        )
    }

    // Mailboxes

    func mailboxes() async throws -> [MailboxSummary] {
        let res: MailboxListResponse = try await get("api/mailboxes")
        return res.mailboxes
    }

    func mailboxSettings(_ id: String) async throws -> MailboxSettings {
        try await get("api/mailboxes/\(id)/settings")
    }

    func updateMailboxSettings(_ id: String, _ changes: MailboxSettingsPatch) async throws -> MailboxSettings {
        try await patch("api/mailboxes/\(id)/settings", body: changes)
    }

    func createMailbox(_ input: CreateMailboxInput) async throws {
        try await send("POST", "api/mailboxes", body: input)
    }

    func deleteMailbox(_ id: String) async throws {
        try await send("DELETE", "api/mailboxes/\(id)")
    }

    func contactKeys(mailboxId: String) async throws -> [ContactKey] {
        let res: ContactKeysResponse = try await get("api/mailboxes/\(mailboxId)/contacts")
        return res.keys
    }

    func setContactKeyVerified(mailboxId: String, keyId: String, verified: Bool) async throws {
        struct Body: Encodable { var verified: Bool }
        try await send("PATCH", "api/mailboxes/\(mailboxId)/contacts/\(keyId)", body: Body(verified: verified))
    }

    func deleteContactKey(mailboxId: String, keyId: String) async throws {
        try await send("DELETE", "api/mailboxes/\(mailboxId)/contacts/\(keyId)")
    }

    // Sharing a mailbox (group mailboxes; MANAGE only)

    func mailboxMembers(_ id: String) async throws -> [MailboxMember] {
        let res: MailboxMembersResponse = try await get("api/mailboxes/\(id)/members")
        return res.members
    }

    func grantMember(
        mailboxId: String, userId: String, read: Bool, write: Bool, manage: Bool
    ) async throws {
        struct Body: Encodable {
            var mailboxId: String
            var userId: String
            var read: Bool
            var write: Bool
            var manage: Bool
        }
        try await send(
            "POST", "api/mailboxes/\(mailboxId)/members",
            body: Body(mailboxId: mailboxId, userId: userId, read: read, write: write, manage: manage)
        )
    }

    func revokeMember(mailboxId: String, userId: String) async throws {
        try await send("DELETE", "api/mailboxes/\(mailboxId)/members/\(userId)")
    }

    func mailboxInvites(_ id: String) async throws -> [MailboxInvite] {
        let res: MailboxInvitesResponse = try await get("api/mailboxes/\(id)/invites")
        return res.invites
    }

    func revokeInvite(mailboxId: String, inviteId: String) async throws {
        try await send("DELETE", "api/mailboxes/\(mailboxId)/invites/\(inviteId)")
    }

    /// Everyone who could be granted access — the picker's source.
    func userDirectory() async throws -> [DirectoryUser] {
        let res: DirectoryResponse = try await get("api/users/directory")
        return res.users
    }

    // Threads

    func threads(
        mailboxId: String, view: MailView, limit: Int = 50,
        cursor: String? = nil, unreadOnly: Bool = false
    ) async throws -> ThreadListResponse {
        var query = [
            URLQueryItem(name: "mailboxId", value: mailboxId),
            URLQueryItem(name: "view", value: view.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if unreadOnly { query.append(URLQueryItem(name: "unread", value: "1")) }
        return try await get("api/threads", query: query)
    }

    func folderCounts(mailboxId: String) async throws -> FolderCountsResponse {
        try await get("api/threads/counts", query: [URLQueryItem(name: "mailboxId", value: mailboxId)])
    }

    func thread(_ id: String) async throws -> ThreadDetailResponse {
        try await get("api/threads/\(id)")
    }

    @discardableResult
    func patchThread(_ id: String, trashed: Bool? = nil, spam: Bool? = nil, read: Bool? = nil) async throws -> ThreadPatchResponse {
        try await patch("api/threads/\(id)", body: ThreadPatchInput(trashed: trashed, spam: spam, read: read))
    }

    func deleteThread(_ id: String) async throws {
        try await send("DELETE", "api/threads/\(id)")
    }

    func markAllRead(mailboxId: String, view: MailView) async throws {
        try await send("POST", "api/threads/read-all", body: MarkAllReadInput(mailboxId: mailboxId, view: view))
    }

    func threadSummary(_ id: String) async throws -> [String] {
        let res: ThreadSummaryResponse = try await post("api/threads/\(id)/summary")
        return res.bullets
    }

    // Messages

    func messageBody(_ id: String) async throws -> MessageBody {
        try await get("api/messages/\(id)/body")
    }

    @discardableResult
    func patchMessage(_ id: String, seen: Bool? = nil, starred: Bool? = nil, trash: Bool? = nil) async throws -> Int {
        let res: MessagePatchResponse = try await patch(
            "api/messages/\(id)", body: MessagePatchInput(seen: seen, starred: starred, trash: trash)
        )
        return res.flags
    }

    func deleteMessage(_ id: String) async throws {
        try await send("DELETE", "api/messages/\(id)")
    }

    func sendMessage(_ input: SendMessageInput) async throws -> SendResult {
        try await post("api/messages/send", body: input)
    }

    func smartReply(messageId: String) async throws -> [String] {
        let res: SmartReplyResponse = try await post("api/messages/\(messageId)/smart-reply")
        return res.suggestions
    }

    func unsubscribe(messageId: String) async throws -> UnsubscribeResult {
        try await post("api/messages/\(messageId)/unsubscribe")
    }

    func requestBlock(messageId: String, note: String?) async throws -> String {
        struct Body: Encodable { var note: String? }
        let res: BlockRequestResponse = try await post(
            "api/messages/\(messageId)/block-request", body: Body(note: note?.nilIfBlank)
        )
        return res.status
    }

    func trustSender(messageId: String) async throws -> TrustSenderResponse {
        try await post("api/messages/\(messageId)/pgp/trust-sender")
    }

    func rawMessageURL(_ id: String, download: Bool = false) -> URL {
        url("api/messages/\(id)/raw", query: download ? [URLQueryItem(name: "download", value: "")] : [])
    }

    func attachmentURL(messageId: String, attachmentId: String, download: Bool = false) -> URL {
        url(
            "api/messages/\(messageId)/attachments/\(attachmentId)/raw",
            query: download ? [URLQueryItem(name: "download", value: "")] : []
        )
    }

    func downloadAttachment(messageId: String, attachment: Attachment) async throws -> URL {
        try await download(
            attachmentURL(messageId: messageId, attachmentId: attachment.id, download: true),
            suggestedName: attachment.filename
        )
    }

    func downloadRawMessage(_ message: Message) async throws -> URL {
        let stem = message.subject.nilIfBlank.map {
            $0.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }
        return try await download(
            rawMessageURL(message.id, download: true),
            suggestedName: "\(stem?.nilIfBlank ?? "email").eml"
        )
    }

    // Drafts

    func drafts(mailboxId: String, limit: Int = 50, cursor: String? = nil) async throws -> DraftListResponse {
        var query = [
            URLQueryItem(name: "mailboxId", value: mailboxId),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("api/drafts", query: query)
    }

    func draft(_ id: String) async throws -> Draft {
        let res: DraftDetailResponse = try await get("api/drafts/\(id)")
        return res.draft
    }

    func createDraft(_ input: DraftInput) async throws -> Draft {
        let res: DraftDetailResponse = try await post("api/drafts", body: input)
        return res.draft
    }

    func updateDraft(_ id: String, _ input: DraftInput) async throws -> Draft {
        let res: DraftDetailResponse = try await patch("api/drafts/\(id)", body: input)
        return res.draft
    }

    func deleteDraft(_ id: String) async throws {
        try await send("DELETE", "api/drafts/\(id)")
    }

    func scheduleDraft(_ id: String, sendAt: Date, payload: SendMessageInput) async throws {
        let input = ScheduleDraftInput(sendAt: Int(sendAt.timeIntervalSince1970 * 1000), payload: payload)
        try await send("POST", "api/drafts/\(id)/schedule", body: input)
    }

    func cancelScheduledDraft(_ id: String) async throws {
        try await send("DELETE", "api/drafts/\(id)/schedule")
    }

    // Labels

    func labels(mailboxId: String) async throws -> [MailLabel] {
        let res: LabelListResponse = try await get(
            "api/labels", query: [URLQueryItem(name: "mailboxId", value: mailboxId)]
        )
        return res.labels
    }

    func createLabel(mailboxId: String, name: String, color: String?) async throws -> MailLabel {
        try await post("api/labels", body: LabelInput(mailboxId: mailboxId, name: name, color: color))
    }

    func updateLabel(_ id: String, name: String?, color: String?) async throws {
        try await send("PATCH", "api/labels/\(id)", body: LabelInput(name: name, color: color))
    }

    func deleteLabel(_ id: String) async throws {
        try await send("DELETE", "api/labels/\(id)")
    }

    func applyLabel(_ labelId: String, toThread threadId: String) async throws {
        try await send("PUT", "api/labels/\(labelId)/threads/\(threadId)")
    }

    func removeLabel(_ labelId: String, fromThread threadId: String) async throws {
        try await send("DELETE", "api/labels/\(labelId)/threads/\(threadId)")
    }

    func labels(forThreads ids: [String]) async throws -> [String: [MessageLabelRef]] {
        guard !ids.isEmpty else { return [:] }
        let res: ThreadLabelsResponse = try await get(
            "api/labels/by-threads", query: ids.map { URLQueryItem(name: "id", value: $0) }
        )
        return res.labels
    }

    // Folders (user-level, not mailbox-scoped)

    func folders() async throws -> [Folder] {
        let res: FolderListResponse = try await get("api/folders")
        return res.folders
    }

    func createFolder(name: String, color: String?) async throws -> Folder {
        try await post("api/folders", body: FolderInput(name: name, color: color))
    }

    func updateFolder(_ id: String, name: String? = nil, color: String? = nil, position: Int? = nil) async throws {
        try await send("PATCH", "api/folders/\(id)", body: FolderInput(name: name, color: color, position: position))
    }

    func deleteFolder(_ id: String) async throws {
        try await send("DELETE", "api/folders/\(id)")
    }

    func folderThreads(_ id: String, limit: Int = 50, cursor: String? = nil) async throws -> ThreadListResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("api/folders/\(id)/threads", query: query)
    }

    func fileThreads(_ threadIds: [String], into folderId: String) async throws {
        try await send("POST", "api/folders/\(folderId)/threads", body: FileThreadsInput(threadIds: threadIds))
    }

    func unfileThread(_ threadId: String, from folderId: String) async throws {
        try await send("DELETE", "api/folders/\(folderId)/threads/\(threadId)")
    }

    // Rules

    func rules(mailboxId: String) async throws -> [Rule] {
        let res: RuleListResponse = try await get(
            "api/rules", query: [URLQueryItem(name: "mailboxId", value: mailboxId)]
        )
        return res.rules
    }

    func createRule(_ input: RuleInput) async throws -> Rule {
        try await post("api/rules", body: input)
    }

    func updateRule(_ id: String, _ input: RuleInput) async throws {
        try await send("PATCH", "api/rules/\(id)", body: input)
    }

    func deleteRule(_ id: String) async throws {
        try await send("DELETE", "api/rules/\(id)")
    }

    // Reminders

    func reminders() async throws -> [Reminder] {
        let res: ReminderListResponse = try await get("api/reminders")
        return res.reminders
    }

    func createReminder(mailboxId: String, threadId: String, messageId: String?, at date: Date, note: String?) async throws -> Reminder {
        try await post(
            "api/reminders",
            body: ReminderInput(
                mailboxId: mailboxId, threadId: threadId, messageId: messageId,
                remindAt: Int(date.timeIntervalSince1970 * 1000), note: note?.nilIfBlank
            )
        )
    }

    func dismissReminder(_ id: String) async throws {
        try await send("PATCH", "api/reminders/\(id)", body: ReminderInput(status: "done"))
    }

    func rescheduleReminder(_ id: String, to date: Date) async throws {
        try await send(
            "PATCH", "api/reminders/\(id)",
            body: ReminderInput(remindAt: Int(date.timeIntervalSince1970 * 1000))
        )
    }

    func deleteReminder(_ id: String) async throws {
        try await send("DELETE", "api/reminders/\(id)")
    }

    // Search + contacts

    func search(_ query: SearchQuery) async throws -> SearchResultsResponse {
        try await get("api/search", query: query.queryItems)
    }

    func contacts() async throws -> [Contact] {
        let res: ContactsResponse = try await get("api/contacts")
        return res.contacts
    }

    func blockedRecipients(_ addresses: [String]) async throws -> [String] {
        struct Body: Encodable { var addresses: [String] }
        let res: BlockCheckResponse = try await post("api/blocklist/check", body: Body(addresses: addresses))
        return res.blocked
    }

    // Attachments

    func uploadAttachment(data: Data, filename: String, contentType: String) async throws -> UploadedAttachment {
        var req = URLRequest(url: url("api/attachments/upload"))
        req.httpMethod = "POST"
        req.httpBody = data
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.setValue(filename, forHTTPHeaderField: "X-Filename")
        return try await upload(req)
    }

    // App passwords (IMAP)

    func appPasswords() async throws -> AppPasswordListResponse {
        try await get("api/app-passwords")
    }

    func createAppPassword(mailboxId: String, name: String) async throws -> AppPasswordCreated {
        try await post("api/app-passwords", body: CreateAppPasswordInput(mailboxId: mailboxId, name: name))
    }

    func deleteAppPassword(_ id: String) async throws {
        try await send("DELETE", "api/app-passwords/\(id)")
    }

    // Notifications

    func notifyConfigs() async throws -> [NotifyConfig] {
        let res: NotifyConfigsResponse = try await get("api/push/mailboxes")
        return res.configs
    }

    func setNotifyConfig(mailboxId: String, high: NotifyLevel, normal: NotifyLevel, low: NotifyLevel) async throws {
        struct Body: Encodable { var high: NotifyLevel; var normal: NotifyLevel; var low: NotifyLevel }
        try await send("PUT", "api/push/mailboxes/\(mailboxId)", body: Body(high: high, normal: normal, low: low))
    }

    // Temp mailboxes

    func tempDomains() async throws -> [TempDomain] {
        let res: TempDomainsResponse = try await get("api/temp/domains")
        return res.domains
    }

    func createTempMailbox(domainId: String, ttlSeconds: Int, displayName: String?) async throws {
        try await send(
            "POST", "api/temp",
            body: CreateTempMailboxInput(domainId: domainId, displayName: displayName?.nilIfBlank, ttlSeconds: ttlSeconds)
        )
    }
}

nonisolated struct EmptyBody: Encodable, Sendable {}
