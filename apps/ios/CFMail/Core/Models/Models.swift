import Foundation

// Wire models. One-for-one with packages/shared/src/responses.ts — the worker's
// serializers are typed against those DTOs, so this file is the whole contract.
// `Thread`/`Label` are renamed (`MailThread`/`MailLabel`) only to stay clear of
// Foundation and SwiftUI; every coding key matches the JSON verbatim.

nonisolated struct AddressObject: Codable, Sendable, Hashable, Identifiable {
    var name: String?
    var address: String

    var id: String { address }

    /// "Ada Lovelace" when a name exists, otherwise the bare address.
    var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return address
    }

    /// RFC 5322 form for display in a header line.
    var formatted: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
            return "\(name) <\(address)>"
        }
        return address
    }
}

nonisolated struct MeUser: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var email: String
    var image: String?
    var role: UserRole
    var twoFactorEnabled: Bool?
    /// Raw JSON string of `UserPrefs`; decoded by `UserPrefs.parse`.
    var preferences: String?
}

nonisolated struct MeResponse: Codable, Sendable {
    var user: MeUser?
}

nonisolated struct MailboxSummary: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var address: String
    var displayName: String?
    var type: MailboxType
    var expiresAt: Date?
    var role: String
    var perms: Int
    var unread: Int
    var pgpMode: PgpMode
    var aiFeatures: Bool
    var excludeFromAll: Bool

    var isOwner: Bool { role == "owner" }
    var canWrite: Bool { hasBit(perms, Perm.write) }
    var canManage: Bool { hasBit(perms, Perm.manage) }
    var title: String { displayName?.nilIfBlank ?? address }
    var localPart: String { String(address.prefix(while: { $0 != "@" })) }
}

nonisolated struct MailboxListResponse: Codable, Sendable {
    var mailboxes: [MailboxSummary]
}

nonisolated struct MailThread: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var mailboxId: String
    var subjectNorm: String
    var lastMsgAt: Date
    var msgCount: Int
    var participants: [AddressObject]
    var unreadCount: Int
    var aiSummary: String?
    var aiCategory: AiCategory?
    var aiPriority: AiPriority?
    var trashed: Bool
    var trashedAt: Date?
    var spam: Bool

    var isUnread: Bool { unreadCount > 0 }
    var subject: String { subjectNorm.nilIfBlank ?? "(no subject)" }
}

nonisolated struct ThreadListResponse: Codable, Sendable {
    var threads: [MailThread]
    var nextCursor: String?
}

nonisolated struct ThreadDetailResponse: Codable, Sendable {
    var thread: MailThread
    var messages: [Message]
}

nonisolated struct SpamAuth: Codable, Sendable, Hashable {
    var spf: String?
    var dkim: String?
    var dmarc: String?

    var isEmpty: Bool { spf == nil && dkim == nil && dmarc == nil }
}

nonisolated struct MessagePgpKey: Codable, Sendable, Hashable {
    var fingerprint: String
    var source: ContactKeySource
    var verified: Bool
}

nonisolated struct Message: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var mailboxId: String
    var threadId: String
    var direction: MessageDirection
    var messageIdHdr: String?
    var inReplyTo: String?
    var references: [String]?
    var fromName: String?
    var fromAddr: String
    var deliveredTo: String?
    var toAddrs: [AddressObject]
    var ccAddrs: [AddressObject]?
    var bccAddrs: [AddressObject]?
    var subject: String
    var snippet: String
    var bodyText: String?
    var aiSummary: String?
    var aiCategory: AiCategory?
    var aiPriority: AiPriority?
    var toText: String?
    var flags: Int
    var receivedAt: Date?
    var sentAt: Date?
    var rawR2Key: String?
    var sizeBytes: Int
    var spamVerdict: SpamVerdict?
    var spamScore: Int?
    var spamReasons: [String]?
    var spamAuth: SpamAuth?
    var listUnsubscribe: String?
    var listUnsubscribePost: String?
    var pgpEncrypted: Bool
    var pgpSigned: Bool
    var pgpVerify: PgpVerify?
    var pgpSignedBy: String?
    var pgpKeyEvent: PgpKeyEvent?
    var plainR2Key: String?
    var createdAt: Date
    var pgpKey: MessagePgpKey?

    var isSeen: Bool { hasBit(flags, Flag.seen) }
    var isStarred: Bool { hasBit(flags, Flag.starred) }
    var isTrashed: Bool { hasBit(flags, Flag.trash) }
    var isInbound: Bool { direction == .incoming }
    var date: Date { receivedAt ?? sentAt ?? createdAt }
    var sender: AddressObject { AddressObject(name: fromName, address: fromAddr) }
    var isNewsletter: Bool { listUnsubscribe?.nilIfBlank != nil }
    var supportsOneClickUnsubscribe: Bool { listUnsubscribePost?.nilIfBlank != nil }
    var displaySubject: String { subject.nilIfBlank ?? "(no subject)" }
}

