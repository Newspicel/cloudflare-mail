import AppIntents
import Foundation

/// A mailbox, as Shortcuts and Siri see it.
struct MailboxEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Mailbox", numericFormat: "\(placeholder: .int) mailboxes"
    )
    static let defaultQuery = MailboxEntityQuery()

    var id: String
    var address: String
    var title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(address)")
    }

    init(_ snapshot: MailboxSnapshot) {
        id = snapshot.id
        address = snapshot.address
        title = snapshot.title == snapshot.address ? snapshot.address : snapshot.title
    }
}

struct MailboxEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [MailboxEntity] {
        MailboxSnapshot.load().filter { identifiers.contains($0.id) }.map(MailboxEntity.init)
    }

    func suggestedEntities() async throws -> [MailboxEntity] {
        MailboxSnapshot.load().filter { $0.type != .service }.map(MailboxEntity.init)
    }
}

/// Where an intent asked the app to go. The app picks this up on launch or on
/// coming forward — intents run in the app's own process, but not necessarily
/// while any of its UI exists yet.
@MainActor @Observable
final class IntentRouter {
    static let shared = IntentRouter()
    private init() {}

    enum Action: Equatable {
        case openMailbox(String)
        case search(String)
        case compose(to: String?, subject: String?, body: String?)
    }

    var pending: Action?
}

// ─── Intents ────────────────────────────────────────────────────────────────

struct OpenMailboxIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Mailbox"
    static let description = IntentDescription("Opens one of your cfmail mailboxes.")
    static let openAppWhenRun = true

    @Parameter(title: "Mailbox")
    var mailbox: MailboxEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$mailbox)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentRouter.shared.pending = .openMailbox(mailbox.id)
        return .result()
    }
}

struct SearchMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Search Mail"
    static let description = IntentDescription("Searches every mailbox you can read.")
    static let openAppWhenRun = true

    @Parameter(title: "Query", requestValueDialog: "What are you looking for?")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search mail for \(\.$query)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentRouter.shared.pending = .search(query)
        return .result()
    }
}

struct ComposeMailIntent: AppIntent {
    static let title: LocalizedStringResource = "New Message"
    static let description = IntentDescription("Starts a new message in cfmail.")
    static let openAppWhenRun = true

    @Parameter(title: "To")
    var recipient: String?

    @Parameter(title: "Subject")
    var subject: String?

    @Parameter(title: "Message")
    var body: String?

    static var parameterSummary: some ParameterSummary {
        Summary("New message to \(\.$recipient)") {
            \.$subject
            \.$body
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentRouter.shared.pending = .compose(to: recipient, subject: subject, body: body)
        return .result()
    }
}

/// Answers without opening anything — the snapshot is enough.
struct UnreadCountIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Unread Count"
    static let description = IntentDescription("How much unread mail is waiting.")
    static let openAppWhenRun = false

    @Parameter(title: "Mailbox")
    var mailbox: MailboxEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Get unread count for \(\.$mailbox)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        let mailboxes = MailboxSnapshot.load()
        guard !mailboxes.isEmpty else {
            return .result(value: 0, dialog: "cfmail hasn't synced yet — open it once first.")
        }
        if let mailbox, let one = mailboxes.first(where: { $0.id == mailbox.id }) {
            return .result(
                value: one.unread,
                dialog: one.unread == 0
                    ? "\(one.address) is all read."
                    : "\(one.unread) unread in \(one.address)."
            )
        }
        let total = mailboxes.reduce(0) { $0 + $1.unread }
        return .result(
            value: total,
            dialog: total == 0 ? "No unread mail." : "\(total) unread messages."
        )
    }
}

// ─── Siri / Spotlight phrases ───────────────────────────────────────────────

struct CFMailShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: UnreadCountIntent(),
            phrases: [
                "How much unread mail do I have in \(.applicationName)",
                "Check \(.applicationName)",
            ],
            shortTitle: "Unread count",
            systemImageName: "tray.full"
        )
        AppShortcut(
            intent: ComposeMailIntent(),
            phrases: [
                "New message in \(.applicationName)",
                "Compose mail with \(.applicationName)",
            ],
            shortTitle: "New message",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: SearchMailIntent(),
            phrases: [
                "Search \(.applicationName)",
                "Find mail in \(.applicationName)",
            ],
            shortTitle: "Search mail",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: OpenMailboxIntent(),
            phrases: ["Open a mailbox in \(.applicationName)"],
            shortTitle: "Open mailbox",
            systemImageName: "tray"
        )
    }
}
