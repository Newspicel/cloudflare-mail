import SwiftUI

struct ThreadListView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.mailNavigator) private var navigator
    @Environment(\.horizontalSizeClass) private var sizeClass

    var onCompose: (ComposeContext) -> Void

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
            if mail.showsCategories && !search.isActive && !isSelecting {
                CategoryTabs(selection: $mail.category) { mail.count(in: $0) }
            }
        }
        .navigationTitle(isSelecting ? selectionTitle : mail.title)
        .navigationBarTitleDisplayMode(isSelecting ? .inline : .large)
        .navigationSubtitle(isSelecting || search.isActive ? "" : (mail.subtitle ?? ""))
        .navigationBarBackButtonHidden(isSelecting)
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
            placement: .automatic,
            prompt: "Search"
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
        .onChange(of: mail.scope) { _, _ in endSelecting() }
        .onChange(of: mail.view) { _, _ in endSelecting() }
        .toolbar { toolbarContent }
        .sheet(item: $folderPicker) { request in
            FolderPickerSheet(threadIds: request.threadIds)
                .environment(app)
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
            .environment(app)
            .environment(mail)
        }
        .confirmationDialog(
            "Delete everything in Trash?",
            isPresented: $confirmEmptyTrash,
            titleVisibility: .visible
        ) {
            Button("Delete Permanently", role: .destructive) { Task { await emptyTrash() } }
        } message: {
            Text("This can't be undone.")
        }
        .animation(.snappy, value: mail.listGeneration)
        .animation(.snappy(duration: 0.2), value: isSelecting)
    }

    // ─── Rows ───────────────────────────────────────────────────────────────

    @ViewBuilder
    private var threadRows: some View {
        if mail.isLoadingList && mail.visibleThreads.isEmpty {
            ForEach(0..<8, id: \.self) { _ in ThreadRowPlaceholder() }
        } else if let error = mail.listError, mail.visibleThreads.isEmpty {
            EmptyState(
                symbol: "exclamationmark.triangle",
                title: "Couldn't Load Mail",
                message: error,
                actionTitle: "Try Again"
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
                    isSelected: mail.selectedThreadIds.contains(thread.id),
                    isOpen: sizeClass == .regular && mail.openThreadId == thread.id
                ) {
                    if isSelecting {
                        mail.toggleSelection(thread.id)
                    } else {
                        navigator.showThread(thread.id, thread.mailboxId)
                    }
                }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        Task { await mail.setRead(thread, read: thread.isUnread) }
                    } label: {
                        Label(
                            thread.isUnread ? "Read" : "Unread",
                            systemImage: thread.isUnread ? "envelope.open.fill" : "envelope.badge.fill"
                        )
                    }
                    .tint(.blue)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    trailingSwipe(for: thread)
                }
                .contextMenu { contextMenu(for: thread) }
                .task { await mail.loadMoreIfNeeded(currentItem: thread.id) }
            }
            if mail.isLoadingMore { LoadingFooter() }
        }
    }

    /// Mail's trailing set: Trash nearest the edge (and on a full swipe),
    /// then Flag, then a place to file it. Trash and Spam get their own.
    @ViewBuilder
    private func trailingSwipe(for thread: MailThread) -> some View {
        switch mail.view {
        case .trash:
            Button(role: .destructive) {
                Task { await mail.deleteForever(thread) }
            } label: {
                Label("Delete", systemImage: "trash.fill")
            }
            Button { Task { await mail.restore(thread) } } label: {
                Label("Restore", systemImage: "arrow.uturn.backward.circle.fill")
            }
            .tint(.green)
        case .spam:
            Button(role: .destructive) {
                Task { await mail.trash(thread) }
            } label: {
                Label("Trash", systemImage: "trash.fill")
            }
            Button { Task { await mail.markSpam(thread, spam: false) } } label: {
                Label("Not Spam", systemImage: "hand.thumbsup.fill")
            }
            .tint(.green)
        default:
            Button(role: .destructive) {
                Task { await mail.trash(thread) }
            } label: {
                Label("Trash", systemImage: "trash.fill")
            }
            Button { Task { await mail.toggleStar(thread) } } label: {
                Label("Star", systemImage: "star.fill")
            }
            .tint(.orange)
            Button {
                folderPicker = FolderPickerRequest(threadIds: [thread.id])
            } label: {
                Label("Move", systemImage: "folder.fill")
            }
            .tint(.indigo)
        }
    }

    @ViewBuilder
    private var draftRows: some View {
        if mail.isLoadingList && mail.drafts.isEmpty {
            ForEach(0..<5, id: \.self) { _ in ThreadRowPlaceholder() }
        } else if mail.drafts.isEmpty {
            EmptyState(
                symbol: "doc",
                title: "No Drafts",
                message: "Anything you start writing and leave is kept here.",
                actionTitle: "New Message"
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
                        Label("Delete", systemImage: "trash.fill")
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
            EmptyState(symbol: "exclamationmark.triangle", title: "Search Failed", message: error)
                .listRowSeparator(.hidden)
        } else if search.results.isEmpty && search.hasRun {
            EmptyState(
                symbol: "magnifyingglass",
                title: "No Results",
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
                    navigator.showThread(result.threadId, result.mailboxId)
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
                title: mail.unreadOnly ? "No Unread Mail" : "No Mail",
                message: mail.unreadOnly ? nil : "New mail lands here the moment it's delivered."
            )
        case .spam:
            EmptyState(symbol: "checkmark.shield", title: "No Spam", message: "Nothing was filtered out.")
        case .trash:
            EmptyState(symbol: "trash", title: "Trash Is Empty")
        case .marked:
            EmptyState(symbol: "star", title: "Nothing Starred", message: "Star a message to keep it here.")
        case .sent:
            EmptyState(symbol: "paperplane", title: "Nothing Sent Yet")
        default:
            EmptyState(symbol: "tray.full", title: "No Mail")
        }
    }

    // ─── Toolbar ────────────────────────────────────────────────────────────

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isSelecting {
            selectingToolbar
        } else {
            browsingToolbar
        }
    }

    /// Mail's edit mode: the title counts the selection, Select All sits
    /// where the back button was, and the bottom bar offers Mark / Move / Trash.
    @ToolbarContentBuilder
    private var selectingToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(allSelected ? "Deselect All" : "Select All") {
                if allSelected {
                    mail.clearSelection()
                } else {
                    for thread in mail.visibleThreads { mail.selectedThreadIds.insert(thread.id) }
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { endSelecting() }
                .fontWeight(.semibold)
        }
        ToolbarItem(placement: .bottomBar) {
            Menu("Mark") {
                Button("Mark as Read", systemImage: "envelope.open") { Task { await mail.bulkRead(true) } }
                Button("Mark as Unread", systemImage: "envelope.badge") { Task { await mail.bulkRead(false) } }
                Button("Star", systemImage: "star") { Task { await mail.bulkStar() } }
                Divider()
                if mail.view == .spam {
                    Button("Not Spam", systemImage: "hand.thumbsup") { Task { await mail.bulkSpam(false) } }
                } else {
                    Button("Report Spam", systemImage: "xmark.bin") { Task { await mail.bulkSpam(true) } }
                }
            }
            .disabled(mail.selectedThreadIds.isEmpty)
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            if mail.view == .trash {
                Button("Restore") { Task { await mail.bulkRestore() } }
                    .disabled(mail.selectedThreadIds.isEmpty)
            } else {
                Button("Move") {
                    folderPicker = FolderPickerRequest(threadIds: Array(mail.selectedThreadIds))
                }
                .disabled(mail.selectedThreadIds.isEmpty)
            }
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            if mail.view == .trash {
                Button("Delete", role: .destructive) { Task { await mail.bulkDeleteForever() } }
                    .disabled(mail.selectedThreadIds.isEmpty)
            } else {
                Button("Trash", role: .destructive) { Task { await mail.bulkTrash() } }
                    .disabled(mail.selectedThreadIds.isEmpty)
            }
        }
    }

    @ToolbarContentBuilder
    private var browsingToolbar: some ToolbarContent {
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
                    mail.unreadOnly ? "Show All" : "Show Unread Only",
                    systemImage: mail.unreadOnly
                        ? "line.3.horizontal.decrease.circle.fill"
                        : "line.3.horizontal.decrease.circle"
                )
            }
            .disabled(mail.view == .drafts)
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            statusText
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            Button("New Message", systemImage: "square.and.pencil") {
                onCompose(ComposeContext(kind: .new, mailboxId: defaultComposeMailbox))
            }
            .disabled(mail.writableMailboxes.isEmpty)
        }
    }

    /// Mail's reassurance line in the middle of the bottom bar: when the list
    /// last came back, and what's unread. Re-evaluated each minute so "Just
    /// Now" ages into a time on its own.
    private var statusText: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(spacing: 1) {
                Text(updatedLine(at: context.date))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if mail.unreadOnly {
                    Text("Filtered by: Unread")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                } else if let line = countLine {
                    Text(line)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize()
            .monospacedDigit()
        }
    }

    private var overflowMenu: some View {
        Menu {
            Button("Select Messages", systemImage: "checkmark.circle") {
                startSelecting()
            }
            .disabled(mail.visibleThreads.isEmpty)
            Divider()
            Button("Mark All as Read", systemImage: "envelope.open") {
                Task { await mail.markAllRead() }
            }
            .disabled(mail.scope.folderId != nil || mail.count(mail.view).unread == 0)
            if mail.view == .trash {
                Button("Empty Trash", systemImage: "trash.slash", role: .destructive) {
                    confirmEmptyTrash = true
                }
                .disabled(mail.threads.isEmpty)
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .disabled(mail.view == .drafts)
    }

    @ViewBuilder
    private func contextMenu(for thread: MailThread) -> some View {
        Button {
            Task { await mail.setRead(thread, read: thread.isUnread) }
        } label: {
            Label(thread.isUnread ? "Mark as Read" : "Mark as Unread",
                  systemImage: thread.isUnread ? "envelope.open" : "envelope.badge")
        }
        Button("Star", systemImage: "star") { Task { await mail.toggleStar(thread) } }
        Button("Move to Folder…", systemImage: "folder") {
            folderPicker = FolderPickerRequest(threadIds: [thread.id])
        }
        if !mail.activeLabels.isEmpty {
            Button("Labels…", systemImage: "tag") { labelPicker = thread }
        }
        if let folder = mail.currentFolder {
            Button("Remove from \(folder.name)", systemImage: "folder.badge.minus") {
                Task { await mail.unfile(thread, from: folder) }
            }
        }
        Divider()
        if thread.spam {
            Button("Not Spam", systemImage: "hand.thumbsup") {
                Task { await mail.markSpam(thread, spam: false) }
            }
        } else {
            Button("Report Spam", systemImage: "xmark.bin") {
                Task { await mail.markSpam(thread, spam: true) }
            }
        }
        if thread.trashed {
            Button("Restore", systemImage: "arrow.uturn.backward") {
                Task { await mail.restore(thread) }
            }
            Button("Delete Permanently", systemImage: "trash.fill", role: .destructive) {
                Task { await mail.deleteForever(thread) }
            }
        } else {
            Button("Move to Trash", systemImage: "trash", role: .destructive) {
                Task { await mail.trash(thread) }
            }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private var allSelected: Bool {
        !mail.visibleThreads.isEmpty && mail.selectedThreadIds.count == mail.visibleThreads.count
    }

    private var selectionTitle: String {
        let count = mail.selectedThreadIds.count
        return count == 0 ? "Select Messages" : "\(count) Selected"
    }

    private func startSelecting() {
        mail.clearSelection()
        isSelecting = true
    }

    private func endSelecting() {
        guard isSelecting else { return }
        isSelecting = false
        mail.clearSelection()
    }

    private func updatedLine(at now: Date) -> String {
        switch mail.connection {
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        case .live: break
        }
        if mail.isLoadingList { return "Checking for Mail…" }
        guard let updated = mail.lastUpdated else { return "Updated" }
        return now.timeIntervalSince(updated) < 60
            ? "Updated Just Now"
            : "Updated \(updated.formatted(date: .omitted, time: .shortened))"
    }

    private var countLine: String? {
        if mail.view == .drafts {
            return mail.drafts.isEmpty ? nil : "\(mail.drafts.count) Drafts"
        }
        guard mail.scope.folderId == nil else { return nil }
        let count = mail.count(mail.view)
        if mail.view.badgeCountsUnread {
            return count.unread > 0 ? "\(count.unread) Unread" : nil
        }
        return count.total > 0 ? "\(count.total) Messages" : nil
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
