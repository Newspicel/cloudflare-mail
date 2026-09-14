import SwiftUI

/// Mail's "Mailboxes" screen: the standard folders across every mailbox at
/// the top, personal folders, then one collapsible section per mailbox with
/// its own folders, and the app's extras at the bottom.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.composeAction) private var composeAction
    @Environment(\.horizontalSizeClass) private var sizeClass

    var onOpenSettings: () -> Void
    var onNewTempMailbox: () -> Void
    /// Picking a row always opens it, even when it's the one already showing —
    /// otherwise tapping the current mailbox looks broken.
    var onSelect: (MailScope, MailView) -> Void

    /// Per-mailbox sections start closed once there are enough of them to
    /// crowd the screen; the top section already covers the common case.
    @State private var expanded: Set<String> = []
    @State private var didSeedExpansion = false

    private static let standardViews: [MailView] = [.marked, .drafts, .sent, .spam, .trash, .all]

    /// The scope the top section's rows open: everything combined when there
    /// is more than one mailbox, otherwise the one mailbox there is.
    private var combined: MailScope? {
        if mail.mailboxes.count > 1 { return .mailbox(APIClient.allMailboxes) }
        return mail.mailboxes.first.map { .mailbox($0.id) }
    }

    var body: some View {
        List {
            standardSection
            foldersSection
            mailboxSections
            extrasSection
        }
        .listStyle(.sidebar)
        .navigationTitle("Mailboxes")
        .refreshable { await mail.refreshEverything() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape", action: onOpenSettings)
            }
        }
        .onChange(of: mail.mailboxes.map(\.id), initial: true) { _, ids in
            guard !didSeedExpansion, !ids.isEmpty else { return }
            didSeedExpansion = true
            if ids.count <= 2 { expanded = Set(ids) }
        }
    }

    // ─── Sections ───────────────────────────────────────────────────────────

    /// The standard folders across every mailbox: All Inboxes with each
    /// mailbox's inbox tucked under it, then Starred, Drafts, Sent, Spam,
    /// Trash and All Mail.
    @ViewBuilder
    private var standardSection: some View {
        if let combined {
            Section {
                inboxRows(combined)
                ForEach(Self.standardViews) { view in
                    standardRow(view, in: combined)
                }
            } footer: {
                if mail.mailboxes.count == 1, let only = mail.mailboxes.first,
                   let subtitle = subtitle(for: only) {
                    Text(subtitle)
                }
            }
        } else {
            Section {
                Text("No mailboxes yet. An admin creates these for you.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func inboxRows(_ combined: MailScope) -> some View {
        if mail.mailboxes.count > 1 {
            row("All Inboxes", symbol: "tray.2", count: mail.totalUnread,
                isSelected: isSelected(combined, .inbox)) {
                onSelect(combined, .inbox)
            }
            ForEach(mail.mailboxes) { mailbox in
                row(mailbox.title, symbol: "tray", count: mailbox.unread,
                    subtitle: subtitle(for: mailbox), indented: true,
                    isSelected: isSelected(.mailbox(mailbox.id), .inbox)) {
                    onSelect(.mailbox(mailbox.id), .inbox)
                }
                .contextMenu { mailboxMenu(mailbox) }
            }
        } else if let only = mail.mailboxes.first {
            row("Inbox", symbol: "tray", count: only.unread,
                isSelected: isSelected(combined, .inbox)) {
                onSelect(combined, .inbox)
            }
            .contextMenu { mailboxMenu(only) }
        }
    }

    @ViewBuilder
    private var foldersSection: some View {
        if !mail.folders.isEmpty {
            Section("Folders") {
                ForEach(mail.folders) { folder in
                    row(folder.name, symbol: "folder", tint: Color(hex: folder.color),
                        count: folder.unread,
                        isSelected: mail.scope.folderId == folder.id) {
                        onSelect(.folder(folder.id), .inbox)
                    }
                }
            }
        }
    }

    /// One collapsible section per mailbox, as Mail lists each account.
    @ViewBuilder
    private var mailboxSections: some View {
        if mail.mailboxes.count > 1 {
            ForEach(mail.mailboxes) { mailbox in
                Section(isExpanded: expansion(for: mailbox)) {
                    mailboxRows(mailbox)
                } header: {
                    // Collapsible sections take no footer, so the expiry or
                    // address rides along in the header.
                    if let subtitle = subtitle(for: mailbox) {
                        Text("\(mailbox.title) · \(subtitle)")
                    } else {
                        Text(mailbox.title)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func mailboxRows(_ mailbox: MailboxSummary) -> some View {
        let scope = MailScope.mailbox(mailbox.id)
        row("Inbox", symbol: "tray", count: mailbox.unread,
            isSelected: isSelected(scope, .inbox)) {
            onSelect(scope, .inbox)
        }
        ForEach(Self.standardViews) { view in
            standardRow(view, in: scope)
        }
    }

    private var extrasSection: some View {
        Section {
            linkRow("Reminders", symbol: "bell", count: mail.pendingReminderCount) {
                navigator.open(.reminders)
            }
            linkRow("Contacts", symbol: "person.2") { navigator.open(.contacts) }
            linkRow("Labels", symbol: "tag") { navigator.open(.labels) }
            linkRow("Manage Folders", symbol: "folder.badge.gearshape") { navigator.open(.folders) }
            Button(action: onNewTempMailbox) {
                Label("New Disposable Address", systemImage: "clock.badge.exclamationmark")
            }
        }
    }

    private func linkRow(_ title: String, symbol: String, count: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: symbol)
                    .foregroundStyle(.primary)
                Spacer()
                SidebarCount(count: count)
                chevron
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    @Environment(\.mailNavigator) private var navigator

    // ─── Rows ───────────────────────────────────────────────────────────────

    private func standardRow(_ view: MailView, in scope: MailScope) -> some View {
        row(view.title, symbol: view.symbol, tint: view.tintIsOrange ? .orange : .accentColor,
            count: count(for: view, in: scope), isSelected: isSelected(scope, view)) {
            onSelect(scope, view)
        }
    }

    /// The store only holds counts for the scope on screen; Inbox rows have
    /// their own unread figure from the catalogue, the rest show one when
    /// it's known.
    private func count(for view: MailView, in scope: MailScope) -> Int {
        guard scope == mail.scope, view.badgeCountsUnread else { return 0 }
        return mail.count(view).unread
    }

    private func isSelected(_ scope: MailScope, _ view: MailView) -> Bool {
        sizeClass == .regular && mail.scope == scope && mail.view == view
    }

    private func expansion(for mailbox: MailboxSummary) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(mailbox.id) },
            set: { open in
                if open { expanded.insert(mailbox.id) } else { expanded.remove(mailbox.id) }
            }
        )
    }

    @ViewBuilder
    private func mailboxMenu(_ mailbox: MailboxSummary) -> some View {
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
    }

    private func subtitle(for mailbox: MailboxSummary) -> String? {
        if mailbox.type == .temp, let expires = mailbox.expiresAt {
            return expires > .now ? "Expires \(Fmt.relative(expires))" : "Expired"
        }
        if mailbox.displayName?.nilIfBlank != nil { return mailbox.address }
        return nil
    }

    private func row(
        _ title: String,
        symbol: String,
        tint: Color = .accentColor,
        count: Int = 0,
        subtitle: String? = nil,
        indented: Bool = false,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.body)
                    .foregroundStyle(tint)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                SidebarCount(count: count)
                chevron
            }
            .padding(.leading, indented ? 30 : 0)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(isSelected ? Color.accentColor.opacity(0.14) : nil)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Rows push a screen on iPhone; the disclosure chevron says so, as on
    /// Mail's own Mailboxes list. Columns on iPad need no such hint.
    @ViewBuilder
    private var chevron: some View {
        if sizeClass == .compact {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }
}
