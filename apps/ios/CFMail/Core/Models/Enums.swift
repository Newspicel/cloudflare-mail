import Foundation

// Mirrors packages/db/src/enums.ts. Enums the server owns decode leniently
// where a new variant is plausible (AI taxonomy), strictly where the tuple is
// a closed contract (direction, flags, folder kinds).

nonisolated enum MailboxType: String, Codable, Sendable, CaseIterable {
    case personal, group, service, temp
}

nonisolated enum MessageDirection: String, Codable, Sendable {
    case incoming = "in"
    case outgoing = "out"
}

nonisolated enum UserRole: String, Codable, Sendable {
    case admin, user
}

nonisolated enum SpamFilterLevel: String, Codable, Sendable, CaseIterable, Identifiable {
    case off, auth, standard, ai
    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: "Off"
        case .auth: "Authentication only"
        case .standard: "Standard"
        case .ai: "Standard + AI"
        }
    }

    var detail: String {
        switch self {
        case .off: "Nothing is scored. Everything lands in the inbox."
        case .auth: "Only SPF/DKIM/DMARC failures count against a message."
        case .standard: "Authentication, reputation and content heuristics."
        case .ai: "Adds a Workers AI pass for messages the heuristics can't call."
        }
    }
}

nonisolated enum SpamVerdict: String, Codable, Sendable {
    case clean, suspicious, spam
}

nonisolated enum AiCategory: String, Codable, Sendable, CaseIterable {
    case personal, newsletter, promotion, shipping, receipt, finance
    case travel, social, security, update, notification, calendar, other

    nonisolated init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AiCategory(rawValue: raw) ?? .other
    }
}

nonisolated enum AiPriority: String, Codable, Sendable, CaseIterable {
    case high, normal, low

    nonisolated init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AiPriority(rawValue: raw) ?? .normal
    }
}

nonisolated enum NotifyLevel: String, Codable, Sendable, CaseIterable, Identifiable {
    case none, normal, important
    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: "Silent"
        case .normal: "Normal"
        case .important: "Time sensitive"
        }
    }
}

nonisolated enum EditorFormat: String, Codable, Sendable, CaseIterable, Identifiable {
    case text, markdown, html
    var id: String { rawValue }

    var title: String {
        switch self {
        case .text: "Plain text"
        case .markdown: "Markdown"
        case .html: "HTML"
        }
    }
}

nonisolated enum QuoteKind: String, Codable, Sendable {
    case reply, forward
}

nonisolated enum PgpMode: String, Codable, Sendable, CaseIterable, Identifiable {
    case off
    case sign
    case signEncrypt = "sign_encrypt"
    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: "Off"
        case .sign: "Sign outbound"
        case .signEncrypt: "Sign + encrypt outbound"
        }
    }
}

nonisolated enum PgpVerify: String, Codable, Sendable {
    case good, bad, unknown
}

nonisolated enum ContactKeySource: String, Codable, Sendable {
    case importedKey = "import"
    case tofu
    case wkd

    var label: String {
        switch self {
        case .importedKey: "Imported"
        case .tofu: "Captured from mail"
        case .wkd: "Web Key Directory"
        }
    }
}

nonisolated enum PgpKeyEvent: String, Codable, Sendable {
    case captured, rotated
}

nonisolated enum ReminderKind: String, Codable, Sendable {
    case manual
    case followUp = "follow_up"
}

nonisolated enum ReminderStatus: String, Codable, Sendable {
    case pending, fired, done, cancelled
}

nonisolated enum RuleField: String, Codable, Sendable, CaseIterable, Identifiable {
    case from, to, cc, subject, body
    case deliveredTo
    var id: String { rawValue }

    var title: String {
        switch self {
        case .from: "From"
        case .to: "To"
        case .cc: "Cc"
        case .subject: "Subject"
        case .body: "Body"
        case .deliveredTo: "Delivered to"
        }
    }
}

nonisolated enum RuleOp: String, Codable, Sendable, CaseIterable, Identifiable {
    case contains, equals, startsWith, endsWith, wildcard, regex
    var id: String { rawValue }

    var title: String {
        switch self {
        case .contains: "contains"
        case .equals: "is exactly"
        case .startsWith: "starts with"
        case .endsWith: "ends with"
        case .wildcard: "matches (glob)"
        case .regex: "matches (regex)"
        }
    }
}

nonisolated enum RuleConditionMode: String, Codable, Sendable, CaseIterable, Identifiable {
    case all, any
    var id: String { rawValue }
    var title: String { self == .all ? "Match all conditions" : "Match any condition" }
}

nonisolated enum BlockEntryType: String, Codable, Sendable {
    case email, domain
}

/// The list views a mailbox exposes. Mirrors `MAIL_VIEWS` in shared/schemas.ts.
nonisolated enum MailView: String, Codable, Sendable, CaseIterable, Identifiable {
    case inbox, drafts, sent, marked, spam, trash, all
    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .drafts: "Drafts"
        case .sent: "Sent"
        case .marked: "Starred"
        case .spam: "Spam"
        case .trash: "Trash"
        case .all: "All Mail"
        }
    }

    var symbol: String {
        switch self {
        case .inbox: "tray"
        case .drafts: "doc"
        case .sent: "paperplane"
        case .marked: "star"
        case .spam: "xmark.bin"
        case .trash: "trash"
        case .all: "tray.full"
        }
    }

    /// Mail tints every mailbox glyph with the app colour except Flagged.
    var tintIsOrange: Bool { self == .marked }

    /// Views whose badge counts unread rather than total.
    var badgeCountsUnread: Bool { self == .inbox || self == .spam }
}

nonisolated enum SearchIn: String, Codable, Sendable, CaseIterable, Identifiable {
    case all, subject, from, body
    var id: String { rawValue }
    var title: String { self == .all ? "Everywhere" : rawValue.capitalized }
}

nonisolated enum SearchFolder: String, Codable, Sendable, CaseIterable, Identifiable {
    case any, inbox, sent, marked, spam, trash
    var id: String { rawValue }

    var title: String {
        switch self {
        case .any: "Anywhere"
        case .marked: "Starred"
        default: rawValue.capitalized
        }
    }
}

nonisolated enum SearchSort: String, Codable, Sendable, CaseIterable, Identifiable {
    case newest, oldest, relevance
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

// ─── Bit flags ──────────────────────────────────────────────────────────────

/// Message flag bits (shared/flags.ts). `DELETED` is IMAP-only and never shown.
nonisolated enum Flag {
    static let seen = 1 << 0
    static let starred = 1 << 1
    static let draft = 1 << 2
    static let sent = 1 << 3
    static let trash = 1 << 4
    static let deleted = 1 << 5
}

/// Per-mailbox permission bits (shared/permissions.ts).
nonisolated enum Perm {
    static let read = 1 << 0
    static let write = 1 << 1
    static let manage = 1 << 2
    static let all = read | write | manage
}

nonisolated func hasBit(_ value: Int, _ bit: Int) -> Bool { value & bit == bit }
