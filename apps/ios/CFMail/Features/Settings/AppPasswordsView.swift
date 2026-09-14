import SwiftUI

/// IMAP credentials. Web sign-in uses passkeys and 2FA, which IMAP clients
/// can't do, so each client gets its own per-mailbox password instead.
struct AppPasswordsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    @State private var passwords: [AppPassword] = []
    @State private var imap: ImapConnection?
    @State private var isLoading = true
    @State private var showingCreate = false
    @State private var created: AppPasswordCreated?

    var body: some View {
        List {
            Section {
                if let imap {
                    LabeledContent("Server", value: imap.host)
                    LabeledContent("Port", value: "\(imap.port)")
                    LabeledContent("Security", value: "TLS")
                } else {
                    Text("No IMAP endpoint is configured on this instance yet. An admin sets the hostname once Spectrum is pointed at the Worker.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Connection")
            } footer: {
                Text("Sign in with the mailbox address as the username and an app password below.")
            }

            Section("Passwords") {
                if isLoading {
                    ProgressView()
                } else if passwords.isEmpty {
                    Text("None yet.").foregroundStyle(.secondary)
                }
                ForEach(passwords) { password in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(password.name).font(.subheadline.weight(.medium))
                        Text(password.mailboxAddress).font(.caption).foregroundStyle(.secondary)
                        Text(
                            password.lastUsedAt.map { "Last used \(Fmt.relative($0))" }
                                ?? "Never used"
                        )
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await revoke(password) }
                        } label: {
                            Label("Revoke", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("App passwords")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New", systemImage: "plus") { showingCreate = true }
                    .disabled(mail.mailboxes.isEmpty)
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingCreate) {
            CreateAppPasswordSheet { result in
                created = result
                Task { await load() }
            }
            .environment(app)
            .environment(mail)
            .presentationDetents([.medium])
        }
        .sheet(item: $created) { result in
            NewAppPasswordSheet(result: result, imap: imap)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await mail.client.appPasswords()
            passwords = response.passwords
            imap = response.imap
        } catch {
            app.handle(error)
        }
    }

    private func revoke(_ password: AppPassword) async {
        do {
            try await mail.client.deleteAppPassword(password.id)
            await load()
        } catch {
            app.handle(error)
        }
    }
}

struct CreateAppPasswordSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    var onCreated: (AppPasswordCreated) -> Void

    @State private var mailboxId = ""
    @State private var name = UIDevice.current.name
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Mailbox") {
                    Picker("Mailbox", selection: $mailboxId) {
                        ForEach(mail.mailboxes) { Text($0.address).tag($0.id) }
                    }
                    .labelsHidden()
                }
                Section("Name") {
                    TextField("Where will this be used?", text: $name)
                }
            }
            .navigationTitle("New app password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(busy || mailboxId.isEmpty || name.nilIfBlank == nil)
                }
            }
            .onAppear {
                if mailboxId.isEmpty {
                    mailboxId = mail.currentMailbox?.id ?? mail.mailboxes.first?.id ?? ""
                }
            }
        }
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await mail.client.createAppPassword(mailboxId: mailboxId, name: name)
            dismiss()
            onCreated(result)
        } catch {
            app.handle(error)
        }
    }
}

/// The plaintext is returned exactly once, at creation — say so plainly.
struct NewAppPasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    let result: AppPasswordCreated
    let imap: ImapConnection?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Username") {
                        Text(result.username).textSelection(.enabled)
                    }
                    LabeledContent("Password") {
                        Text(result.password)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                    }
                    if let imap {
                        LabeledContent("Server", value: imap.host)
                        LabeledContent("Port", value: "\(imap.port)")
                    }
                } header: {
                    Text("Copy this now")
                } footer: {
                    Text("This password is shown once and never again. If you lose it, revoke it and make another.")
                }

                Section {
                    Button {
                        UIPasteboard.general.string = result.password
                    } label: {
                        Label("Copy password", systemImage: "doc.on.doc")
                    }
                }
            }
            .navigationTitle("App password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .interactiveDismissDisabled()
    }
}
