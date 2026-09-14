import SwiftUI

/// Who else can reach this mailbox, and with which permission bits.
///
/// Access is the `mailbox_member.perms` bitmask the whole API gates on: READ
/// lets someone open the mailbox, WRITE lets them send and move mail, MANAGE
/// lets them change its settings and sharing. The owner always has all three
/// and never appears in the member list.
struct MailboxSharingView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    let mailbox: MailboxSummary

    @State private var members: [MailboxMember] = []
    @State private var invites: [MailboxInvite] = []
    @State private var isLoading = true
    @State private var showingAdd = false
    @State private var editing: MailboxMember?

    var body: some View {
        List {
            Section {
                if isLoading {
                    ProgressView()
                } else if members.isEmpty {
                    Text("Nobody else has access.").foregroundStyle(.secondary)
                }
                ForEach(members) { member in
                    Button { editing = member } label: {
                        HStack(spacing: 11) {
                            Avatar(address: AddressObject(name: member.name, address: member.email), size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(member.name).font(.subheadline).foregroundStyle(.primary)
                                Text(member.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text(member.summary)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await revoke(member) }
                        } label: {
                            Label("Remove", systemImage: "person.badge.minus")
                        }
                    }
                }
            } header: {
                Text("People")
            } footer: {
                Text("Read opens the mailbox. Write also sends and moves mail. Manage also changes settings and sharing.")
            }

            if !invites.isEmpty {
                Section("Pending invites") {
                    ForEach(invites) { invite in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(invite.email).font(.subheadline)
                            Text("Invited \(Fmt.relative(invite.createdAt))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await revoke(invite) }
                            } label: {
                                Label("Revoke", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Sharing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add person", systemImage: "person.badge.plus") { showingAdd = true }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingAdd) {
            GrantAccessSheet(mailbox: mailbox, existing: Set(members.map(\.userId))) {
                await load()
            }
            .environment(app)
            .environment(mail)
        }
        .sheet(item: $editing) { member in
            GrantAccessSheet(mailbox: mailbox, member: member) { await load() }
                .environment(app)
                .environment(mail)
                .presentationDetents([.medium])
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            members = try await mail.client.mailboxMembers(mailbox.id)
            invites = try await mail.client.mailboxInvites(mailbox.id)
        } catch {
            app.handle(error)
        }
    }

    private func revoke(_ member: MailboxMember) async {
        do {
            try await mail.client.revokeMember(mailboxId: mailbox.id, userId: member.userId)
            await load()
        } catch {
            app.handle(error)
        }
    }

    private func revoke(_ invite: MailboxInvite) async {
        do {
            try await mail.client.revokeInvite(mailboxId: mailbox.id, inviteId: invite.id)
            await load()
        } catch {
            app.handle(error)
        }
    }
}

/// Grant or adjust one person's access. Opened blank to add someone, or with a
/// member to change what they can do.
struct GrantAccessSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    let mailbox: MailboxSummary
    var existing: Set<String> = []
    var member: MailboxMember?
    var onSave: () async -> Void

    @State private var directory: [DirectoryUser] = []
    @State private var query = ""
    @State private var selected: DirectoryUser?
    @State private var canRead = true
    @State private var canWrite = false
    @State private var canManage = false
    @State private var busy = false

    private var candidates: [DirectoryUser] {
        let text = query.trimmingCharacters(in: .whitespaces).lowercased()
        return directory
            .filter { !existing.contains($0.id) }
            .filter { user in
                guard !text.isEmpty else { return true }
                return user.email.lowercased().contains(text) || user.name.lowercased().contains(text)
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let member {
                    Section("Person") {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(member.name).font(.subheadline)
                            Text(member.email).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section("Person") {
                        if let selected {
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(selected.name).font(.subheadline)
                                    Text(selected.email).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Change") { self.selected = nil }
                                    .font(.footnote)
                            }
                        } else {
                            TextField("Search people", text: $query)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            ForEach(candidates.prefix(8)) { user in
                                Button {
                                    selected = user
                                } label: {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(user.name).foregroundStyle(.primary)
                                        Text(user.email).font(.caption).foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                            }
                            if candidates.isEmpty {
                                Text("Nobody left to add.").foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section {
                    Toggle("Read", isOn: $canRead)
                        .onChange(of: canRead) { _, value in
                            // Write and manage are meaningless without read.
                            if !value {
                                canWrite = false
                                canManage = false
                            }
                        }
                    Toggle("Write", isOn: $canWrite)
                        .onChange(of: canWrite) { _, value in if value { canRead = true } }
                    Toggle("Manage", isOn: $canManage)
                        .onChange(of: canManage) { _, value in
                            if value {
                                canRead = true
                                canWrite = true
                            }
                        }
                } header: {
                    Text("Access")
                } footer: {
                    Text("Turning everything off removes their access entirely.")
                }
            }
            .navigationTitle(member == nil ? "Add person" : "Access")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(busy || (member == nil && selected == nil))
                }
            }
            .task {
                if let member {
                    canRead = member.canRead
                    canWrite = member.canWrite
                    canManage = member.canManage
                }
                guard member == nil, directory.isEmpty else { return }
                do {
                    directory = try await mail.client.userDirectory()
                } catch {
                    app.handle(error)
                }
            }
        }
    }

    private func save() async {
        guard let userId = member?.userId ?? selected?.id else { return }
        busy = true
        defer { busy = false }
        do {
            if !canRead && !canWrite && !canManage {
                try await mail.client.revokeMember(mailboxId: mailbox.id, userId: userId)
            } else {
                try await mail.client.grantMember(
                    mailboxId: mailbox.id, userId: userId,
                    read: canRead, write: canWrite, manage: canManage
                )
            }
            await onSave()
            dismiss()
        } catch {
            app.handle(error)
        }
    }
}
