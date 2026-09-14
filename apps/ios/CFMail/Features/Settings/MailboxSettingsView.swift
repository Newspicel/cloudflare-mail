import SwiftUI

struct MailboxSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    let mailbox: MailboxSummary

    @State private var settings: MailboxSettings?
    @State private var displayName = ""
    @State private var signature = ""
    @State private var replyTo = ""
    @State private var isSaving = false
    @State private var showingPublicKey = false
    @State private var confirmDelete = false

    private var canManage: Bool { mailbox.isOwner || mailbox.canManage }

    var body: some View {
        Form {
            Section {
                LabeledContent("Address", value: mailbox.address)
                LabeledContent("Type", value: mailbox.type.title)
                LabeledContent("Your access", value: accessSummary)
                if let expires = mailbox.expiresAt {
                    LabeledContent("Expires", value: expires.formatted(date: .abbreviated, time: .shortened))
                }
            }

            if let settings {
                Section("Identity") {
                    TextField("Display name", text: $displayName)
                        .disabled(!canManage)
                    TextField("Reply-To address", text: $replyTo)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(!canManage)
                }

                Section {
                    TextField("Signature", text: $signature, axis: .vertical)
                        .lineLimit(3...10)
                        .disabled(!canManage)
                } header: {
                    Text("Signature")
                } footer: {
                    Text("Appended below new messages you compose from this mailbox.")
                }

                Section {
                    Picker("Filtering", selection: spamBinding(settings)) {
                        ForEach(SpamFilterLevel.allCases) { Text($0.title).tag($0) }
                    }
                    .disabled(!canManage)
                    Text(settings.spamFilter.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let usage = settings.spamUsage, usage.calls > 0 {
                        LabeledContent("AI calls this month", value: "\(usage.calls)")
                        LabeledContent("Tokens", value: usage.tokens.formatted())
                    }
                } header: {
                    Text("Spam")
                } footer: {
                    Text("Spam scoring never blocks delivery — a message that scores badly lands in Spam, not nowhere.")
                }

                Section {
                    Toggle("Reader AI features", isOn: aiBinding(settings))
                        .disabled(!canManage)
                    if let usage = settings.aiUsage, usage.calls > 0 {
                        LabeledContent("Calls this month", value: "\(usage.calls)")
                        LabeledContent("Tokens", value: usage.tokens.formatted())
                    }
                } header: {
                    Text("AI")
                } footer: {
                    Text("Summaries in the list, thread catch-ups and suggested replies, all run on Workers AI.")
                }

                Section {
                    Picker("Mode", selection: pgpBinding(settings)) {
                        ForEach(PgpMode.allCases) { Text($0.title).tag($0) }
                    }
                    .disabled(!canManage || !settings.pgpConfigured)
                    Toggle("Auto-discover keys (WKD)", isOn: pgpAutoFetchBinding(settings))
                        .disabled(!canManage)
                    if settings.pgpConfigured, let fingerprint = settings.pgpFingerprint {
                        LabeledContent("Fingerprint") {
                            Text(fingerprint.uppercased())
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Button("Share public key") { showingPublicKey = true }
                        NavigationLink {
                            ContactKeysView(mailbox: mailbox)
                                .environment(app)
                                .environment(mail)
                        } label: {
                            Label("Correspondent keys", systemImage: "person.badge.key")
                        }
                    } else {
                        Text("No keypair on this mailbox yet. Generate or import one from the web app.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("PGP")
                } footer: {
                    Text("This is gateway PGP, not end-to-end: the Worker holds the mailbox keypair so it can decrypt for search, spam scoring and threading.")
                }

                Section {
                    Toggle("Exclude from All mail", isOn: excludeBinding(settings))
                        .disabled(!canManage)
                    NavigationLink {
                        RulesView(mailbox: mailbox)
                            .environment(app)
                            .environment(mail)
                    } label: {
                        Label("Rules", systemImage: "line.3.horizontal.decrease")
                    }
                    if canManage {
                        NavigationLink {
                            MailboxSharingView(mailbox: mailbox)
                                .environment(app)
                                .environment(mail)
                        } label: {
                            Label("Sharing", systemImage: "person.2.badge.gearshape")
                        }
                    }
                } header: {
                    Text("Organisation")
                }

                if mailbox.isOwner {
                    Section {
                        Button("Delete mailbox", role: .destructive) { confirmDelete = true }
                    } footer: {
                        Text("Deleting removes the address and everything stored in it.")
                    }
                }
            } else {
                Section { ProgressView() }
            }
        }
        .navigationTitle(mailbox.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await saveText() } }
                        .disabled(isSaving || settings == nil)
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showingPublicKey) {
            if let key = settings?.pgpPublicKey {
                PublicKeySheet(address: mailbox.address, armored: key)
            }
        }
        .confirmationDialog(
            "Delete \(mailbox.address)?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Every thread, message and attachment in this mailbox is removed. This can't be undone.")
        }
    }

    private var accessSummary: String {
        if mailbox.isOwner { return "Owner" }
        var parts: [String] = ["Read"]
        if mailbox.canWrite { parts.append("write") }
        if mailbox.canManage { parts.append("manage") }
        return parts.joined(separator: ", ")
    }

    private func load() async {
        do {
            let loaded = try await mail.client.mailboxSettings(mailbox.id)
            settings = loaded
            displayName = loaded.displayName ?? ""
            signature = loaded.signature ?? ""
            replyTo = loaded.replyTo ?? ""
        } catch {
            app.handle(error)
        }
    }

    private func saveText() async {
        await apply(
            MailboxSettingsPatch(
                displayName: displayName.nilIfBlank,
                signature: signature.nilIfBlank,
                replyTo: replyTo.trimmingCharacters(in: .whitespaces)
            )
        )
        app.show("Saved.", kind: .success)
    }

    private func apply(_ patch: MailboxSettingsPatch) async {
        isSaving = true
        defer { isSaving = false }
        do {
            settings = try await mail.client.updateMailboxSettings(mailbox.id, patch)
            await mail.refreshCatalogue()
        } catch {
            app.handle(error)
        }
    }

    private func delete() async {
        do {
            try await mail.client.deleteMailbox(mailbox.id)
            await mail.refreshCatalogue()
        } catch {
            app.handle(error)
        }
    }

    // Toggles write straight through; text fields wait for Save.
    private func spamBinding(_ settings: MailboxSettings) -> Binding<SpamFilterLevel> {
        Binding(
            get: { settings.spamFilter },
            set: { value in Task { await apply(MailboxSettingsPatch(spamFilter: value)) } }
        )
    }

    private func aiBinding(_ settings: MailboxSettings) -> Binding<Bool> {
        Binding(
            get: { settings.aiFeatures },
            set: { value in Task { await apply(MailboxSettingsPatch(aiFeatures: value)) } }
        )
    }

    private func pgpBinding(_ settings: MailboxSettings) -> Binding<PgpMode> {
        Binding(
            get: { settings.pgpMode },
            set: { value in Task { await apply(MailboxSettingsPatch(pgpMode: value)) } }
        )
    }

    private func pgpAutoFetchBinding(_ settings: MailboxSettings) -> Binding<Bool> {
        Binding(
            get: { settings.pgpAutoFetch },
            set: { value in Task { await apply(MailboxSettingsPatch(pgpAutoFetch: value)) } }
        )
    }

    private func excludeBinding(_ settings: MailboxSettings) -> Binding<Bool> {
        Binding(
            get: { settings.excludeFromAll },
            set: { value in Task { await apply(MailboxSettingsPatch(excludeFromAll: value)) } }
        )
    }
}

