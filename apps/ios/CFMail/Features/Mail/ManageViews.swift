import SwiftUI

/// The bell's feed: manual reminders and "remind me if no reply" follow-ups.
struct RemindersView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.mailNavigator) private var navigator

    @State private var rescheduling: Reminder?

    private var fired: [Reminder] { mail.reminders.filter { $0.status == .fired } }
    private var pending: [Reminder] { mail.reminders.filter { $0.status == .pending } }

    var body: some View {
        List {
            if mail.reminders.isEmpty {
                EmptyState(
                    symbol: "bell.slash",
                    title: "No reminders",
                    message: "Set one from a conversation, or ask to be nudged when a message you send goes unanswered."
                )
                .listRowSeparator(.hidden)
            }
            if !fired.isEmpty {
                Section("Due now") {
                    ForEach(fired) { row($0) }
                }
            }
            if !pending.isEmpty {
                Section("Scheduled") {
                    ForEach(pending) { row($0) }
                }
            }
        }
        .navigationTitle("Reminders")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await mail.refreshReminders() }
        .task { await mail.refreshReminders() }
        .sheet(item: $rescheduling) { reminder in
            RescheduleSheet(reminder: reminder)
                .environment(app)
                .environment(mail)
                .presentationDetents([.medium])
        }
    }

    private func row(_ reminder: Reminder) -> some View {
        Button {
            navigator.showThread(reminder.threadId, reminder.mailboxId)
        } label: {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: reminder.kind == .followUp ? "arrow.uturn.left.circle" : "bell.fill")
                    .foregroundStyle(reminder.status == .fired ? .orange : .secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(reminder.displaySubject)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                    if let note = reminder.note?.nilIfBlank {
                        Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Text(Fmt.relative(reminder.remindAt))
                        if reminder.kind == .followUp { Text("· no reply yet") }
                        if let mailbox = mail.mailbox(id: reminder.mailboxId) {
                            Text("· \(mailbox.address)").lineLimit(1)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 3)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                Task { await mail.deleteReminder(reminder) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button { rescheduling = reminder } label: {
                Label("Snooze", systemImage: "clock.arrow.circlepath")
            }
            .tint(.indigo)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { Task { await mail.dismissReminder(reminder) } } label: {
                Label("Done", systemImage: "checkmark")
            }
            .tint(.green)
        }
    }
}

struct RescheduleSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss
    let reminder: Reminder

    @State private var date = Date.now.addingTimeInterval(3600)

    var body: some View {
        NavigationStack {
            Form {
                Section("Remind me again") {
                    DatePicker("At", selection: $date, in: Date.now...)
                }
            }
            .navigationTitle("Snooze")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await mail.client.rescheduleReminder(reminder.id, to: date)
                                await mail.refreshReminders()
                                dismiss()
                            } catch {
                                app.handle(error)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Labels belong to a mailbox and are applied per message.
struct LabelsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    @State private var selectedMailboxId = ""
    @State private var newName = ""
    @State private var editing: MailLabel?

    private var labels: [MailLabel] { mail.labelsByMailbox[selectedMailboxId] ?? [] }

    var body: some View {
        List {
            if mail.mailboxes.count > 1 {
                Picker("Mailbox", selection: $selectedMailboxId) {
                    ForEach(mail.mailboxes) { Text($0.address).tag($0.id) }
                }
                .onChange(of: selectedMailboxId) { _, id in
                    Task { await mail.reloadLabels(mailboxId: id) }
                }
            }

            Section {
                ForEach(labels) { label in
                    Button { editing = label } label: {
                        HStack {
                            Circle().fill(Color(hex: label.color)).frame(width: 12, height: 12)
                            Text(label.name).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await delete(label) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                if labels.isEmpty {
                    Text("No labels in this mailbox yet.").foregroundStyle(.secondary)
                }
            } header: {
                Text("Labels")
            } footer: {
                Text("Labels are shared with everyone who can read the mailbox.")
            }

            Section("Add") {
                HStack {
                    TextField("Name", text: $newName)
                        .submitLabel(.done)
                        .onSubmit { Task { await create() } }
                    Button("Create") { Task { await create() } }
                        .disabled(newName.nilIfBlank == nil || selectedMailboxId.isEmpty)
                }
            }
        }
        .navigationTitle("Labels")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if selectedMailboxId.isEmpty {
                selectedMailboxId = mail.currentMailbox?.id ?? mail.mailboxes.first?.id ?? ""
            }
            if !selectedMailboxId.isEmpty {
                await mail.reloadLabels(mailboxId: selectedMailboxId)
            }
        }
        .sheet(item: $editing) { label in
            EditNamedColorSheet(
                title: "Label",
                name: label.name,
                color: label.color
            ) { name, color in
                try await mail.client.updateLabel(label.id, name: name, color: color)
                await mail.reloadLabels(mailboxId: selectedMailboxId)
            }
            .environment(app)
            .presentationDetents([.medium])
        }
    }

    private func create() async {
        guard let name = newName.nilIfBlank, !selectedMailboxId.isEmpty else { return }
        newName = ""
        do {
            _ = try await mail.client.createLabel(mailboxId: selectedMailboxId, name: name, color: nil)
            await mail.reloadLabels(mailboxId: selectedMailboxId)
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ label: MailLabel) async {
        do {
            try await mail.client.deleteLabel(label.id)
            await mail.reloadLabels(mailboxId: selectedMailboxId)
        } catch {
            app.handle(error)
        }
    }
}

/// Folders are user-level: they span mailboxes and nobody else sees your filing.
struct FoldersView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    @State private var newName = ""
    @State private var editing: Folder?

    var body: some View {
        List {
            Section {
                ForEach(mail.folders) { folder in
                    Button { editing = folder } label: {
                        HStack {
                            Image(systemName: "folder.fill").foregroundStyle(Color(hex: folder.color))
                            Text(folder.name).foregroundStyle(.primary)
                            Spacer()
                            Text("\(folder.total)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await delete(folder) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                .onMove(perform: reorder)

                if mail.folders.isEmpty {
                    Text("No folders yet.").foregroundStyle(.secondary)
                }
            } header: {
                Text("Your folders")
            } footer: {
                Text("Filing a thread into a folder takes it out of your inbox view. Deleting a folder returns its threads; it never deletes mail.")
            }

            Section("Add") {
                HStack {
                    TextField("Name", text: $newName)
                        .submitLabel(.done)
                        .onSubmit { Task { await create() } }
                    Button("Create") { Task { await create() } }
                        .disabled(newName.nilIfBlank == nil)
                }
            }
        }
        .navigationTitle("Folders")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .refreshable { await mail.refreshFolders() }
        .sheet(item: $editing) { folder in
            EditNamedColorSheet(title: "Folder", name: folder.name, color: folder.color) { name, color in
                try await mail.client.updateFolder(folder.id, name: name, color: color)
                await mail.refreshFolders()
            }
            .environment(app)
            .presentationDetents([.medium])
        }
    }

    private func create() async {
        guard let name = newName.nilIfBlank else { return }
        newName = ""
        do {
            _ = try await mail.client.createFolder(name: name, color: nil)
            await mail.refreshFolders()
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ folder: Folder) async {
        do {
            try await mail.client.deleteFolder(folder.id)
            await mail.refreshFolders()
        } catch {
            app.handle(error)
        }
    }

    private func reorder(from source: IndexSet, to destination: Int) {
        var ordered = mail.folders
        ordered.move(fromOffsets: source, toOffset: destination)
        Task {
            for (index, folder) in ordered.enumerated() where folder.position != index {
                try? await mail.client.updateFolder(folder.id, position: index)
            }
            await mail.refreshFolders()
        }
    }
}

/// Shared rename/recolour sheet for labels and folders — both are a name plus
/// an `#rrggbb`.
struct EditNamedColorSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let title: String
    @State var name: String
    @State var color: String
    let save: (String, String) async throws -> Void

    @State private var busy = false

    private static let palette = [
        "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981",
        "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899",
        "#64748b", "#78716c",
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Name", text: $name)
                }
                Section("Colour") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(Self.palette, id: \.self) { hex in
                            Button {
                                color = hex
                            } label: {
                                Circle()
                                    .fill(Color(hex: hex))
                                    .frame(height: 32)
                                    .overlay {
                                        if color.lowercased() == hex {
                                            Image(systemName: "checkmark")
                                                .font(.caption.weight(.bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            busy = true
                            defer { busy = false }
                            do {
                                try await save(name, color)
                                dismiss()
                            } catch {
                                app.handle(error)
                            }
                        }
                    }
                    .disabled(busy || name.nilIfBlank == nil)
                }
            }
        }
    }
}

/// Disposable addresses: random local part, TTL, collected by the Worker's cron.
struct TempMailboxSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    @State private var domains: [TempDomain] = []
    @State private var domainId = ""
    @State private var ttl = 3600
    @State private var label = ""
    @State private var busy = false
    @State private var error: String?

    private static let options: [(String, Int)] = [
        ("10 minutes", 600), ("1 hour", 3600), ("6 hours", 21_600),
        ("1 day", 86_400), ("7 days", 604_800),
    ]

    var body: some View {
        NavigationStack {
            Form {
                if domains.isEmpty {
                    Section {
                        Text("No domain here allows disposable addresses. An admin enables that per domain.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Domain") {
                        Picker("Domain", selection: $domainId) {
                            ForEach(domains) { Text($0.name).tag($0.id) }
                        }
                        .labelsHidden()
                    }
                    Section("Expires after") {
                        Picker("TTL", selection: $ttl) {
                            ForEach(Self.options, id: \.1) { Text($0.0).tag($0.1) }
                        }
                        .labelsHidden()
                    }
                    Section("Label") {
                        TextField("Optional, e.g. “conference signup”", text: $label)
                    }
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("Disposable Address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(busy || domainId.isEmpty)
                }
            }
            .task {
                do {
                    domains = try await mail.client.tempDomains()
                    domainId = domains.first?.id ?? ""
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
        .bannerHost()
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            try await mail.client.createTempMailbox(
                domainId: domainId, ttlSeconds: ttl, displayName: label
            )
            await mail.refreshCatalogue()
            app.show("Disposable address created.", kind: .success)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
