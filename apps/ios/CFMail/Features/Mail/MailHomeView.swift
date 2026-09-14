import CoreSpotlight
import SwiftUI

/// Where a push in the mail stack can land.
enum MailRoute: Hashable {
    /// The thread list for the current scope. Only used on iPhone, where the
    /// list is pushed on top of the mailbox list rather than sitting beside it.
    case list
    case thread(id: String, mailboxId: String)
    case reminders
    case labels
    case folders
    case contacts
}

/// Root of the signed-in app.
///
/// iPhone gets Apple Mail's shape: mailboxes are the root, the list is pushed
/// on top of them and is where you land, so "back" reaches the mailbox list.
/// iPad gets the two-column split view, mailboxes permanently beside the list.
struct MailHomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var intents = IntentRouter.shared

    // Starts on the list: the mailbox picker is the root, but it isn't where
    // a reader wants to land.
    @State private var stackPath: [MailRoute] = [.list]
    @State private var detailPath: [MailRoute] = []
    @State private var compose: ComposeContext?
    @State private var showingSettings = false
    @State private var showingTempMailbox = false

    private var isCompact: Bool { sizeClass == .compact }

    var body: some View {
        Group {
            if isCompact { compactLayout } else { wideLayout }
        }
        .sheet(item: $compose) { context in
            ComposeView(context: context)
                .environment(app)
                .environment(mail)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
                .environment(app)
                .environment(mail)
        }
        .sheet(isPresented: $showingTempMailbox) {
            TempMailboxSheet()
                .environment(mail)
                .presentationDetents([.medium])
        }
        .task {
            // Ask once the reader is actually in the app, not at launch.
            if await Notifications.shared.authorizationStatus == .notDetermined {
                await Notifications.shared.requestAuthorization()
            }
            await mail.loadContactsIfNeeded()
        }
        // Siri, Shortcuts and the Focus filter all arrive here.
        .onChange(of: intents.pending) { _, action in
            guard let action else { return }
            intents.pending = nil
            perform(action)
        }
        .task {
            // A cold launch from an intent sets `pending` before this view exists.
            if let action = intents.pending {
                intents.pending = nil
                perform(action)
            }
        }
        // A tap on a cfmail result in system search.
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                  let found = SpotlightIndex.parse(identifier: identifier)
            else { return }
            open(threadId: found.threadId, mailboxId: found.mailboxId)
        }
        // Handoff from another device running cfmail, or from the web app.
        .onContinueUserActivity(ThreadActivity.type) { activity in
            guard let found = ThreadActivity.parse(activity) else { return }
            open(threadId: found.threadId, mailboxId: found.mailboxId)
        }
        .onChange(of: app.pendingTap) { _, tap in
            guard let tap else { return }
            app.pendingTap = nil
            mail.scope = .mailbox(tap.mailboxId)
            let thread = MailRoute.thread(id: tap.threadId, mailboxId: tap.mailboxId)
            if isCompact {
                stackPath = [.list, thread]
            } else {
                detailPath = [thread]
            }
        }
        .environment(\.composeAction, ComposeAction { compose = $0 })
    }

    // ─── iPhone ─────────────────────────────────────────────────────────────

    private var compactLayout: some View {
        NavigationStack(path: $stackPath) {
            sidebar
                .navigationDestination(for: MailRoute.self, destination: destination)
        }
        // Picking a mailbox or folder opens it rather than staying put.
        .onChange(of: mail.scope) { _, _ in stackPath = [.list] }
    }

    // ─── iPad ───────────────────────────────────────────────────────────────

    private var wideLayout: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            NavigationStack(path: $detailPath) {
                threadList
                    .navigationDestination(for: MailRoute.self, destination: destination)
            }
        }
        .navigationSplitViewStyle(.balanced)
        // A different mailbox means the open conversation is no longer relevant.
        .onChange(of: mail.scope) { _, _ in detailPath.removeAll() }
    }

    // ─── Pieces ─────────────────────────────────────────────────────────────

    private var sidebar: some View {
        SidebarView(
            onOpenSettings: { showingSettings = true },
            onNewTempMailbox: { showingTempMailbox = true },
            onNavigate: push,
            onSelectScope: select
        )
    }

    private var threadList: some View {
        ThreadListView(onCompose: { compose = $0 }, onOpen: push)
    }

    /// Open a scope, whether or not it's the one already showing.
    private func select(_ scope: MailScope) {
        mail.scope = scope
        if isCompact {
            stackPath = [.list]
        } else {
            detailPath.removeAll()
        }
    }

    private func perform(_ action: IntentRouter.Action) {
        switch action {
        case .openMailbox(let id):
            select(.mailbox(id))
        case .search(let query):
            mail.pendingSearch = query
            if isCompact { stackPath = [.list] } else { detailPath.removeAll() }
        case .compose(let to, let subject, let body):
            compose = ComposeContext(
                kind: .new,
                mailboxId: mail.currentMailbox?.id ?? mail.writableMailboxes.first?.id,
                initialBody: body,
                initialSubject: subject,
                initialTo: to.flatMap(RecipientField.parse).map { [$0] } ?? []
            )
        }
    }

    private func open(threadId: String, mailboxId: String) {
        mail.scope = .mailbox(mailboxId)
        let route = MailRoute.thread(id: threadId, mailboxId: mailboxId)
        if isCompact { stackPath = [.list, route] } else { detailPath = [route] }
    }

    private func push(_ route: MailRoute) {
        if isCompact {
            if stackPath.isEmpty { stackPath = [.list] }
            stackPath.append(route)
        } else {
            detailPath.append(route)
        }
    }

    @ViewBuilder
    private func destination(_ route: MailRoute) -> some View {
        switch route {
        case .list:
            threadList
        case .thread(let id, let mailboxId):
            ThreadDetailView(threadId: id, mailboxId: mailboxId)
        case .reminders:
            RemindersView()
        case .labels:
            LabelsView()
        case .folders:
            FoldersView()
        case .contacts:
            ContactsView(onSearchMail: { query in
                mail.pendingSearch = query
                if isCompact { stackPath = [.list] } else { detailPath.removeAll() }
            })
        }
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