nonisolated struct Attachment: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var filename: String
    var contentType: String
    var sizeBytes: Int
    var inline: Bool
    var contentId: String?
}

nonisolated struct CalendarPerson: Codable, Sendable, Hashable {
    var name: String?
    var email: String?
    /// RFC 5545 PARTSTAT (attendees only).
    var status: String?

    var display: String { name?.nilIfBlank ?? email ?? "Unknown" }
}

nonisolated struct CalendarEvent: Codable, Sendable, Hashable {
    var method: String?
    var summary: String?
    var description: String?
    var location: String?
    var start: Date?
    var end: Date?
    var allDay: Bool
    var organizer: CalendarPerson?
    var attendees: [CalendarPerson]
    var rrule: String?
    var meetingUrl: String?
}

nonisolated struct MessageBody: Codable, Sendable, Hashable {
    var html: String?
    var text: String?
    var attachments: [Attachment]
    var calendar: CalendarEvent?
    var trackersBlocked: Int

    /// Real attachments — inline `cid:` parts belong to the HTML body.
    var visibleAttachments: [Attachment] { attachments.filter { !$0.inline } }
}

nonisolated struct UnsubscribeResult: Codable, Sendable {
    var status: String
    var method: String
    var url: String?
}

nonisolated struct SmartReplyResponse: Codable, Sendable {
    var suggestions: [String]
}

nonisolated struct ThreadSummaryResponse: Codable, Sendable {
    var bullets: [String]
}

nonisolated struct ThreadPatchResponse: Codable, Sendable {
    var trashed: Bool
    var spam: Bool
    var unreadCount: Int
}

nonisolated struct MessagePatchResponse: Codable, Sendable {
    var flags: Int
}

nonisolated struct DraftAttachment: Codable, Sendable, Hashable, Identifiable {
    var r2Key: String
    var filename: String
    var contentType: String
    var sizeBytes: Int
    var inline: Bool?
    var contentId: String?

    var id: String { r2Key }
}

nonisolated struct MessageQuoteRef: Codable, Sendable, Hashable {
    var messageId: String
    var kind: QuoteKind
}

nonisolated struct Draft: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var mailboxId: String
    var userId: String
    var inReplyTo: String?
    var references: [String]?
    var fromAddress: String?
    var quoteMessageId: String?
    var quoteKind: QuoteKind?
    var toAddrs: [AddressObject]
    var ccAddrs: [AddressObject]?
    var bccAddrs: [AddressObject]?
    var subject: String
    var body: String
    var markdown: Bool
    var format: EditorFormat
    var attachments: [DraftAttachment]
    var scheduledFor: Date?
    var scheduledError: String?
    var createdAt: Date
    var updatedAt: Date

    var displaySubject: String { subject.nilIfBlank ?? "(no subject)" }
    var quote: MessageQuoteRef? {
        guard let quoteMessageId, let quoteKind else { return nil }
        return MessageQuoteRef(messageId: quoteMessageId, kind: quoteKind)
    }
}

nonisolated struct DraftListResponse: Codable, Sendable {
    var drafts: [Draft]
    var nextCursor: String?
}

nonisolated struct DraftDetailResponse: Codable, Sendable {
    var draft: Draft
}

nonisolated struct MailLabel: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var mailboxId: String
    var name: String
    var color: String
}

nonisolated struct LabelListResponse: Codable, Sendable {
    var labels: [MailLabel]
}

nonisolated struct MessageLabelRef: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var color: String
}

nonisolated struct ThreadLabelsResponse: Codable, Sendable {
    var labels: [String: [MessageLabelRef]]
}

nonisolated struct Folder: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var userId: String
    var name: String
    var color: String
    var position: Int
    var createdAt: Date
    var total: Int
    var unread: Int
}

nonisolated struct FolderListResponse: Codable, Sendable {
    var folders: [Folder]
}

nonisolated struct FolderCount: Codable, Sendable, Hashable {
    var total: Int
    var unread: Int

    static let zero = FolderCount(total: 0, unread: 0)
}

nonisolated struct FolderCountsResponse: Codable, Sendable {
    var counts: [String: FolderCount]

    func count(_ view: MailView) -> FolderCount { counts[view.rawValue] ?? .zero }
}

nonisolated struct Reminder: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var userId: String
    var mailboxId: String
    var threadId: String
    var messageId: String?
    var kind: ReminderKind
    var remindAt: Date
    var subject: String
    var note: String?
    var status: ReminderStatus
    var firedAt: Date?
    var createdAt: Date
    var updatedAt: Date

    var displaySubject: String { subject.nilIfBlank ?? "(no subject)" }
}

