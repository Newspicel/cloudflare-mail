import SwiftUI

/// How any view in the mail hierarchy moves the reader around, without
/// knowing whether it lives in a phone's stack or a tablet's columns.
struct MailNavigator {
    /// Push a management screen (reminders, labels, folders, contacts).
    var open: (MailRoute) -> Void
    /// Show a conversation. Replaces the one currently open rather than
    /// stacking on top of it, so "back" always returns to the list.
    var showThread: (_ threadId: String, _ mailboxId: String) -> Void
    /// Leave the open conversation — after trashing it, say.
    var closeThread: () -> Void

    static let inert = MailNavigator(open: { _ in }, showThread: { _, _ in }, closeThread: {})
}

private struct MailNavigatorKey: EnvironmentKey {
    static let defaultValue = MailNavigator.inert
}

extension EnvironmentValues {
    var mailNavigator: MailNavigator {
        get { self[MailNavigatorKey.self] }
        set { self[MailNavigatorKey.self] = newValue }
    }
}

/// Lets any view deep in the hierarchy raise the composer without threading a
/// binding through every layer.
struct ComposeAction {
    let open: (ComposeContext) -> Void
    func callAsFunction(_ context: ComposeContext) { open(context) }
}

private struct ComposeActionKey: EnvironmentKey {
    static let defaultValue = ComposeAction { _ in }
}

extension EnvironmentValues {
    var composeAction: ComposeAction {
        get { self[ComposeActionKey.self] }
        set { self[ComposeActionKey.self] = newValue }
    }
}
