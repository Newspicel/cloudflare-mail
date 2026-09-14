import SwiftUI

struct ThreadDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.composeAction) private var composeAction
    @Environment(\.mailNavigator) private var navigator

    let threadId: String
    let mailboxId: String

    @State private var model: ThreadDetailModel?
    @State private var showingRemind = false
    @State private var showingLabels = false
    @State private var folderPicker: FolderPickerRequest?

    var body: some View {
        Group {
            if let model, model.threadId == threadId {
                content(model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.systemBackground))
        // Mail keeps the bar clear of the subject — it's the first line of the
        // page, and the arrows to step through the list are what belong up here.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        // Stepping to a neighbour changes `threadId` in place; a fresh model
        // loads the new conversation without re-pushing the screen.
        .task(id: threadId) {
            let created = ThreadDetailModel(
                threadId: threadId, mailboxId: mailboxId,
                client: mail.client, app: app, mail: mail
            )
            model = created
            await created.load(markRead: app.prefs.marksReadOnOpen)
        }
        .sheet(isPresented: $showingRemind) {
            RemindSheet(threadId: threadId, mailboxId: mailboxId, messageId: model?.newest?.id)
                .environment(app)
                .environment(mail)
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $showingLabels) {
            if let thread = model?.thread {
                LabelPickerSheet(thread: thread)
                    .environment(app)
                    .environment(mail)
                    .presentationDetents([.medium])
            }
        }
        .sheet(item: $folderPicker) { request in
            FolderPickerSheet(threadIds: request.threadIds)
                .environment(app)
                .environment(mail)
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private func content(_ model: ThreadDetailModel) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                headerBlock(model)

                if model.hasAI {
                    aiBlock(model)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                }

                ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                    if index > 0 { Divider() }
                    MessageCard(
                        model: model,
                        message: message,
                        isExpanded: model.expanded.contains(message.id),
                        onToggle: { Task { await model.toggle(message) } },
                        onReply: { kind, all in reply(to: message, kind: kind, replyAll: all) }
                    )
                    .id(message.id)
                }

                if model.isLoading && model.messages.isEmpty {
                    ProgressView().padding(.top, 40)
                }
                if let error = model.error, model.messages.isEmpty {
                    EmptyState(
                        symbol: "exclamationmark.triangle",
                        title: "Couldn't Open This Conversation",
                        message: error,
                        actionTitle: "Try Again"
                    ) {
                        Task { await model.reload() }
                    }
                    .padding(.top, 40)
                }

                if !model.smartReplies.isEmpty {
                    smartReplyBlock(model)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                }
            }
        }
        .refreshable { await model.reload() }
        .userActivity(ThreadActivity.type, isActive: !model.messages.isEmpty) { activity in
            let built = ThreadActivity.make(
                threadId: threadId, mailboxId: mailboxId,
                subject: model.subject, baseURL: mail.client.baseURL
            )
            activity.title = built.title
            activity.userInfo = built.userInfo
            activity.requiredUserInfoKeys = built.requiredUserInfoKeys
            activity.isEligibleForHandoff = true
            activity.webpageURL = built.webpageURL
        }
    }

    // ─── Header ─────────────────────────────────────────────────────────────

    private func headerBlock(_ model: ThreadDetailModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.subject)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            let labels = mail.labels(for: threadId)
            let showsMailbox = model.mailbox != nil && (mail.scope.isAllMail || mail.scope.folderId != nil)
            if model.messages.count > 1 || showsMailbox || !labels.isEmpty {
                HStack(spacing: 6) {
                    if showsMailbox, let mailbox = model.mailbox {
                        Text(mailbox.address)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if model.messages.count > 1 {
                        Text("\(model.messages.count) messages")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(labels) { label in
                        ColorChip(text: label.name, hex: label.color)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    // ─── AI ─────────────────────────────────────────────────────────────────

    @ViewBuilder
    private func aiBlock(_ model: ThreadDetailModel) -> some View {
        if let bullets = model.summaryBullets, !bullets.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Label("Summary", systemImage: "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.purple)
                ForEach(Array(bullets.enumerated()), id: \.offset) { _, bullet in
                    HStack(alignment: .top, spacing: 7) {
                        Text("•").foregroundStyle(.secondary)
                        Text(bullet).font(.subheadline)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.purple.opacity(0.09), in: .rect(cornerRadius: 14))
        } else if model.messages.count > 2 {
            Button {
                Task { await model.summarize() }
            } label: {
                HStack {
                    if model.isSummarizing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "sparkles")
                    }
                    Text(model.isSummarizing ? "Summarizing…" : "Summarize this conversation")
                    Spacer()
                }
                .font(.subheadline)
                .padding(12)
                .background(.purple.opacity(0.09), in: .rect(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .disabled(model.isSummarizing)
        }
    }

    private func smartReplyBlock(_ model: ThreadDetailModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Suggested Replies", systemImage: "sparkles")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.purple)
            ForEach(Array(model.smartReplies.enumerated()), id: \.offset) { _, suggestion in
                Button {
                    guard let target = model.latestInbound ?? model.newest else { return }
                    composeAction(
                        ComposeContext(
                            kind: .reply(message: target, replyAll: false),
                            mailboxId: mailboxId,
                            initialBody: suggestion
                        )
                    )
                } label: {
                    Text(suggestion)
                        .font(.subheadline)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(11)
                        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 4)
    }

    // ─── Chrome ─────────────────────────────────────────────────────────────

    /// Mail's message chrome: previous/next arrows up top; Trash, Move, then
    /// the reply menu and Compose along the bottom.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        let neighbours = mail.neighbours(of: threadId)
        if neighbours.previous != nil || neighbours.next != nil {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Previous", systemImage: "chevron.up") {
                    if let previous = neighbours.previous {
                        navigator.showThread(previous.id, previous.mailboxId)
                    }
                }
                .disabled(neighbours.previous == nil)
                Button("Next", systemImage: "chevron.down") {
                    if let next = neighbours.next {
                        navigator.showThread(next.id, next.mailboxId)
                    }
                }
                .disabled(neighbours.next == nil)
            }
        }

        ToolbarItem(placement: .bottomBar) {
            Button("Move to Trash", systemImage: "trash") {
                guard let thread = model?.thread else { return }
                Task {
                    await mail.trash(thread)
                    navigator.closeThread()
                }
            }
            .disabled(model?.thread == nil)
        }
        ToolbarItem(placement: .bottomBar) {
            Button("Move", systemImage: "folder") {
                folderPicker = FolderPickerRequest(threadIds: [threadId])
            }
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        ToolbarItem(placement: .bottomBar) {
            actionsMenu
        }
        if model?.canWrite == true {
            ToolbarItem(placement: .bottomBar) {
                Button("New Message", systemImage: "square.and.pencil") {
                    composeAction(ComposeContext(kind: .new, mailboxId: mailboxId))
                }
            }
        }
    }

    /// Mail folds every message action into the reply button's menu; the
    /// button itself replies. A read-only mailbox keeps the menu, minus the
    /// parts that would send.
    @ViewBuilder
    private var actionsMenu: some View {
        let canWrite = model?.canWrite == true
        let target = model.flatMap { $0.latestInbound ?? $0.newest }
        if canWrite, let target {
            Menu {
                menuItems(canWrite: true, target: target)
            } label: {
                Label("Reply", systemImage: "arrowshape.turn.up.left")
            } primaryAction: {
                reply(to: target, kind: .reply, replyAll: app.prefs.replyAllDefault ?? false)
            }
            .disabled(model?.messages.isEmpty ?? true)
        } else {
            Menu {
                menuItems(canWrite: false, target: nil)
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .disabled(model?.messages.isEmpty ?? true)
        }
    }

    @ViewBuilder
    private func menuItems(canWrite: Bool, target: Message?) -> some View {
        if canWrite, let target {
            Button("Reply", systemImage: "arrowshape.turn.up.left") {
                reply(to: target, kind: .reply, replyAll: false)
            }
            Button("Reply All", systemImage: "arrowshape.turn.up.left.2") {
                reply(to: target, kind: .reply, replyAll: true)
            }
            Button("Forward", systemImage: "arrowshape.turn.up.right") {
                reply(to: target, kind: .forward, replyAll: false)
            }
            Divider()
        }
        if let thread = model?.thread {
            Button("Star", systemImage: "star") {
                Task { await mail.toggleStar(thread) }
            }
        }
        Button("Mark as Unread", systemImage: "envelope.badge") {
            Task {
                await model?.markUnread()
                navigator.closeThread()
            }
        }
        Button("Remind Me…", systemImage: "bell") { showingRemind = true }
        if !mail.activeLabels.isEmpty {
            Button("Labels…", systemImage: "tag") { showingLabels = true }
        }
        if model?.hasAI == true {
            Divider()
            Button("Summarize", systemImage: "sparkles") {
                Task { await model?.summarize() }
            }
            if canWrite {
                Button("Suggest Replies", systemImage: "text.bubble") {
                    Task { await model?.draftReplies() }
                }
            }
        }
        Divider()
        if let thread = model?.thread {
            if thread.spam {
                Button("Not Spam", systemImage: "hand.thumbsup") {
                    Task {
                        await mail.markSpam(thread, spam: false)
                        navigator.closeThread()
                    }
                }
            } else {
                Button("Report Spam", systemImage: "xmark.bin") {
                    Task {
                        await mail.markSpam(thread, spam: true)
                        navigator.closeThread()
                    }
                }
            }
        }
        if let web = ThreadActivity.webURL(
            threadId: threadId, mailboxId: mailboxId, baseURL: mail.client.baseURL
        ) {
            ShareLink(item: web) {
                Label("Share Link", systemImage: "square.and.arrow.up")
            }
        }
    }

    private func reply(to message: Message, kind: QuoteKind, replyAll: Bool) {
        composeAction(
            ComposeContext(
                kind: kind == .forward
                    ? .forward(message: message)
                    : .reply(message: message, replyAll: replyAll),
                mailboxId: mailboxId
            )
        )
    }
}

/// "Remind me about this" — a manual reminder on the thread. The server bounds
/// the time to the next year; these presets stay well inside that.
struct RemindSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    let threadId: String
    let mailboxId: String
    let messageId: String?

    @State private var date = Date.now.addingTimeInterval(3 * 3600)
    @State private var note = ""
    @State private var busy = false

    private var presets: [(String, Date)] {
        let calendar = Calendar.current
        let now = Date.now
        let tomorrowMorning = calendar.date(
            bySettingHour: 9, minute: 0, second: 0,
            of: calendar.date(byAdding: .day, value: 1, to: now) ?? now
        ) ?? now
        let nextWeek = calendar.date(byAdding: .day, value: 7, to: tomorrowMorning) ?? now
        return [
            ("In 3 hours", now.addingTimeInterval(3 * 3600)),
            ("This evening", calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now).flatMap { $0 > now ? $0 : tomorrowMorning } ?? tomorrowMorning),
            ("Tomorrow morning", tomorrowMorning),
            ("Next week", nextWeek),
        ]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("When") {
                    ForEach(presets, id: \.0) { title, value in
                        Button {
                            date = value
                        } label: {
                            HStack {
                                Text(title)
                                Spacer()
                                Text(value.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if abs(value.timeIntervalSince(date)) < 60 {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                    DatePicker("Custom", selection: $date, in: Date.now...)
                }
                Section("Note") {
                    TextField("Optional", text: $note, axis: .vertical)
                        .lineLimit(1...4)
                }
            }
            .navigationTitle("Remind Me")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Set") { Task { await create() } }
                        .disabled(busy || date <= .now)
                }
            }
        }
        .bannerHost()
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await mail.client.createReminder(
                mailboxId: mailboxId, threadId: threadId,
                messageId: messageId, at: date, note: note
            )
            await mail.refreshReminders()
            app.show("Reminder set for \(Fmt.relative(date)).", kind: .success)
            dismiss()
        } catch {
            app.handle(error)
        }
    }
}
