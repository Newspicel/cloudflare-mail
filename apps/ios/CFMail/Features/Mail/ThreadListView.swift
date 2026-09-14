import SwiftUI

struct ThreadListView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    var onCompose: (ComposeContext) -> Void
    var onOpen: (MailRoute) -> Void

    @State private var search = SearchModel()
    @State private var searchText = ""
    @State private var isSearchPresented = false
    @State private var showingFilters = false
    @State private var isSelecting = false
    @State private var folderPicker: FolderPickerRequest?
    @State private var labelPicker: MailThread?
    @State private var confirmEmptyTrash = false

    var body: some View {
        @Bindable var mail = mail

        List {
            if search.isActive {
                searchResults
            } else if mail.view == .drafts {
                draftRows
            } else {
                threadRows
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("mail.list")
        .safeAreaInset(edge: .top, spacing: 0) {
            if mail.showsCategories && !search.isActive {
                CategoryTabs(selection: $mail.category) { mail.count(in: $0) }
            }
        }
        .navigationTitle(mail.title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationSubtitle(subtitle)
        .refreshable {
            if search.isActive {
                search.run(mail.client, debounce: false)
            } else {
                await mail.refreshEverything()
            }
        }
        .searchable(
            text: $searchText,
            isPresented: $isSearchPresented,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search mail"
        )
        .onChange(of: searchText) { _, value in
            search.text = value
            search.run(mail.client)
        }
        .onChange(of: mail.pendingSearch) { _, query in
            guard let query else { return }
            mail.pendingSearch = nil
            searchText = query
            isSearchPresented = true
            search.text = query
            search.run(mail.client, debounce: false)
        }
        .onChange(of: isSearchPresented) { _, presented in
            if !presented {
                searchText = ""
                search.reset()
            }
        }
        .toolbar { toolbarContent }
        .safeAreaInset(edge: .bottom) {
            if isSelecting && !mail.selectedThreadIds.isEmpty { selectionBar }
        }
        .sheet(item: $folderPicker) { request in
            FolderPickerSheet(threadIds: request.threadIds)
                .environment(mail)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $labelPicker) { thread in
            LabelPickerSheet(thread: thread)
                .environment(app)
                .environment(mail)
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $showingFilters) {
            SearchFiltersSheet(search: search) {
                search.run(mail.client, debounce: false)
            }
            .environment(mail)
        }
        .confirmationDialog(
            "Delete everything in Trash?",
            isPresented: $confirmEmptyTrash,
            titleVisibility: .visible
        ) {
            Button("Delete permanently", role: .destructive) { Task { await emptyTrash() } }
        } message: {
            Text("This can't be undone.")
        }
        .animation(.snappy, value: mail.listGeneration)
    }

    // ─── Rows ───────────────────────────────────────────────────────────────

    @ViewBuilder
    private var threadRows: some View {
        if mail.isLoadingList && mail.visibleThreads.isEmpty {
            ForEach(0..<8, id: \.self) { _ in ThreadRowPlaceholder() }
        } else if let error = mail.listError, mail.visibleThreads.isEmpty {
            EmptyState(
                symbol: "exclamationmark.triangle",
                title: "Couldn't load mail",
                message: error,
                actionTitle: "Try again"
            ) {
                Task { await mail.loadList(reset: true) }
            }
            .listRowSeparator(.hidden)
        } else if mail.visibleThreads.isEmpty {
            emptyForView
                .listRowSeparator(.hidden)
        } else {
            ForEach(mail.visibleThreads) { thread in
                ThreadRow(
                    thread: thread,
                    mailbox: mail.mailbox(id: thread.mailboxId),
                    labels: mail.labels(for: thread.id),
                    showsMailbox: mail.scope.isAllMail || mail.scope.folderId != nil,
                    showsAiSummary: app.prefs.showsAiSummaries,
                    isCompact: app.prefs.isCompact,
                    isSelecting: isSelecting,
                    isSelected: mail.selectedThreadIds.contains(thread.id)
                ) {
                    if isSelecting {
                        mail.toggleSelection(thread.id)
                    } else {
                        onOpen(.thread(id: thread.id, mailboxId: thread.mailboxId))
                    }
                }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        Task { await mail.setRead(thread, read: thread.isUnread) }
                    } label: {
                        Label(
                            thread.isUnread ? "Read" : "Unread",
                            systemImage: thread.isUnread ? "envelope.open" : "envelope.badge"
                        )
                    }
                    .tint(.accentColor)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    if mail.view == .trash {
                        Button(role: .destructive) {
                            Task { await mail.deleteForever(thread) }
                        } label: {
                            Label("Delete", systemImage: "trash.fill")
                        }
                        Button { Task { await mail.restore(thread) } } label: {
                            Label("Restore", systemImage: "arrow.uturn.backward")
                        }
                        .tint(.green)
                    } else {
                        Button(role: .destructive) {
                            Task { await mail.trash(thread) }
                        } label: {
                            Label("Trash", systemImage: "trash")
                        }
                        Button {
                            folderPicker = FolderPickerRequest(threadIds: [thread.id])
                        } label: {
                            Label("File", systemImage: "folder")
                        }
                        .tint(.indigo)
                    }
                }
                .contextMenu { contextMenu(for: thread) }
                .task { await mail.loadMoreIfNeeded(currentItem: thread.id) }
            }
            if mail.isLoadingMore { LoadingFooter() }
        }
    }

    @ViewBuilder
    private var draftRows: some View {
        if mail.isLoadingList && mail.drafts.isEmpty {
            ForEach(0..<5, id: \.self) { _ in ThreadRowPlaceholder() }
        } else if mail.drafts.isEmpty {
            EmptyState(
                symbol: "doc.text",
                title: "No drafts",
                message: "Anything you start writing and leave is kept here.",
                actionTitle: "New message"
            ) {
                onCompose(ComposeContext(kind: .new, mailboxId: defaultComposeMailbox))
            }
            .listRowSeparator(.hidden)
        } else {
            ForEach(mail.drafts) { draft in
                DraftRow(draft: draft, mailbox: mail.mailbox(id: draft.mailboxId)) {
                    onCompose(ComposeContext(kind: .draft(draft), mailboxId: draft.mailboxId))
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        Task { await mail.deleteDraft(draft) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    if draft.scheduledFor != nil {
                        Button { Task { await mail.cancelSchedule(draft) } } label: {
                            Label("Unschedule", systemImage: "clock.badge.xmark")
                        }
                        .tint(.orange)
                    }
                }
                .task { await mail.loadMoreIfNeeded(currentItem: draft.id) }
            }
            if mail.isLoadingMore { LoadingFooter() }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        if search.isLoading && search.results.isEmpty {
            ForEach(0..<6, id: \.self) { _ in ThreadRowPlaceholder() }
        } else if let error = search.error {
            EmptyState(symbol: "exclamationmark.triangle", title: "Search failed", message: error)
                .listRowSeparator(.hidden)
        } else if search.results.isEmpty && search.hasRun {
            EmptyState(
                symbol: "magnifyingglass",
                title: "No matches",
                message: "Try fewer words, or widen the filters."
            )
            .listRowSeparator(.hidden)
        } else {
            if search.query.hasFilters {
                Section {
                    ActiveFiltersRow(query: search.query) {
                        showingFilters = true
                    }
                }
            }
            ForEach(search.results) { result in
                SearchResultRow(result: result) {
                    onOpen(.thread(id: result.threadId, mailboxId: result.mailboxId))
                }
                .task {
                    if result.id == search.results.last?.id {
                        await search.loadMore(mail.client)
                    }
                }
            }
            if search.isLoadingMore { LoadingFooter() }
        }
    }

    @ViewBuilder
    private var emptyForView: some View {
        switch mail.view {
        case .inbox:
            EmptyState(
                symbol: mail.unreadOnly ? "envelope.open" : "tray",
                title: mail.unreadOnly ? "Nothing unread" : "Inbox zero",
                message: mail.unreadOnly ? nil : "New mail lands here the moment it's delivered."
            )
        case .spam:
            EmptyState(symbol: "checkmark.shield", title: "No spam", message: "Nothing was filtered out.")
        case .trash:
            EmptyState(symbol: "trash", title: "Trash is empty")
        case .marked:
            EmptyState(symbol: "star", title: "Nothing starred", message: "Star a message to keep it here.")
        case .sent:
            EmptyState(symbol: "paperplane", title: "Nothing sent yet")
        default:
            EmptyState(symbol: "archivebox", title: "Nothing here")
        }
    }

    // ─── Toolbar ────────────────────────────────────────────────────────────

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if !search.isActive {
                viewMenu
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if search.isActive {
                Button("Filters", systemImage: "line.3.horizontal.decrease.circle") {
                    showingFilters = true
                }
            } else {
                overflowMenu
            }
        }
        ToolbarItem(placement: .bottomBar) {
            Button {
                mail.unreadOnly.toggle()
            } label: {
                Label(
                    mail.unreadOnly ? "Show all" : "Show unread only",
                    systemImage: mail.unreadOnly
                        ? "line.3.horizontal.decrease.circle.fill"
                        : "line.3.horizontal.decrease.circle"
                )
            }
            .disabled(mail.view == .drafts)
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            VStack(spacing: 1) {
                Text(updatedLine)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if mail.unreadOnly {
                    Text("Filtered by: Unread")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .fixedSize()
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            Button("New message", systemImage: "square.and.pencil") {
                onCompose(ComposeContext(kind: .new, mailboxId: defaultComposeMailbox))
            }
            .disabled(mail.writableMailboxes.isEmpty)
        }
    }

    private var viewMenu: some View {
        Menu {
            Picker("View", selection: Binding(get: { mail.view }, set: { mail.view = $0 })) {
                ForEach(mail.availableViews) { view in
                    Label(view.title, systemImage: view.symbol).tag(view)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label(mail.view.title, systemImage: mail.view.symbol)
        }
        .disabled(mail.scope.folderId != nil)
    }

    private var overflowMenu: some View {
        Menu {
            Button {
                isSelecting.toggle()
                if !isSelecting { mail.clearSelection() }
            } label: {
                Label(isSelecting ? "Done selecting" : "Select…", systemImage: "checkmark.circle")
            }
            Divider()
            Button("Mark all read", systemImage: "envelope.open") {
                Task { await mail.markAllRead() }
            }
            .disabled(mail.scope.folderId != nil)
            if mail.view == .trash {
                Button("Empty Trash", systemImage: "trash.slash", role: .destructive) {
                    confirmEmptyTrash = true
                }
                .disabled(mail.threads.isEmpty)
            }
            Divider()
            Button("Reminders", systemImage: "bell") { onOpen(.reminders) }
            Button("Labels", systemImage: "tag") { onOpen(.labels) }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }

    @ViewBuilder
    private func contextMenu(for thread: MailThread) -> some View {
        Button {
            Task { await mail.setRead(thread, read: thread.isUnread) }
        } label: {
            Label(thread.isUnread ? "Mark read" : "Mark unread",
                  systemImage: thread.isUnread ? "envelope.open" : "envelope.badge")
        }
        Button("Star", systemImage: "star") { Task { await mail.toggleStar(thread) } }
        if !mail.activeLabels.isEmpty {
            Button("Labels…", systemImage: "tag") { labelPicker = thread }
        }
        Button("File…", systemImage: "folder") {
            folderPicker = FolderPickerRequest(threadIds: [thread.id])
        }
        if let folder = mail.currentFolder {
            Button("Remove from \(folder.name)", systemImage: "folder.badge.minus") {
                Task { await mail.unfile(thread, from: folder) }
            }
        }
        Divider()
        if thread.spam {
            Button("Not spam", systemImage: "hand.thumbsup") {
                Task { await mail.markSpam(thread, spam: false) }
            }
        } else {
            Button("Report spam", systemImage: "exclamationmark.octagon") {
                Task { await mail.markSpam(thread, spam: true) }
            }
        }
        if thread.trashed {
            Button("Restore", systemImage: "arrow.uturn.backward") {
                Task { await mail.restore(thread) }
            }
            Button("Delete permanently", systemImage: "trash.fill", role: .destructive) {
                Task { await mail.deleteForever(thread) }
            }
        } else {
            Button("Move to Trash", systemImage: "trash", role: .destructive) {
                Task { await mail.trash(thread) }
            }
        }
    }

    private var selectionBar: some View {
        HStack(spacing: 16) {
            Text("\(mail.selectedThreadIds.count) selected")
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
            Spacer()
            Button("Read", systemImage: "envelope.open") { Task { await mail.bulkRead(true) } }
            Button("File", systemImage: "folder") {
                folderPicker = FolderPickerRequest(threadIds: Array(mail.selectedThreadIds))
            }
            Button("Spam", systemImage: "exclamationmark.octagon") { Task { await mail.bulkSpam() } }
            Button("Trash", systemImage: "trash", role: .destructive) { Task { await mail.bulkTrash() } }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// Scope plus how much is in it — the list's own header has no room.
    private var subtitle: String {
        guard let scope = mail.subtitle else { return statusLine }
        return search.isActive ? scope : "\(scope) · \(statusLine)"
    }

    /// Mail's reassurance line: when the list last came back from the server,
    /// or what it's doing right now.
    private var updatedLine: String {
        switch mail.connection {
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        case .live: break
        }
        if mail.isLoadingList { return "Checking for Mail…" }
        guard let updated = mail.lastUpdated else { return "Updated" }
        return Date.now.timeIntervalSince(updated) < 60
            ? "Updated Just Now"
            : "Updated \(updated.formatted(date: .omitted, time: .shortened))"
    }

    private var statusLine: String {
        if mail.view == .drafts {
            return mail.drafts.isEmpty ? "No drafts" : "\(mail.drafts.count) drafts"
        }
        let count = mail.count(mail.view)
        if mail.view.badgeCountsUnread, count.unread > 0 {
            return "\(count.unread) unread · \(count.total)"
        }
        return count.total == 1 ? "1 conversation" : "\(count.total) conversations"
    }

    private var defaultComposeMailbox: String? {
        mail.currentMailbox?.id ?? mail.writableMailboxes.first?.id
    }

    private func emptyTrash() async {
        let targets = mail.threads
        for thread in targets {
            await mail.deleteForever(thread)
        }
    }
}

/// Wrapper so a folder pick can be presented for one thread or a selection.
struct FolderPickerRequest: Identifiable {
    let id = UUID()
    var threadIds: [String]
}

/// Skeleton row shown while the first page loads.
struct ThreadRowPlaceholder: View {
    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(.quaternary).frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 7) {
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 140, height: 11)
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(height: 11)
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 220, height: 10)
            }
        }
        .padding(.vertical, 6)
        .redacted(reason: .placeholder)
        .listRowSeparator(.hidden)
        .allowsHitTesting(false)
    }
}