struct PublicKeySheet: View {
    @Environment(\.dismiss) private var dismiss
    let address: String
    let armored: String

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(armored)
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle("Public key")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: armored, subject: Text("PGP public key for \(address)"))
                }
            }
        }
    }
}

/// Keys captured from correspondents (TOFU / WKD / imported). Confirming one
/// out-of-band is what turns "signed" into "verified".
struct ContactKeysView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    let mailbox: MailboxSummary

    @State private var keys: [ContactKey] = []
    @State private var isLoading = true

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if keys.isEmpty {
                EmptyState(
                    symbol: "key",
                    title: "No correspondent keys",
                    message: "Keys arrive when a signed message carries one, or via Web Key Directory."
                )
                .listRowSeparator(.hidden)
            }
            ForEach(keys) { key in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(key.email).font(.subheadline.weight(.medium))
                        Spacer()
                        if key.verified {
                            Label("Confirmed", systemImage: "checkmark.seal.fill")
                                .font(.caption2)
                                .foregroundStyle(.green)
                        }
                    }
                    Text(key.fingerprint.uppercased())
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(key.source.label)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 2)
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await delete(key) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        Task { await setVerified(key, !key.verified) }
                    } label: {
                        Label(key.verified ? "Unconfirm" : "Confirm", systemImage: "checkmark.seal")
                    }
                    .tint(.green)
                }
            }
        }
        .navigationTitle("Correspondent keys")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            keys = try await mail.client.contactKeys(mailboxId: mailbox.id)
        } catch {
            app.handle(error)
        }
    }

    private func setVerified(_ key: ContactKey, _ verified: Bool) async {
        do {
            try await mail.client.setContactKeyVerified(
                mailboxId: mailbox.id, keyId: key.id, verified: verified
            )
            await load()
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ key: ContactKey) async {
        do {
            try await mail.client.deleteContactKey(mailboxId: mailbox.id, keyId: key.id)
            await load()
        } catch {
            app.handle(error)
        }
    }
}