nonisolated struct ReminderListResponse: Codable, Sendable {
    var reminders: [Reminder]
}

nonisolated struct RuleCondition: Codable, Sendable, Hashable, Identifiable {
    var field: RuleField
    var op: RuleOp
    var value: String

    var id: String { "\(field.rawValue)-\(op.rawValue)-\(value)" }
}

/// A rule action. The wire form is a `type`-tagged union (shared/schemas.ts);
/// the payload keys differ per case, so Codable is written by hand.
nonisolated enum RuleAction: Codable, Sendable, Hashable {
    case applyLabel(labelId: String)
    case moveFolder(folderId: String)
    case markRead
    case markSpam
    case forward(to: String)
    case autoReply(subject: String?, body: String)
    case hardBlock
    case stopProcessing

    private enum CodingKeys: String, CodingKey {
        case type, labelId, folderId, to, subject, body
    }

    var typeName: String {
        switch self {
        case .applyLabel: "applyLabel"
        case .moveFolder: "moveFolder"
        case .markRead: "markRead"
        case .markSpam: "markSpam"
        case .forward: "forward"
        case .autoReply: "autoReply"
        case .hardBlock: "hardBlock"
        case .stopProcessing: "stopProcessing"
        }
    }

    nonisolated init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "applyLabel": self = .applyLabel(labelId: try c.decode(String.self, forKey: .labelId))
        case "moveFolder": self = .moveFolder(folderId: try c.decode(String.self, forKey: .folderId))
        case "markRead": self = .markRead
        case "markSpam": self = .markSpam
        case "forward": self = .forward(to: try c.decode(String.self, forKey: .to))
        case "autoReply":
            self = .autoReply(
                subject: try c.decodeIfPresent(String.self, forKey: .subject),
                body: try c.decode(String.self, forKey: .body)
            )
        case "hardBlock": self = .hardBlock
        case "stopProcessing": self = .stopProcessing
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "unknown rule action \(other)"
            )
        }
    }

    nonisolated func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(typeName, forKey: .type)
        switch self {
        case .applyLabel(let labelId): try c.encode(labelId, forKey: .labelId)
        case .moveFolder(let folderId): try c.encode(folderId, forKey: .folderId)
        case .forward(let to): try c.encode(to, forKey: .to)
        case .autoReply(let subject, let body):
            try c.encodeIfPresent(subject, forKey: .subject)
            try c.encode(body, forKey: .body)
        case .markRead, .markSpam, .hardBlock, .stopProcessing: break
        }
    }
}

nonisolated struct Rule: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var mailboxId: String
    var createdBy: String
    var name: String
    var conditions: [RuleCondition]
    var conditionMode: RuleConditionMode
    var actions: [RuleAction]
    var priority: Int
    var enabled: Bool
    var createdAt: Date
    var updatedAt: Date
}

nonisolated struct RuleListResponse: Codable, Sendable {
    var rules: [Rule]
}

nonisolated struct SearchResult: Codable, Sendable, Hashable, Identifiable {
    var messageId: String
    var threadId: String
    var mailboxId: String
    var mailboxAddress: String
    var subject: String
    var snippet: String
    var fromName: String?
    var fromAddr: String
    var direction: MessageDirection
    var flags: Int
    var hasAttachments: Bool
    var receivedAt: Date?
    var sentAt: Date?

    var id: String { messageId }
    var date: Date? { receivedAt ?? sentAt }
    var isSeen: Bool { hasBit(flags, Flag.seen) }
    var displaySubject: String { subject.nilIfBlank ?? "(no subject)" }
}

nonisolated struct SearchResultsResponse: Codable, Sendable {
    var results: [SearchResult]
    var hasMore: Bool
}

nonisolated struct Contact: Codable, Sendable, Hashable, Identifiable {
    var address: String
    var name: String?

    var id: String { address }
    var asAddress: AddressObject { AddressObject(name: name, address: address) }
}

nonisolated struct ContactsResponse: Codable, Sendable {
    var contacts: [Contact]
}

nonisolated struct AiUsage: Codable, Sendable, Hashable {
    var period: String
    var calls: Int
    var tokens: Int
}

nonisolated struct MailboxSettings: Codable, Sendable, Hashable {
    var id: String
    var type: MailboxType
    var displayName: String?
    var signature: String?
    var replyTo: String?
    var spamFilter: SpamFilterLevel
    var spamAiTokenCap: Int?
    var spamUsage: AiUsage?
    var aiFeatures: Bool
    var aiTokenCap: Int?
    var aiUsage: AiUsage?
    var pgpMode: PgpMode
    var pgpFingerprint: String?
    var pgpPublicKey: String?
    var pgpConfigured: Bool
    var pgpAutoFetch: Bool
    var excludeFromAll: Bool
}

