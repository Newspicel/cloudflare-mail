import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    var onOpenSettings: () -> Void
    var onNewTempMailbox: () -> Void
    var onNavigate: (MailRoute) -> Void
    /// Picking a mailbox always opens it, even when it's the one already
    /// selected — otherwise tapping the current mailbox looks broken.
    var onSelectScope: (MailScope) -> Void

    @State private var newFolderName = ""
    @State private var showingNewFolder = false

    var body: some View {
        @Bindable var mail = mail

        List {
            if mail.mailboxes.count > 1 {
                Section {
                    row(
                        title: "All mail",
                        symbol: "tray.2",
                        badge: mail.totalUnread,
                        isSelected: mail.scope.isAllMail
                    ) {
                        onSelectScope(.mailbox(APIClient.allMailboxes))
                    }
                }
            }

            Section("Mailboxes") {
                ForEach(mail.mailboxes) { mailbox in
                    mailboxRow(mailbox)
                }
                if mail.mailboxes.isEmpty {
                    Text("No mailboxes yet. An admin creates these for you.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !mail.folders.isEmpty {
                Section("Folders") {
                    ForEach(mail.folders) { folder in
                        row(
                            title: folder.name,
                            symbol: "folder",
                            tint: Color(hex: folder.color),
                            badge: folder.unread,
                            subtitle: folder.total > 0 ? "\(folder.total)" : nil,
                            isSelected: mail.scope.folderId == folder.id
                        ) {
                            onSelectScope(.folder(folder.id))
                        }
                    }
                }
            }

            Section {
                Button { onNavigate(.reminders) } label: {
                    HStack {
                        Label("Reminders", systemImage: "bell")
                        Spacer()
                        CountBadge(count: mail.pendingReminderCount, tint: .orange)
                    }
                }
                Button { onNavigate(.folders) } label: {
                    Label("Manage folders", systemImage: "folder.badge.gearshape")
                }
                Button { onNavigate(.labels) } label: {
                    Label("Labels", systemImage: "tag")
                }
                Button { onNavigate(.contacts) } label: {
                    Label("Contacts", systemImage: "person.2")
                }
                Button(action: onNewTempMailbox) {
                    Label("New disposable address", systemImage: "clock.badge.exclamationmark")
                }
            }
            .buttonStyle(.plain)
        }
        .listStyle(.sidebar)
        .navigationTitle("cfmail")
        .refreshable { await mail.refreshEverything() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape", action: onOpenSettings)
            }
        }
        .safeAreaInset(edge: .bottom) { accountFooter }
        .alert("New folder", isPresented: $showingNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Cancel", role: .cancel) { newFolderName = "" }
            Button("Create") { Task { await createFolder() } }
        } message: {
            Text("Folders are yours alone — filing a thread moves it out of your mailbox views without touching anyone else's.")
        }
    }

    @ViewBuilder
    private func mailboxRow(_ mailbox: MailboxSummary) -> some View {
        row(
            title: mailbox.title,
            symbol: mailbox.type.symbol,
            badge: mailbox.unread,
            subtitle: subtitle(for: mailbox),
            isSelected: mail.scope.mailboxId == mailbox.id
        ) {
            onSelectScope(.mailbox(mailbox.id))
        }
        .contextMenu {
            if mailbox.canWrite {
                Button("New message", systemImage: "square.and.pencil") {
                    // Composing from the sidebar targets that mailbox directly.
                    composeAction(ComposeContext(kind: .new, mailboxId: mailbox.id))
                }
            }
            Button("Mark all read", systemImage: "envelope.open") {
                Task {
                    mail.scope = .mailbox(mailbox.id)
                    await mail.markAllRead()
                }
            }
        }
    }

    @Environment(\.composeAction) private var composeAction

    private func subtitle(for mailbox: MailboxSummary) -> String? {
        if mailbox.type == .temp, let expires = mailbox.expiresAt {
            return expires > .now ? "Expires \(Fmt.relative(expires))" : "Expired"
        }
        if mailbox.displayName?.nilIfBlank != nil { return mailbox.address }
        return nil
    }

    @ViewBuilder
    private func row(
        title: String,
        symbol: String,
        tint: Color = .accentColor,
        badge: Int = 0,
        subtitle: String? = nil,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                CountBadge(count: badge)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(
            isSelected
                ? Color.accentColor.opacity(0.14).clipShape(.rect(cornerRadius: 8))
                : Color.clear.clipShape(.rect(cornerRadius: 8))
        )
    }

    private var accountFooter: some View {
        HStack(spacing: 10) {
            if let user = app.user {
                Avatar(address: AddressObject(name: user.name, address: user.email), size: 30, allowsBrandLogo: false)
                VStack(alignment: .leading, spacing: 1) {
                    Text(user.name).font(.footnote.weight(.medium)).lineLimit(1)
                    Text(user.email).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            ConnectionPip(state: mail.connection)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .contentShape(.rect)
        .onTapGesture(perform: onOpenSettings)
    }

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
}
