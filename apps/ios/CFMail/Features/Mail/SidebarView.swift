import SwiftUI

/// The mailbox list, in the web app's shape: All Mail, then the mailboxes
/// grouped by kind — Personal, Groups, Service, Temporary — each with its
/// unread pill, a lock when read-only and the time left when disposable; then
/// personal folders with a way to add one; then the app's extras.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.composeAction) private var composeAction
    @Environment(\.mailNavigator) private var navigator
    @Environment(\.horizontalSizeClass) private var sizeClass

    var onOpenSettings: () -> Void
    var onNewTempMailbox: () -> Void
    /// Picking a row always opens it, even when it's the one already showing —
    /// otherwise tapping the current mailbox looks broken.
    var onSelect: (MailScope, MailView) -> Void

    @State private var newFolderName = ""
    @State private var showingNewFolder = false
    @State private var deletingMailbox: MailboxSummary?
    @State private var deletingFolder: Folder?

    private static let groupOrder: [MailboxType] = [.personal, .group, .service, .temp]

    var body: some View {
        // A minute tick so the disposable badges count down without a refresh.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            List {
                if mail.mailboxes.count > 1 {
                    Section {
                        row("All Mail", symbol: "tray.2", badge: mail.totalUnread,
                            isSelected: mail.scope.isAllMail) {
                            onSelect(.mailbox(APIClient.allMailboxes), .inbox)
                        }
                    }
                }

                if mail.mailboxes.isEmpty {
                    Section {
                        Text("No mailboxes yet. An admin creates these for you.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                ForEach(Self.groupOrder, id: \.self) { type in
                    let items = mail.mailboxes.filter { $0.type == type }
                    if !items.isEmpty {
                        Section {
                            ForEach(items) { mailbox in
                                mailboxRow(mailbox, now: context.date)
                            }
                        } header: {
                            Label(Self.groupTitle(type), systemImage: Self.groupSymbol(type))
                        }
                    }
                }

                Section {
                    ForEach(mail.folders) { folder in
                        folderRow(folder)
                    }
                    if mail.folders.isEmpty {
                        Text("File a conversation to keep it out of the inbox.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    HStack {
                        Label("Folders", systemImage: "folder")
                        Spacer()
                        Button("New Folder", systemImage: "folder.badge.plus") {
                            showingNewFolder = true
                        }
                        .labelStyle(.iconOnly)
                        .font(.body)
                        .textCase(nil)
                    }
                }

                Section {
                    linkRow("Reminders", symbol: "bell", badge: mail.pendingReminderCount, tint: .orange) {
                        navigator.open(.reminders)
                    }
                    linkRow("Contacts", symbol: "person.2") { navigator.open(.contacts) }
                    linkRow("Labels", symbol: "tag") { navigator.open(.labels) }
                    linkRow("Manage Folders", symbol: "folder.badge.gearshape") { navigator.open(.folders) }
                    Button(action: onNewTempMailbox) {
                        Label("New Disposable Address", systemImage: "timer")
                    }
                    .foregroundStyle(.primary)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Mailboxes")
        .refreshable { await mail.refreshEverything() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape", action: onOpenSettings)
            }
        }
        .alert("New Folder", isPresented: $showingNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Cancel", role: .cancel) { newFolderName = "" }
            Button("Create") { Task { await createFolder() } }
        } message: {
            Text("Folders are yours alone — filing a conversation moves it out of your mailbox views without touching anyone else's.")
        }
        .confirmationDialog(
            "Delete \(deletingMailbox?.address ?? "this address")?",
            isPresented: Binding(get: { deletingMailbox != nil }, set: { if !$0 { deletingMailbox = nil } }),
            titleVisibility: .visible,
            presenting: deletingMailbox
        ) { mailbox in
            Button("Delete", role: .destructive) { Task { await delete(mailbox) } }
        } message: { _ in
            Text("The address and all its mail are permanently deleted.")
        }
        .confirmationDialog(
            "Delete the folder “\(deletingFolder?.name ?? "")”?",
            isPresented: Binding(get: { deletingFolder != nil }, set: { if !$0 { deletingFolder = nil } }),
            titleVisibility: .visible,
            presenting: deletingFolder
        ) { folder in
            Button("Delete Folder", role: .destructive) { Task { await delete(folder) } }
        } message: { _ in
            Text("The folder is removed; its conversations return to their mailboxes.")
        }
    }

    // ─── Rows ───────────────────────────────────────────────────────────────

    private func mailboxRow(_ mailbox: MailboxSummary, now: Date) -> some View {
        let readOnly = !mailbox.isOwner && !mailbox.canWrite
        let remaining = mailbox.expiresAt.map { Fmt.remaining(until: $0, now: now) }
        return row(
            mailbox.title,
            symbol: mailbox.type.symbol,
            badge: mailbox.unread,
            subtitle: mailbox.displayName?.nilIfBlank != nil ? mailbox.address : nil,
            isSelected: mail.scope.mailboxId == mailbox.id,
            trailing: {
                if readOnly {
                    Image(systemName: "lock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Read-only")
                }
                if let remaining {
                    Text(remaining)
                        .font(.caption2.weight(.medium))
                        .monospacedDigit()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(remaining == "expired" ? .red : .secondary)
                        .overlay(Capsule().strokeBorder(remaining == "expired" ? Color.red : Color(.separator)))
                }
            }
        ) {
            onSelect(.mailbox(mailbox.id), .inbox)
        }
        .contextMenu {
            if mailbox.canWrite {
                Button("New Message", systemImage: "square.and.pencil") {
                    // Composing from the sidebar targets that mailbox directly.
                    composeAction(ComposeContext(kind: .new, mailboxId: mailbox.id))
                }
            }
            Button("Mark All as Read", systemImage: "envelope.open") {
                Task { await mail.markAllRead(mailboxId: mailbox.id) }
            }
            .disabled(mailbox.unread == 0)
            if mailbox.type == .temp, mailbox.isOwner {
                Divider()
                Button("Delete Address", systemImage: "trash", role: .destructive) {
                    deletingMailbox = mailbox
                }
            }
        }
        .swipeActions(edge: .trailing) {
            if mailbox.type == .temp, mailbox.isOwner {
                Button(role: .destructive) { deletingMailbox = mailbox } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private func folderRow(_ folder: Folder) -> some View {
        Button {
            onSelect(.folder(folder.id), .inbox)
        } label: {
            HStack(spacing: 12) {
                // The web app's swatch: a small rounded square in the folder's colour.
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(Color(hex: folder.color))
                    .frame(width: 12, height: 12)
                    .frame(width: 26)
                Text(folder.name)
                    .lineLimit(1)
                    .fontWeight(folder.unread > 0 ? .medium : .regular)
                    .foregroundStyle(.primary)
                Spacer(minLength: 6)
                UnreadBadge(count: folder.unread)
                chevron
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(isHighlighted(mail.scope.folderId == folder.id) ? Color.accentColor.opacity(0.14) : nil)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deletingFolder = folder } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func linkRow(
        _ title: String, symbol: String, badge: Int = 0, tint: Color = .accentColor,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: symbol)
                    .foregroundStyle(.primary)
                Spacer()
                UnreadBadge(count: badge, tint: tint)
                chevron
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func row(
        _ title: String,
        symbol: String,
        badge: Int = 0,
        subtitle: String? = nil,
        isSelected: Bool,
        @ViewBuilder trailing: () -> some View = { EmptyView() },
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .lineLimit(1)
                        .fontWeight(badge > 0 ? .medium : .regular)
                        .foregroundStyle(.primary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                trailing()
                UnreadBadge(count: badge)
                chevron
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(isHighlighted(isSelected) ? Color.accentColor.opacity(0.14) : nil)
        .accessibilityAddTraits(isHighlighted(isSelected) ? .isSelected : [])
    }

    /// Only the tablet's permanent column marks the current row; on a phone
    /// the list is a menu you tap through, like Mail's own.
    private func isHighlighted(_ isSelected: Bool) -> Bool {
        sizeClass == .regular && isSelected
    }

    @ViewBuilder
    private var chevron: some View {
        if sizeClass == .compact {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }

    // ─── Groups ─────────────────────────────────────────────────────────────

    private static func groupTitle(_ type: MailboxType) -> String {
        switch type {
        case .personal: "Personal"
        case .group: "Groups"
        case .service: "Service"
        case .temp: "Temporary"
        }
    }

    private static func groupSymbol(_ type: MailboxType) -> String {
        switch type {
        case .personal: "tray"
        case .group: "person.2"
        case .service: "checkmark.shield"
        case .temp: "timer"
        }
    }

    // ─── Actions ────────────────────────────────────────────────────────────

    private func createFolder() async {
        guard let name = newFolderName.nilIfBlank else { return }
        newFolderName = ""
        do {
            _ = try await mail.client.createFolder(name: name, color: nil)
            await mail.refreshFolders()
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ mailbox: MailboxSummary) async {
        do {
            try await mail.client.deleteMailbox(mailbox.id)
            await mail.refreshCatalogue()
            app.show("Deleted \(mailbox.address).", kind: .success)
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ folder: Folder) async {
        do {
            try await mail.client.deleteFolder(folder.id)
            await mail.refreshFolders()
            if mail.scope.folderId == folder.id {
                onSelect(.mailbox(APIClient.allMailboxes), .inbox)
            }
        } catch {
            app.handle(error)
        }
    }
}
