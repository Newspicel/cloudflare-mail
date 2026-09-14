import Foundation

/// One realtime event off `GET /api/stream` (the `UserHub` Durable Object).
/// Mirrors the discriminated union in packages/shared/src/events.ts. Unknown
/// types decode to `.unknown` rather than killing the stream — the server may
/// ship a new event before this app knows about it.
nonisolated enum HubEvent: Sendable, Hashable {
    case newMessage(mailboxId: String, messageId: String, threadId: String)
    case messageSent(mailboxId: String, messageId: String, threadId: String)
    case threadUpdated(mailboxId: String, threadId: String)
    case threadRead(mailboxId: String, threadId: String, read: Bool)
    case mailboxRead(mailboxId: String)
    case mailboxExpired(mailboxId: String)
    case mailboxChanged(mailboxId: String)
    case scheduledSendFailed(mailboxId: String, draftId: String, error: String)
    case reminderFired(reminderId: String, mailboxId: String, threadId: String, subject: String, note: String?)
    case ping
    case unknown(String)

    /// The mailbox this event concerns, when it names one.
    var mailboxId: String? {
        switch self {
        case .newMessage(let m, _, _), .messageSent(let m, _, _),
             .threadUpdated(let m, _), .threadRead(let m, _, _),
             .mailboxRead(let m), .mailboxExpired(let m), .mailboxChanged(let m),
             .scheduledSendFailed(let m, _, _), .reminderFired(_, let m, _, _, _):
            m
        case .ping, .unknown:
            nil
        }
    }

    private struct Payload: Decodable {
        var type: String
        var mailboxId: String?
        var messageId: String?
        var threadId: String?
        var draftId: String?
        var reminderId: String?
        var subject: String?
        var note: String?
        var error: String?
        var read: Bool?
    }

    /// Parse one `data:` line. Returns nil when the JSON is unreadable.
    nonisolated static func parse(_ data: Data) -> HubEvent? {
        guard let p = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        let mailbox = p.mailboxId ?? ""
        switch p.type {
        case "new_message":
            return .newMessage(mailboxId: mailbox, messageId: p.messageId ?? "", threadId: p.threadId ?? "")
        case "message_sent":
            return .messageSent(mailboxId: mailbox, messageId: p.messageId ?? "", threadId: p.threadId ?? "")
        case "thread_updated":
            return .threadUpdated(mailboxId: mailbox, threadId: p.threadId ?? "")
        case "thread_read":
            return .threadRead(mailboxId: mailbox, threadId: p.threadId ?? "", read: p.read ?? false)
        case "mailbox_read":
            return .mailboxRead(mailboxId: mailbox)
        case "mailbox_expired":
            return .mailboxExpired(mailboxId: mailbox)
        case "mailbox_changed":
            return .mailboxChanged(mailboxId: mailbox)
        case "scheduled_send_failed":
            return .scheduledSendFailed(mailboxId: mailbox, draftId: p.draftId ?? "", error: p.error ?? "send failed")
        case "reminder_fired":
            return .reminderFired(
                reminderId: p.reminderId ?? "", mailboxId: mailbox,
                threadId: p.threadId ?? "", subject: p.subject ?? "", note: p.note
            )
        case "ping":
            return .ping
        case let other:
            return .unknown(other)
        }
    }
}
