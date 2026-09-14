import AppIntents
import Foundation

/// A Focus filter for mail: while a Focus is on, cfmail shows only the mailbox
/// you picked for it and silences the rest.
///
/// This is the part of the multi-mailbox model that actually belongs to the
/// system rather than the app — "during Work, this is my inbox" is a statement
/// about the day, not about mail. The filter writes the choice somewhere the
/// store reads on every launch and foreground.
struct MailboxFocusFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "Choose mailbox"
    static let description = IntentDescription(
        "Show one mailbox while this Focus is on, and hold back notifications from the others."
    )

    @Parameter(title: "Mailbox")
    var mailbox: MailboxEntity?

    @Parameter(title: "Silence other mailboxes", default: true)
    var silenceOthers: Bool

    /// What the reader sees in the Focus settings row.
    var displayRepresentation: DisplayRepresentation {
        guard let mailbox else {
            return DisplayRepresentation(title: "All mailboxes")
        }
        return DisplayRepresentation(
            title: "\(mailbox.title)",
            subtitle: silenceOthers ? "Other mailboxes silenced" : "All notifications on"
        )
    }

    func perform() async throws -> some IntentResult {
        FocusFilterState.current = FocusFilterState(
            mailboxId: mailbox?.id,
            silenceOthers: silenceOthers,
            isActive: true
        )
        return .result()
    }
}

/// The active Focus filter, as the app sees it.
///
/// `SetFocusFilterIntent.perform()` runs when a Focus turns on *and* when it
/// turns off (with no mailbox), so a stored value with `isActive == false`
/// means "no filter", not "not yet set".
nonisolated struct FocusFilterState: Codable, Sendable, Hashable {
    var mailboxId: String?
    var silenceOthers: Bool
    var isActive: Bool

    private static let key = "cfmail.focusFilter"

    static let off = FocusFilterState(mailboxId: nil, silenceOthers: false, isActive: false)

    static var current: FocusFilterState {
        get {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let state = try? JSONDecoder().decode(FocusFilterState.self, from: data)
            else { return .off }
            return state
        }
        set {
            guard let data = try? JSONEncoder().encode(newValue) else { return }
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    /// Whether a mailbox's notifications should be held back right now.
    static func silences(mailboxId: String) -> Bool {
        let state = current
        guard state.isActive, state.silenceOthers, let focused = state.mailboxId else { return false }
        return focused != mailboxId
    }

    /// The mailbox the app should be showing, if a Focus has an opinion.
    static var focusedMailboxId: String? {
        let state = current
        return state.isActive ? state.mailboxId : nil
    }
}
