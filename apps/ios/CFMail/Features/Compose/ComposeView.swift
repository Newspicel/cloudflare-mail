import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposeView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    let context: ComposeContext

    @State private var model: ComposeModel?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingFileImporter = false
    @State private var showingSchedule = false
    @State private var showingDiscardPrompt = false
    @FocusState private var bodyFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    form(model)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .interactiveDismissDisabled(model?.hasContent == true)
        }
        .task {
            guard model == nil else { return }
            let created = ComposeModel(context: context, client: mail.client, app: app, mail: mail)
            model = created
            await mail.loadContactsIfNeeded()
            await created.loadSignature()
            await created.checkRecipients()
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await attach(items) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            Task {
                for url in urls { await model?.attach(fileAt: url) }
            }
        }
        .sheet(isPresented: $showingSchedule) {
            if let model {
                ScheduleSendSheet { date in
                    Task {
                        if await model.schedule(at: date) { dismiss() }
                    }
                }
                .presentationDetents([.medium])
            }
        }
        .confirmationDialog("Discard this message?", isPresented: $showingDiscardPrompt, titleVisibility: .visible) {
            Button("Save as draft") {
                Task {
                    await model?.saveDraft(silent: false)
                    await mail.loadList(reset: true)
                    dismiss()
                }
            }
            Button("Discard", role: .destructive) {
                Task {
                    await model?.discardDraft()
                    await mail.loadList(reset: true)
                    dismiss()
                }
            }
            Button("Keep writing", role: .cancel) {}
        }
    }

    private var title: String {
        switch context.kind {
        case .new: "New message"
        case .reply: "Reply"
        case .forward: "Forward"
        case .draft: "Draft"
        }
    }

    // ─── Form ───────────────────────────────────────────────────────────────

    private func form(_ model: ComposeModel) -> some View {
        @Bindable var model = model

        return ScrollView {
            VStack(spacing: 0) {
                if mail.writableMailboxes.count > 1 { fromRow(model) }

                RecipientField(
                    title: "To",
                    people: $model.to,
                    contacts: mail.contacts,
                    blocked: Set(model.blockedRecipients.map { $0.lowercased() })
                ) {
                    model.scheduleDraftSave()
                    Task { await model.checkRecipients() }
                }

                if model.showsCcBcc {
                    RecipientField(
                        title: "Cc", people: $model.cc, contacts: mail.contacts,
                        blocked: Set(model.blockedRecipients.map { $0.lowercased() })
                    ) { model.scheduleDraftSave() }
                    RecipientField(
                        title: "Bcc", people: $model.bcc, contacts: mail.contacts,
                        blocked: Set(model.blockedRecipients.map { $0.lowercased() })
                    ) { model.scheduleDraftSave() }
                } else {
                    Button("Add Cc / Bcc") {
                        withAnimation(.snappy) { model.showsCcBcc = true }
                    }
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    Divider().padding(.leading, 16)
                }

                HStack(spacing: 8) {
                    Text("Subject")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    TextField("", text: $model.subject)
                        .onChange(of: model.subject) { _, _ in model.scheduleDraftSave() }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                Divider().padding(.leading, 16)

                if !model.blockedRecipients.isEmpty {
                    NoticeBanner(
                        symbol: "hand.raised.fill",
                        title: "Blocked recipient\(model.blockedRecipients.count == 1 ? "" : "s")",
                        detail: model.blockedRecipients.joined(separator: ", ") + " — the server will refuse this send.",
                        tint: .red
                    )
                    .padding(16)
                }

                TextEditor(text: $model.body)
                    .font(model.format == .text ? .body : .body.monospaced())
                    .frame(minHeight: 240)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
                    .focused($bodyFocused)
                    .onChange(of: model.body) { _, _ in model.scheduleDraftSave() }
                    .overlay(alignment: .topLeading) {
                        if model.body.isEmpty {
                            Text(model.format == .markdown ? "Write your message in Markdown…" : "Write your message…")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 17)
                                .padding(.top, 14)
                                .allowsHitTesting(false)
                        }
                    }

                if !model.attachments.isEmpty { attachmentsBlock(model) }

                if let quote = model.quote {
                    quoteNotice(quote)
                }

                if let scheduled = model.scheduledDate {
                    Label(
                        "Scheduled for \(scheduled.formatted(date: .abbreviated, time: .shortened))",
                        systemImage: "clock"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { accessoryBar(model) }
    }

    private func fromRow(_ model: ComposeModel) -> some View {
        @Bindable var model = model

        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("From")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: 38, alignment: .leading)
                Picker("From", selection: $model.mailboxId) {
                    ForEach(mail.writableMailboxes) { mailbox in
                        Text(mailbox.address).tag(mailbox.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .onChange(of: model.mailboxId) { _, _ in
                    Task { await model.loadSignature() }
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            Divider().padding(.leading, 16)
        }
    }

    private func attachmentsBlock(_ model: ComposeModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("\(model.attachments.count) attached", systemImage: "paperclip")
                Spacer()
                Text(Fmt.bytes(model.attachmentsTotal))
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            ForEach(model.attachments) { attachment in
                HStack(spacing: 9) {
                    Image(systemName: "doc")
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(attachment.filename).font(.subheadline).lineLimit(1)
                        Text(Fmt.bytes(attachment.sizeBytes)).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        model.removeAttachment(attachment)
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(9)
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 10))
            }
        }
        .padding(16)
    }

    private func quoteNotice(_ quote: MessageQuoteRef) -> some View {
        Label(
            quote.kind == .reply
                ? "The original message is quoted below when this sends."
                : "The forwarded message is attached below when this sends.",
            systemImage: "text.quote"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func accessoryBar(_ model: ComposeModel) -> some View {
        @Bindable var model = model

        return HStack(spacing: 18) {
            PhotosPicker(selection: $photoItems, matching: .images) {
                Image(systemName: "photo")
            }
            Button { showingFileImporter = true } label: {
                Image(systemName: "paperclip")
            }
            Menu {
                Picker("Format", selection: $model.format) {
                    ForEach(EditorFormat.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.inline)
                .onChange(of: model.format) { _, _ in model.scheduleDraftSave() }
            } label: {
                Image(systemName: "textformat")
            }
            Menu {
                Button("Schedule send…", systemImage: "clock") { showingSchedule = true }
                Divider()
                Section("Remind me if no reply") {
                    Picker("Follow up", selection: $model.followUpDays) {
                        Text("Off").tag(Int?.none)
                        Text("In 2 days").tag(Int?.some(2))
                        Text("In 3 days").tag(Int?.some(3))
                        Text("In a week").tag(Int?.some(7))
                    }
                    .pickerStyle(.inline)
                }
                Divider()
                Button("Save draft", systemImage: "tray.and.arrow.down") {
                    Task { await model.saveDraft(silent: false) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }

            Spacer()

            if model.isUploading || model.isSavingDraft {
                ProgressView().controlSize(.small)
            }
            if model.followUpDays != nil {
                Image(systemName: "bell.badge").foregroundStyle(.orange)
            }
        }
        .font(.title3)
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(.bar)
    }

    // ─── Toolbar ────────────────────────────────────────────────────────────

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
                if model?.hasContent == true {
                    showingDiscardPrompt = true
                } else {
                    dismiss()
                }
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button {
                Task {
                    if await model?.send() == true { dismiss() }
                }
            } label: {
                if model?.isSending == true {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Send", systemImage: "paperplane.fill")
                }
            }
            .disabled(!(model?.canSend ?? false))
        }
    }

    private func attach(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            await model?.attach(
                data: data,
                filename: item.itemIdentifier.map { "\($0.prefix(8)).\(type?.preferredFilenameExtension ?? "jpg")" }
                    ?? "photo.\(type?.preferredFilenameExtension ?? "jpg")",
                contentType: type?.preferredMIMEType ?? "image/jpeg"
            )
        }
        photoItems = []
    }
}

/// Deferred send. The server requires at least a minute of lead time and
/// refuses anything more than a year out.
struct ScheduleSendSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onSchedule: (Date) -> Void

    @State private var date = Date.now.addingTimeInterval(3600)

    private var presets: [(String, Date)] {
        let calendar = Calendar.current
        let now = Date.now
        let tomorrow = calendar.date(
            bySettingHour: 8, minute: 0, second: 0,
            of: calendar.date(byAdding: .day, value: 1, to: now) ?? now
        ) ?? now
        return [
            ("In an hour", now.addingTimeInterval(3600)),
            ("Tonight", calendar.date(bySettingHour: 20, minute: 0, second: 0, of: now).flatMap { $0 > now.addingTimeInterval(300) ? $0 : tomorrow } ?? tomorrow),
            ("Tomorrow morning", tomorrow),
            ("Monday morning", nextMonday(from: now)),
        ]
    }

    private func nextMonday(from date: Date) -> Date {
        var components = DateComponents()
        components.weekday = 2
        components.hour = 8
        return Calendar.current.nextDate(
            after: date, matching: components, matchingPolicy: .nextTime
        ) ?? date.addingTimeInterval(86_400)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Send at") {
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
                    DatePicker("Custom", selection: $date, in: Date.now.addingTimeInterval(120)...)
                }
                Section {
                    Text("The message stays a draft until then. Cancelling the schedule turns it back into an editable draft.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Schedule send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") {
                        onSchedule(date)
                        dismiss()
                    }
                    .disabled(date <= Date.now.addingTimeInterval(60))
                }
            }
        }
    }
}