nonisolated struct MailboxMember: Codable, Sendable, Hashable, Identifiable {
    var userId: String
    var perms: Int
    var email: String
    var name: String

    var id: String { userId }
    var canRead: Bool { hasBit(perms, Perm.read) }
    var canWrite: Bool { hasBit(perms, Perm.write) }
    var canManage: Bool { hasBit(perms, Perm.manage) }

    var summary: String {
        var parts: [String] = []
        if canRead { parts.append("read") }
        if canWrite { parts.append("write") }
        if canManage { parts.append("manage") }
        return parts.isEmpty ? "no access" : parts.joined(separator: " · ")
    }
}

nonisolated struct MailboxMembersResponse: Codable, Sendable {
    var members: [MailboxMember]
}

nonisolated struct MailboxInvite: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var email: String
    var perms: Int
    var createdAt: Date
}

nonisolated struct MailboxInvitesResponse: Codable, Sendable {
    var invites: [MailboxInvite]
}

nonisolated struct DirectoryUser: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var email: String
    var name: String
}

nonisolated struct DirectoryResponse: Codable, Sendable {
    var users: [DirectoryUser]
}

nonisolated struct ContactKey: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var email: String
    var fingerprint: String
    var source: ContactKeySource
    var verified: Bool
    var expiresAt: Date?
    var createdAt: Date
}

nonisolated struct ContactKeysResponse: Codable, Sendable {
    var keys: [ContactKey]
}

nonisolated struct TrustSenderResponse: Codable, Sendable {
    var fingerprint: String
    var source: ContactKeySource
    var verify: PgpVerify?
}

nonisolated struct ImapConnection: Codable, Sendable, Hashable {
    var host: String
    var port: Int
}

nonisolated struct AppPassword: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var mailboxId: String
    var mailboxAddress: String
    var createdAt: Date
    var lastUsedAt: Date?
}

nonisolated struct AppPasswordListResponse: Codable, Sendable {
    var passwords: [AppPassword]
    var imap: ImapConnection?
}

nonisolated struct AppPasswordCreated: Codable, Sendable, Identifiable {
    var id: String
    var password: String
    var username: String
}

nonisolated struct NotifyConfig: Codable, Sendable, Hashable, Identifiable {
    var mailboxId: String
    var high: NotifyLevel
    var normal: NotifyLevel
    var low: NotifyLevel

    var id: String { mailboxId }
    var isOff: Bool { high == .none && normal == .none && low == .none }

    static let allOff = NotifyConfig(mailboxId: "", high: .none, normal: .none, low: .none)
    static let defaultOn = NotifyConfig(mailboxId: "", high: .important, normal: .normal, low: .none)
}

nonisolated struct NotifyConfigsResponse: Codable, Sendable {
    var configs: [NotifyConfig]
}

nonisolated struct TempDomain: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var allowedKinds: Int
}

nonisolated struct TempDomainsResponse: Codable, Sendable {
    var domains: [TempDomain]
}

nonisolated struct SendResult: Codable, Sendable {
    var messageId: String
    var threadId: String
    var pgpWarning: String?
}

nonisolated struct UploadedAttachment: Codable, Sendable, Hashable {
    var r2Key: String
    var filename: String
    var contentType: String
    var sizeBytes: Int
}

nonisolated struct BlockCheckResponse: Codable, Sendable {
    var blocked: [String]
}

nonisolated struct BlockRequestResponse: Codable, Sendable {
    var status: String
}

nonisolated struct OKResponse: Codable, Sendable {
    var ok: Bool?
    var deleted: Bool?
    var threads: Int?
}

// ─── User preferences (stored as a JSON string on the user row) ─────────────

nonisolated struct UserPrefs: Codable, Sendable, Hashable {
    var density: String?
    var defaultView: MailView?
    var autoMarkRead: Bool?
    var composeDefaultMode: EditorFormat?
    var replyAllDefault: Bool?
    var dateFormat: String?
    var timeFormat: String?
    var aiSummaries: Bool?

    static let empty = UserPrefs()

    var isCompact: Bool { density == "compact" }
    var showsAiSummaries: Bool { aiSummaries ?? true }
    var marksReadOnOpen: Bool { autoMarkRead ?? true }
    var uses24HourClock: Bool? { timeFormat.map { $0 == "24h" } }

    /// Never throws: a malformed or absent blob reads as "no preferences set".
    nonisolated static func parse(_ raw: String?) -> UserPrefs {
        guard let raw, let data = raw.data(using: .utf8) else { return .empty }
        return (try? JSONDecoder().decode(UserPrefs.self, from: data)) ?? .empty
    }

    func encoded() -> String? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// ─── Small helpers ─────────────────────────────────────────────────────────

nonisolated extension String {
    /// The string, or nil when it is empty or only whitespace.
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
