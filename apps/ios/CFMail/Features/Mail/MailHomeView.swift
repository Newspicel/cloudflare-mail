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

/// Root of the signed-in app, in Mail's shape.
///
/// iPhone: the mailbox list is the root, the message list is pushed on top and
/// is where you land, and a conversation is pushed on top of that. iPad: three
/// columns — mailboxes, list, conversation.
struct MailHomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var intents = IntentRouter.shared

    // iPhone. Starts on the list: the mailbox picker is the root, but it isn't
    // where a reader wants to land.
    @State private var stackPath: [MailRoute] = [.list]
    // iPad. Management screens push in the middle column; the conversation
    // is the third.
    @State private var contentPath: [MailRoute] = []
    @State private var openThread: MailRoute?
    @State private var columns: NavigationSplitViewVisibility = .automatic

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
                .environment(app)
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
            open(threadId: tap.threadId, mailboxId: tap.mailboxId)
        }
        // Keep the store's notion of the open conversation honest for both
        // layouts, so the list highlight and the reader's arrows agree.
        .onChange(of: stackPath) { _, path in
            guard isCompact else { return }
            mail.openThreadId = path.lazy.compactMap(Self.threadId).last
        }
        .onChange(of: openThread) { _, route in
            guard !isCompact else { return }
            mail.openThreadId = route.flatMap(Self.threadId)
        }
        .onChange(of: isCompact) { _, compact in
            // Rotating an iPad past the size-class boundary swaps layouts;
            // carry the open conversation across rather than losing it.
            if compact {
                stackPath = [.list] + (openThread.map { [$0] } ?? [])
            } else {
                openThread = stackPath.last.flatMap { Self.threadId($0) == nil ? nil : $0 }
                contentPath = stackPath.filter { $0 != .list && Self.threadId($0) == nil }
            }
        }
        .environment(\.composeAction, ComposeAction { compose = $0 })
        .environment(\.mailNavigator, navigator)
    }

    private static func threadId(_ route: MailRoute) -> String? {
        if case .thread(let id, _) = route { id } else { nil }
    }

    // ─── iPhone ─────────────────────────────────────────────────────────────

    private var compactLayout: some View {
        NavigationStack(path: $stackPath) {
            sidebar
                .navigationDestination(for: MailRoute.self, destination: destination)
        }
    }

    // ─── iPad ───────────────────────────────────────────────────────────────

    private var wideLayout: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } content: {
            NavigationStack(path: $contentPath) {
                threadList
                    .navigationDestination(for: MailRoute.self, destination: destination)
            }
        } detail: {
            if case .thread(let id, let mailboxId) = openThread {
                NavigationStack {
                    ThreadDetailView(threadId: id, mailboxId: mailboxId)
                }
            } else {
                ContentUnavailableView("No Conversation Selected", systemImage: "envelope")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    // ─── Pieces ─────────────────────────────────────────────────────────────

    private var sidebar: some View {
        SidebarView(
            onOpenSettings: { showingSettings = true },
            onNewTempMailbox: { showingTempMailbox = true },
            onSelect: select
        )
    }

    private var threadList: some View {
        ThreadListView(onCompose: { compose = $0 })
    }

    private var navigator: MailNavigator {
        MailNavigator(
            open: push,
            showThread: { threadId, mailboxId in
                showThread(.thread(id: threadId, mailboxId: mailboxId))
            },
            closeThread: closeThread
        )
    }

    /// Open a list, whether or not it's the one already showing.
    private func select(_ scope: MailScope, _ view: MailView) {
        mail.select(scope: scope, view: view)
        if isCompact {
            stackPath = [.list]
        } else {
            contentPath.removeAll()
            openThread = nil
        }
    }

    private func perform(_ action: IntentRouter.Action) {
        switch action {
        case .openMailbox(let id):
            select(.mailbox(id), .inbox)
        case .search(let query):
            mail.pendingSearch = query
            select(mail.scope, mail.view)
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

    /// A conversation reached from outside the list (notification, Spotlight,
    /// Handoff): land in its mailbox with it open.
    private func open(threadId: String, mailboxId: String) {
        mail.select(scope: .mailbox(mailboxId), view: .inbox)
        let route = MailRoute.thread(id: threadId, mailboxId: mailboxId)
        if isCompact {
            stackPath = [.list, route]
        } else {
            contentPath.removeAll()
            openThread = route
        }
    }

    private func showThread(_ route: MailRoute) {
        if isCompact {
            if stackPath.isEmpty { stackPath = [.list] }
            if stackPath.last.flatMap(Self.threadId) != nil {
                stackPath[stackPath.count - 1] = route
            } else {
                stackPath.append(route)
            }
        } else {
            openThread = route
        }
    }

    private func closeThread() {
        if isCompact {
            if stackPath.last.flatMap(Self.threadId) != nil { stackPath.removeLast() }
        } else {
            openThread = nil
        }
    }

    private func push(_ route: MailRoute) {
        if case .thread = route {
            showThread(route)
            return
        }
        if isCompact {
            if stackPath.isEmpty { stackPath = [.list] }
            stackPath.append(route)
        } else {
            contentPath.append(route)
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
                select(mail.scope, mail.view)
            })
        }
    }
}
