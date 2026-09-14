import SwiftUI

/// Filing is per-user: a thread sits in at most one folder for you, and filing
/// it hides it from your mailbox views without touching anyone else's.
struct FolderPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss
    let threadIds: [String]

    @State private var newName = ""
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(mail.folders) { folder in
                        Button {
                            Task {
                                await mail.file(threadIds, into: folder)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(Color(hex: folder.color))
                                Text(folder.name)
                                Spacer()
                                Text("\(folder.total)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text(threadIds.count == 1 ? "Move to Folder" : "Move \(threadIds.count) Conversations")
                } footer: {
                    Text("Folders are personal. Moving a thread here takes it out of your inbox view only.")
                }

                Section("New folder") {
                    HStack {
                        TextField("Name", text: $newName)
                            .submitLabel(.done)
                            .onSubmit { Task { await createAndFile() } }
                        Button("Create") { Task { await createAndFile() } }
                            .disabled(newName.nilIfBlank == nil || creating)
                    }
                }
            }
            .navigationTitle("Move")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .bannerHost()
    }

    private func createAndFile() async {
        guard let name = newName.nilIfBlank, !creating else { return }
        creating = true
        defer { creating = false }
        do {
            let folder = try await mail.client.createFolder(name: name, color: nil)
            await mail.refreshFolders()
            await mail.file(threadIds, into: folder)
            dismiss()
        } catch {
            app.handle(error)
        }
    }
}

/// Labels live on a mailbox, applied per message; applying one to a thread
/// tags every message in it (the worker's `PUT /labels/:id/threads/:id`).
struct LabelPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss
    let thread: MailThread

    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(mail.activeLabels) { label in
                        Button {
                            Task { await mail.toggleLabel(label, on: thread) }
                        } label: {
                            HStack {
                                Circle()
                                    .fill(Color(hex: label.color))
                                    .frame(width: 10, height: 10)
                                Text(label.name)
                                Spacer()
                                if isApplied(label) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                    if mail.activeLabels.isEmpty {
                        Text("No labels in this mailbox yet.")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Labels")
                }

                Section("New label") {
                    HStack {
                        TextField("Name", text: $newName)
                            .submitLabel(.done)
                            .onSubmit { Task { await create() } }
                        Button("Add") { Task { await create() } }
                            .disabled(newName.nilIfBlank == nil)
                    }
                }
            }
            .navigationTitle("Labels")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .bannerHost()
    }

    private func isApplied(_ label: MailLabel) -> Bool {
        mail.labels(for: thread.id).contains { $0.id == label.id }
    }

    private func create() async {
        guard let name = newName.nilIfBlank, let mailboxId = mail.currentMailbox?.id else { return }
        newName = ""
        do {
            let label = try await mail.client.createLabel(mailboxId: mailboxId, name: name, color: nil)
            await mail.reloadLabels(mailboxId: mailboxId)
            await mail.toggleLabel(label, on: thread)
        } catch {
            app.handle(error)
        }
    }
}

/// The structured half of `GET /api/search` — everything the FTS query string
/// can't express on its own.
struct SearchFiltersSheet: View {
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss
    @Bindable var search: SearchModel
    var onApply: () -> Void

    @State private var useAfter = false
    @State private var useBefore = false
    @State private var afterDate = Date.now.addingTimeInterval(-30 * 86_400)
    @State private var beforeDate = Date.now

    var body: some View {
        NavigationStack {
            Form {
                Section("Match") {
                    Picker("Search in", selection: $search.query.searchIn) {
                        ForEach(SearchIn.allCases) { Text($0.title).tag($0) }
                    }
                    LabeledContent("From") {
                        TextField("anyone", text: optional($search.query.from))
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledContent("To") {
                        TextField("anyone", text: optional($search.query.to))
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledContent("Subject") {
                        TextField("any", text: optional($search.query.subject))
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Excluding") {
                        TextField("nothing", text: optional($search.query.exclude))
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("Where") {
                    Picker("Folder", selection: $search.query.folder) {
                        ForEach(SearchFolder.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Mailbox", selection: mailboxBinding) {
                        Text("All mailboxes").tag("")
                        ForEach(mail.mailboxes) { Text($0.address).tag($0.id) }
                    }
                    Picker("Direction", selection: directionBinding) {
                        Text("Any").tag("")
                        Text("Received").tag(MessageDirection.incoming.rawValue)
                        Text("Sent").tag(MessageDirection.outgoing.rawValue)
                    }
                    Toggle("Has attachment", isOn: attachmentBinding)
                }

                Section("When") {
                    Toggle("After", isOn: $useAfter)
                    if useAfter {
                        DatePicker("After date", selection: $afterDate, displayedComponents: .date)
                            .labelsHidden()
                    }
                    Toggle("Before", isOn: $useBefore)
                    if useBefore {
                        DatePicker("Before date", selection: $beforeDate, displayedComponents: .date)
                            .labelsHidden()
                    }
                }

                Section {
                    Picker("Sort", selection: $search.query.sort) {
                        ForEach(SearchSort.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text("Relevance only applies when there's text to rank; metadata-only searches fall back to newest.")
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Reset") {
                        let text = search.text
                        search.reset()
                        search.text = text
                        useAfter = false
                        useBefore = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        search.query.after = useAfter ? Fmt.searchDate(afterDate) : nil
                        search.query.before = useBefore ? Fmt.searchDate(beforeDate) : nil
                        onApply()
                        dismiss()
                    }
                }
            }
            .onAppear {
                useAfter = search.query.after != nil
                useBefore = search.query.before != nil
            }
        }
    }

    /// Text fields bind to `String`; the query keeps `nil` for "not set" so the
    /// parameter is omitted rather than sent blank.
    private func optional(_ binding: Binding<String?>) -> Binding<String> {
        Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.nilIfBlank })
    }

    private var mailboxBinding: Binding<String> {
        Binding(
            get: { search.query.mailboxId ?? "" },
            set: { search.query.mailboxId = $0.isEmpty ? nil : $0 }
        )
    }

    private var directionBinding: Binding<String> {
        Binding(
            get: { search.query.direction?.rawValue ?? "" },
            set: { search.query.direction = $0.isEmpty ? nil : MessageDirection(rawValue: $0) }
        )
    }

    private var attachmentBinding: Binding<Bool> {
        Binding(
            get: { search.query.hasAttachment ?? false },
            set: { search.query.hasAttachment = $0 ? true : nil }
        )
    }
}
