import Foundation
import OSLog
import SwiftUI

/// What the thread list is showing. A mailbox scope pairs with a `MailView`
/// (inbox/sent/…); a folder scope is user-level filing and has no views.
enum MailScope: Hashable, Codable {
    case mailbox(String)
    case folder(String)

    var mailboxId: String? { if case .mailbox(let id) = self { id } else { nil } }
    var folderId: String? { if case .folder(let id) = self { id } else { nil } }
    var isAllMail: Bool { mailboxId == APIClient.allMailboxes }
}

enum ConnectionState: Equatable {
    case offline
    case connecting
    case live
}

/// Everything the mail UI reads from. One store per signed-in session; it owns
/// the catalogue (mailboxes, folders, labels), the current list, and the SSE
/// subscription that keeps them honest.
@Observable
final class MailStore {
    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "store")

    let client: APIClient
    private unowned let app: AppModel

    // Catalogue
    private(set) var mailboxes: [MailboxSummary] = []
    private(set) var folders: [Folder] = []
    private(set) var labelsByMailbox: [String: [MailLabel]] = [:]
    private(set) var reminders: [Reminder] = []
    private(set) var contacts: [Contact] = []
    private(set) var notifyConfigs: [String: NotifyConfig] = [:]

    // Selection
    var scope: MailScope = .mailbox(APIClient.allMailboxes) {
        didSet { if scope != oldValue { scopeChanged() } }
    }
    var view: MailView = .inbox {
        didSet { if view != oldValue { Task { await loadList(reset: true) } } }
    }
    var unreadOnly = false {
        didSet { if unreadOnly != oldValue { Task { await loadList(reset: true) } } }
    }
    /// Mail's inbox category tabs. Filtering happens over the loaded page, so
    /// `loadUntilFilled` tops the list up when a narrow bucket looks empty.
    var category: MailCategory = .all {
        didSet {
            if category != oldValue {
                selectedThreadIds.removeAll()
                Task { await loadUntilFilled() }
            }
        }
    }
    var selectedThreadIds: Set<String> = []
    /// A query handed over by Shortcuts or Siri; the list picks it up and opens
    /// its search field with it.
    var pendingSearch: String?

    // List
    private(set) var threads: [MailThread] = []
    private(set) var drafts: [Draft] = []
    private(set) var threadLabels: [String: [MessageLabelRef]] = [:]
    private(set) var counts: FolderCountsResponse = FolderCountsResponse(counts: [:])
    private(set) var nextCursor: String?
    private(set) var isLoadingList = false
    private(set) var isLoadingMore = false
    private(set) var listError: String?
    /// Bumped whenever a load completes, so views can animate on real changes.
    private(set) var listGeneration = 0
    /// When the list last came back from the server — Mail's "Updated Just Now".
    private(set) var lastUpdated: Date?

    // Realtime
    private(set) var connection: ConnectionState = .offline
    /// Tracks whether the scene is foregrounded, so background events can raise
    /// a notification instead of a silent refresh.
    var isSceneActive = true

    private var streamTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var listTask: Task<Void, Never>?

    init(client: APIClient, app: AppModel) {
        self.client = client
        self.app = app
    }

    // ─── Derived ────────────────────────────────────────────────────────────

    var currentMailbox: MailboxSummary? {
        guard let id = scope.mailboxId, id != APIClient.allMailboxes else { return nil }
        return mailboxes.first { $0.id == id }
    }

    var currentFolder: Folder? {
        guard let id = scope.folderId else { return nil }
        return folders.first { $0.id == id }
    }

    /// Mailboxes the reader may send from.
    var writableMailboxes: [MailboxSummary] {
        mailboxes.filter { $0.canWrite && $0.type != .service }
    }

    var totalUnread: Int {
        mailboxes.filter { !$0.excludeFromAll }.reduce(0) { $0 + $1.unread }
    }

    var pendingReminderCount: Int {
        reminders.filter { $0.status == .fired }.count
    }

    var title: String {
        if let folder = currentFolder { return folder.name }
        if scope.isAllMail { return view == .inbox ? "All mail" : view.title }
        return view.title
    }

    var subtitle: String? {
        if scope.folderId != nil { return "Filed threads" }
        if scope.isAllMail { return "Every mailbox" }
        return currentMailbox?.address
    }

    /// Labels belong to a mailbox, so they only apply inside a single-mailbox
    /// scope — "All mail" spans mailboxes that don't share a label set.
    var activeLabels: [MailLabel] {
        guard let id = currentMailbox?.id else { return [] }
        return labelsByMailbox[id] ?? []
    }

    func mailbox(id: String) -> MailboxSummary? { mailboxes.first { $0.id == id } }

    func labels(for threadId: String) -> [MessageLabelRef] { threadLabels[threadId] ?? [] }

    /// The rows the list actually shows, after the category tab.
    var visibleThreads: [MailThread] {
        guard category != .all else { return threads }
        return threads.filter { category.contains($0.aiCategory) }
    }

    /// Categories are only meaningful where something is doing the classifying.
    /// Turning AI off doesn't un-classify mail that already arrived, so already
    /// categorised threads keep the tabs available.
    var showsCategories: Bool {
        guard view == .inbox, scope.folderId == nil else { return false }
        if threads.contains(where: { $0.aiCategory != nil }) { return true }
        if scope.isAllMail {
            return mailboxes.contains { $0.aiFeatures && !$0.excludeFromAll }
        }
        return currentMailbox?.aiFeatures ?? false
    }

    /// How many loaded threads sit in each tab, for the tab badges.
    func count(in category: MailCategory) -> Int {
        category == .all ? threads.count : threads.count { category.contains($0.aiCategory) }
    }

    func count(_ view: MailView) -> FolderCount { counts.count(view) }

    /// The views worth offering in the current scope. A mailbox the reader can
    /// only read still shows Drafts (their own) but never a send-only service box.
    var availableViews: [MailView] {
        if scope.folderId != nil { return [] }
        return [.inbox, .marked, .sent, .drafts, .spam, .trash, .all]
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    func start() async {
        await refreshCatalogue()
        // Restore the last place the reader was, when it still exists.
        if let saved = Self.loadScope(), isValid(saved) { scope = saved }
        applyFocusFilter()
        await loadList(reset: true)
        await loadCounts()
        startStream()
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        refreshTask?.cancel()
        listTask?.cancel()
        connection = .offline
    }

    private func isValid(_ scope: MailScope) -> Bool {
        switch scope {
        case .mailbox(let id): id == APIClient.allMailboxes || mailboxes.contains { $0.id == id }
        case .folder(let id): folders.contains { $0.id == id }
        }
    }

    private func scopeChanged() {
        selectedThreadIds.removeAll()
        Self.saveScope(scope)
        if scope.folderId != nil {
            view = .inbox
        }
        Task {
            await loadList(reset: true)
            await loadCounts()
        }
    }

    // ─── Catalogue ──────────────────────────────────────────────────────────

    func refreshCatalogue() async {
        do {
            async let mailboxesTask = client.mailboxes()
            async let foldersTask = client.folders()
            async let remindersTask = client.reminders()
            async let configsTask = client.notifyConfigs()

            let loaded = try await mailboxesTask
            mailboxes = loaded.sorted {
                if $0.type != $1.type { return sortRank($0.type) < sortRank($1.type) }
                return $0.address.localizedCaseInsensitiveCompare($1.address) == .orderedAscending
            }
            folders = try await foldersTask
            reminders = try await remindersTask
            let configs = try await configsTask
            notifyConfigs = Dictionary(uniqueKeysWithValues: configs.map { ($0.mailboxId, $0) })
            BackgroundRefresh.cache(notifyConfigs: configs)
            MailboxSnapshot.save(mailboxes)
            Notifications.shared.setBadge(totalUnread)

            if !isValid(scope), let first = mailboxes.first {
                scope = .mailbox(mailboxes.count > 1 ? APIClient.allMailboxes : first.id)
            }
            await loadLabelsIfNeeded()
        } catch {
            app.handle(error)
        }
    }

    private func sortRank(_ type: MailboxType) -> Int {
        switch type {
        case .personal: 0
        case .group: 1
        case .temp: 2
        case .service: 3
        }
    }

    private func loadLabelsIfNeeded() async {
        guard let id = currentMailbox?.id, labelsByMailbox[id] == nil else { return }
        do {
            labelsByMailbox[id] = try await client.labels(mailboxId: id)
        } catch {
            Self.log.debug("labels failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func reloadLabels(mailboxId: String) async {
        do {
            labelsByMailbox[mailboxId] = try await client.labels(mailboxId: mailboxId)
        } catch {
            app.handle(error)
        }
    }

    func refreshFolders() async {
        do { folders = try await client.folders() } catch { app.handle(error) }
    }

    func refreshReminders() async {
        do { reminders = try await client.reminders() } catch { app.handle(error) }
    }

    /// Force the next `loadContactsIfNeeded` to hit the server.
    func invalidateContacts() { contacts = [] }

    func loadContactsIfNeeded() async {
        guard contacts.isEmpty else { return }
        do { contacts = try await client.contacts() } catch {
            Self.log.debug("contacts failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // ─── Thread list ────────────────────────────────────────────────────────

    func loadList(reset: Bool) async {
        listTask?.cancel()
        let task = Task { await performLoad(reset: reset) }
        listTask = task
        await task.value
    }

    private func performLoad(reset: Bool) async {
        if reset {
            isLoadingList = true
            listError = nil
        } else {
            guard nextCursor != nil, !isLoadingMore else { return }
            isLoadingMore = true
        }
        defer {
            isLoadingList = false
            isLoadingMore = false
        }

        do {
            if view == .drafts, scope.folderId == nil {
                let response = try await client.drafts(
                    mailboxId: scope.mailboxId ?? APIClient.allMailboxes,
                    cursor: reset ? nil : nextCursor
                )
                guard !Task.isCancelled else { return }
                drafts = reset ? response.drafts : drafts + response.drafts
                threads = []
                nextCursor = response.nextCursor
            } else {
                let response: ThreadListResponse
                if let folderId = scope.folderId {
                    response = try await client.folderThreads(folderId, cursor: reset ? nil : nextCursor)
                } else {
                    response = try await client.threads(
                        mailboxId: scope.mailboxId ?? APIClient.allMailboxes,
                        view: view,
                        cursor: reset ? nil : nextCursor,
                        unreadOnly: unreadOnly
                    )
                }
                guard !Task.isCancelled else { return }
                threads = reset ? response.threads : threads + response.threads
                drafts = []
                nextCursor = response.nextCursor
                await loadLabels(for: response.threads.map(\.id))
                SpotlightIndex.index(response.threads) { [weak self] id in
                    self?.mailbox(id: id)?.address
                }
            }
            listGeneration += 1
            lastUpdated = .now
        } catch is CancellationError {
            return
        } catch {
            if reset { listError = error.localizedDescription }
            app.handle(error)
        }
    }

    /// Keep pulling pages while the selected category has too little to show.
    /// Bounded so a category with nothing in it can't walk the whole mailbox.
    private func loadUntilFilled(minimum: Int = 12, maxPages: Int = 4) async {
        var pages = 0
        while category != .all, visibleThreads.count < minimum, nextCursor != nil, pages < maxPages {
            await performLoad(reset: false)
            pages += 1
        }
    }

    func loadMoreIfNeeded(currentItem id: String) async {
        guard nextCursor != nil, !isLoadingMore, !isLoadingList else { return }
        let items = view == .drafts ? drafts.map(\.id) : visibleThreads.map(\.id)
        // Prefetch a screenful early rather than at the very last row.
        guard let index = items.firstIndex(of: id), index >= items.count - 8 else { return }
        await performLoad(reset: false)
    }

    private func loadLabels(for ids: [String]) async {
        guard !ids.isEmpty else { return }
        do {
            let fetched = try await client.labels(forThreads: ids)
            threadLabels.merge(fetched) { _, new in new }
        } catch {
            Self.log.debug("thread labels failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func loadCounts() async {
        guard scope.folderId == nil else { return }
        do {
            counts = try await client.folderCounts(mailboxId: scope.mailboxId ?? APIClient.allMailboxes)
        } catch {
            Self.log.debug("counts failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func refreshEverything() async {
        await refreshCatalogue()
        await loadList(reset: true)
        await loadCounts()
    }

    // ─── Thread actions ─────────────────────────────────────────────────────

    func setRead(_ thread: MailThread, read: Bool) async {
        applyLocally(threadId: thread.id) { $0.unreadCount = read ? 0 : max($0.unreadCount, 1) }
        if read { Notifications.shared.dismiss(threadId: thread.id) }
        do {
            try await client.patchThread(thread.id, read: read)
            adjustUnread(mailboxId: thread.mailboxId, by: read ? -1 : 1, onlyIf: thread.isUnread != read)
            await loadCounts()
        } catch {
            applyLocally(threadId: thread.id) { $0.unreadCount = thread.unreadCount }
            app.handle(error)
        }
    }

    func trash(_ thread: MailThread) async {
        await move(thread, label: "Moved to Trash") {
            try await self.client.patchThread(thread.id, trashed: true)
        } undo: {
            try await self.client.patchThread(thread.id, trashed: false)
        }
    }

    func restore(_ thread: MailThread) async {
        await move(thread, label: "Restored") {
            try await self.client.patchThread(thread.id, trashed: false, spam: false)
        } undo: {
            try await self.client.patchThread(thread.id, trashed: true)
        }
    }

    func markSpam(_ thread: MailThread, spam: Bool) async {
        await move(thread, label: spam ? "Reported as spam" : "Not spam") {
            try await self.client.patchThread(thread.id, spam: spam)
        } undo: {
            try await self.client.patchThread(thread.id, spam: !spam)
        }
    }

    func deleteForever(_ thread: MailThread) async {
        removeLocally(threadId: thread.id)
        do {
            try await client.deleteThread(thread.id)
            app.show("Deleted permanently.", kind: .success)
            await loadCounts()
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    /// Optimistic move with a one-tap undo, shared by trash/spam/restore.
    private func move(
        _ thread: MailThread,
        label: String,
        action: @escaping @MainActor @Sendable () async throws -> Void,
        undo: @escaping @MainActor @Sendable () async throws -> Void
    ) async {
        removeLocally(threadId: thread.id)
        do {
            try await action()
            await loadCounts()
            app.show(label, kind: .success) { [weak self] in
                guard let self else { return }
                do {
                    try await undo()
                    await self.loadList(reset: true)
                    await self.loadCounts()
                } catch {
                    self.app.handle(error)
                }
            }
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func markAllRead() async {
        guard let mailboxId = scope.mailboxId else { return }
        do {
            try await client.markAllRead(mailboxId: mailboxId, view: view)
            await Notifications.shared.dismissAll(mailboxId: mailboxId)
            await refreshEverything()
            app.show("Marked everything read.", kind: .success)
        } catch {
            app.handle(error)
        }
    }

    /// Stars a thread by starring its newest message — `marked` is a
    /// message-level flag, and the list rows don't carry message ids.
    func toggleStar(_ thread: MailThread) async {
        do {
            let detail = try await client.thread(thread.id)
            guard let newest = detail.messages.max(by: { $0.date < $1.date }) else { return }
            let starred = !newest.isStarred
            try await client.patchMessage(newest.id, starred: starred)
            app.show(starred ? "Starred." : "Unstarred.", kind: .success)
            if view == .marked { await loadList(reset: true) }
            await loadCounts()
        } catch {
            app.handle(error)
        }
    }

    func file(_ threadIds: [String], into folder: Folder) async {
        for id in threadIds { removeLocally(threadId: id) }
        do {
            try await client.fileThreads(threadIds, into: folder.id)
            await refreshFolders()
            await loadCounts()
            app.show("Moved to \(folder.name).", kind: .success)
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func unfile(_ thread: MailThread, from folder: Folder) async {
        removeLocally(threadId: thread.id)
        do {
            try await client.unfileThread(thread.id, from: folder.id)
            await refreshFolders()
            app.show("Removed from \(folder.name).", kind: .success)
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func toggleLabel(_ label: MailLabel, on thread: MailThread) async {
        let applied = labels(for: thread.id).contains { $0.id == label.id }
        do {
            if applied {
                try await client.removeLabel(label.id, fromThread: thread.id)
                threadLabels[thread.id]?.removeAll { $0.id == label.id }
            } else {
                try await client.applyLabel(label.id, toThread: thread.id)
                threadLabels[thread.id, default: []].append(
                    MessageLabelRef(id: label.id, name: label.name, color: label.color)
                )
            }
        } catch {
            app.handle(error)
        }
    }

    // ─── Bulk selection ─────────────────────────────────────────────────────

    var selectedThreads: [MailThread] {
        visibleThreads.filter { selectedThreadIds.contains($0.id) }
    }

    func toggleSelection(_ id: String) {
        if selectedThreadIds.contains(id) { selectedThreadIds.remove(id) } else { selectedThreadIds.insert(id) }
    }

    func clearSelection() { selectedThreadIds.removeAll() }

    func bulkRead(_ read: Bool) async {
        let targets = selectedThreads
        clearSelection()
        for thread in targets {
            applyLocally(threadId: thread.id) { $0.unreadCount = read ? 0 : max($0.unreadCount, 1) }
            if read { Notifications.shared.dismiss(threadId: thread.id) }
        }
        do {
            for thread in targets { try await client.patchThread(thread.id, read: read) }
            await refreshCatalogue()
            await loadCounts()
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func bulkTrash() async {
        let targets = selectedThreads
        clearSelection()
        for thread in targets { removeLocally(threadId: thread.id) }
        do {
            for thread in targets { try await client.patchThread(thread.id, trashed: true) }
            await loadCounts()
            app.show("Moved \(targets.count) to Trash.", kind: .success) { [weak self] in
                guard let self else { return }
                for thread in targets { _ = try? await self.client.patchThread(thread.id, trashed: false) }
                await self.loadList(reset: true)
                await self.loadCounts()
            }
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func bulkSpam() async {
        let targets = selectedThreads
        clearSelection()
        for thread in targets { removeLocally(threadId: thread.id) }
        do {
            for thread in targets { try await client.patchThread(thread.id, spam: true) }
            await loadCounts()
            app.show("Reported \(targets.count) as spam.", kind: .success)
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    // ─── Drafts ─────────────────────────────────────────────────────────────

    func deleteDraft(_ draft: Draft) async {
        drafts.removeAll { $0.id == draft.id }
        do {
            try await client.deleteDraft(draft.id)
            await loadCounts()
        } catch {
            app.handle(error)
            await loadList(reset: true)
        }
    }

    func cancelSchedule(_ draft: Draft) async {
        do {
            try await client.cancelScheduledDraft(draft.id)
            await loadList(reset: true)
            app.show("Send cancelled — kept as a draft.", kind: .success)
        } catch {
            app.handle(error)
        }
    }

    // ─── Reminders ──────────────────────────────────────────────────────────

    func dismissReminder(_ reminder: Reminder) async {
        reminders.removeAll { $0.id == reminder.id }
        do { try await client.dismissReminder(reminder.id) } catch { app.handle(error) }
    }

    func deleteReminder(_ reminder: Reminder) async {
        reminders.removeAll { $0.id == reminder.id }
        do { try await client.deleteReminder(reminder.id) } catch { app.handle(error) }
    }

    // ─── Local list mutations ───────────────────────────────────────────────

    private func applyLocally(threadId: String, _ mutate: (inout MailThread) -> Void) {
        guard let index = threads.firstIndex(where: { $0.id == threadId }) else { return }
        mutate(&threads[index])
    }

    private func removeLocally(threadId: String) {
        if let thread = threads.first(where: { $0.id == threadId }) {
            SpotlightIndex.remove(threadId: threadId, mailboxId: thread.mailboxId)
        }
        threads.removeAll { $0.id == threadId }
        selectedThreadIds.remove(threadId)
    }

    private func adjustUnread(mailboxId: String, by delta: Int, onlyIf condition: Bool) {
        guard condition, let index = mailboxes.firstIndex(where: { $0.id == mailboxId }) else { return }
        mailboxes[index].unread = max(0, mailboxes[index].unread + delta)
        Notifications.shared.setBadge(totalUnread)
    }

    /// Called by the thread reader when it marks messages seen, so the list and
    /// the sidebar badge track without a round-trip.
    func noteThreadRead(_ threadId: String, mailboxId: String) {
        guard let thread = threads.first(where: { $0.id == threadId }), thread.isUnread else { return }
        applyLocally(threadId: threadId) { $0.unreadCount = 0 }
        adjustUnread(mailboxId: mailboxId, by: -1, onlyIf: true)
        Notifications.shared.dismiss(threadId: threadId)
    }

    // ─── Realtime ───────────────────────────────────────────────────────────

    private func startStream() {
        streamTask?.cancel()
        connection = .connecting
        let stream = EventStream(client: client)
        streamTask = Task { [weak self] in
            for await signal in stream.signals() {
                guard let self else { return }
                switch signal {
                case .connected:
                    self.connection = .live
                case .disconnected:
                    self.connection = .connecting
                case .unauthorized:
                    self.connection = .offline
                    await self.app.signOut()
                    return
                case .event(let event):
                    await self.handle(event)
                }
            }
            self?.connection = .offline
        }
    }

    /// Reconnect after the app returns from the background — iOS tears down
    /// long-lived connections while suspended.
    /// A Focus can turn on while the app is in the background, so the filter is
    /// re-read on the way back in, not just at launch.
    func applyFocusFilter() {
        guard let focused = FocusFilterState.focusedMailboxId else { return }
        let target = MailScope.mailbox(focused)
        guard isValid(target), scope != target else { return }
        scope = target
    }

    func sceneBecameActive() {
        isSceneActive = true
        applyFocusFilter()
        if connection != .live { startStream() }
        scheduleRefresh(after: .zero)
        // Codes expire while the app is away; drop the stale ones so the
        // QuickType bar never offers something that no longer works.
        Task { await CodeVault.prune() }
    }

    func sceneWentBackground() {
        isSceneActive = false
        BackgroundRefresh.schedule()
    }

    private func handle(_ event: HubEvent) async {
        switch event {
        case .ping, .unknown:
            return

        case .newMessage(let mailboxId, _, let threadId):
            await handleNewMail(mailboxId: mailboxId, threadId: threadId)
            scheduleRefresh()

        case .messageSent, .threadUpdated, .mailboxChanged:
            scheduleRefresh()

        case .threadRead(_, let threadId, let read):
            if read { Notifications.shared.dismiss(threadId: threadId) }
            applyLocally(threadId: threadId) { $0.unreadCount = read ? 0 : max($0.unreadCount, 1) }
            scheduleRefresh()

        case .mailboxRead(let mailboxId):
            await Notifications.shared.dismissAll(mailboxId: mailboxId)
            scheduleRefresh()

        case .mailboxExpired(let mailboxId):
            mailboxes.removeAll { $0.id == mailboxId }
            if scope.mailboxId == mailboxId {
                scope = .mailbox(APIClient.allMailboxes)
            }
            app.show("A disposable mailbox expired.", kind: .info)

        case .scheduledSendFailed(_, let draftId, let error):
            Notifications.shared.sendFailed(draftId: draftId, error: error)
            app.show("Scheduled send failed: \(error)", kind: .failure)
            scheduleRefresh()

        case .reminderFired(let reminderId, let mailboxId, let threadId, let subject, let note):
            Notifications.shared.reminderFired(
                reminderId: reminderId, mailboxId: mailboxId,
                threadId: threadId, subject: subject, note: note
            )
            await refreshReminders()
        }
    }

    /// One refresh per burst: delivery fans out several events per message.
    private func scheduleRefresh(after delay: Duration = .milliseconds(600)) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.refreshCatalogue()
            await self.loadList(reset: true)
            await self.loadCounts()
        }
    }

    /// One fetch of the new message serves both jobs: raising an alert when the
    /// app isn't frontmost, and pulling out a verification code for AutoFill.
    private func handleNewMail(mailboxId: String, threadId: String) async {
        let config = notifyConfigs[mailboxId] ?? .defaultOn
        let wantsAlert = !isSceneActive && !config.isOff
            && !FocusFilterState.silences(mailboxId: mailboxId)
        do {
            let detail = try await client.thread(threadId)
            guard let newest = detail.messages.filter(\.isInbound).max(by: { $0.date < $1.date })
            else { return }

            await captureVerificationCode(in: newest)

            guard wantsAlert else { return }
            let level = switch newest.aiPriority ?? .normal {
            case .high: config.high
            case .normal: config.normal
            case .low: config.low
            }
            Notifications.shared.newMail(
                threadId: threadId,
                mailboxId: mailboxId,
                sender: newest.sender.displayName,
                subject: newest.displaySubject,
                preview: newest.aiSummary?.nilIfBlank ?? newest.snippet,
                level: level
            )
        } catch {
            Self.log.debug("new-mail lookup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Pull a one-time code out of an inbound message and offer it to iOS's
    /// AutoFill, so it turns up in the QuickType bar of whatever asked for it.
    /// Everything about this is best-effort: no code, no harm.
    func captureVerificationCode(in message: Message) async {
        guard message.isInbound,
              let code = VerificationCodeDetector.code(
                  subject: message.subject,
                  body: message.bodyText ?? message.snippet
              ),
              let domain = VerificationCodeDetector.domain(forSender: message.fromAddr)
        else { return }

        let found = VerificationCode(
            id: UUID().uuidString,
            code: code,
            domain: domain,
            service: VerificationCodeDetector.serviceName(forDomain: domain, fromName: message.fromName),
            subject: message.displaySubject,
            messageId: message.id,
            mailboxId: message.mailboxId,
            receivedAt: message.date
        )
        guard await CodeVault.add(found) else { return }
        Self.log.debug("captured a verification code for \(domain, privacy: .public)")
        if isSceneActive {
            app.show("Code \(code) from \(found.service) is ready to AutoFill.", kind: .success)
        }
    }

    // ─── Scope persistence ──────────────────────────────────────────────────

    private static let scopeKey = "cfmail.scope"

    private static func saveScope(_ scope: MailScope) {
        guard let data = try? JSONEncoder().encode(scope) else { return }
        UserDefaults.standard.set(data, forKey: scopeKey)
    }

    private static func loadScope() -> MailScope? {
        guard let data = UserDefaults.standard.data(forKey: scopeKey) else { return nil }
        return try? JSONDecoder().decode(MailScope.self, from: data)
    }
}
