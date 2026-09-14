import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    @State private var showingSignOut = false
    @State private var showingPasswordChange = false
    @State private var displayName = ""
    @State private var contacts = SystemContacts.shared

    var body: some View {
        @Bindable var app = app

        NavigationStack {
            Form {
                Section("Account") {
                    if let user = app.user {
                        HStack(spacing: 12) {
                            Avatar(address: AddressObject(name: user.name, address: user.email), size: 44, allowsBrandLogo: false)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name).font(.headline)
                                Text(user.email).font(.caption).foregroundStyle(.secondary)
                                HStack(spacing: 5) {
                                    if user.role == .admin {
                                        Text("Admin")
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 6).padding(.vertical, 1)
                                            .background(.orange.opacity(0.18), in: .capsule)
                                    }
                                    if user.twoFactorEnabled == true {
                                        Label("2FA on", systemImage: "lock.shield")
                                            .font(.caption2)
                                            .foregroundStyle(.green)
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    LabeledContent("Display name") {
                        TextField("Name", text: $displayName)
                            .multilineTextAlignment(.trailing)
                            .onSubmit { Task { await app.updateDisplayName(displayName) } }
                    }
                    Button("Change password…") { showingPasswordChange = true }
                }

                Section("Mailboxes") {
                    ForEach(mail.mailboxes) { mailbox in
                        NavigationLink {
                            MailboxSettingsView(mailbox: mailbox)
                                .environment(app)
                                .environment(mail)
                        } label: {
                            HStack {
                                Image(systemName: mailbox.type.symbol).foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(mailbox.title).lineLimit(1)
                                    Text(mailbox.type.title + (mailbox.isOwner ? " · owner" : " · member"))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section {
                    Toggle("Use Contacts for names and photos", isOn: contactsBinding)
                } header: {
                    Text("Contacts")
                } footer: {
                    Text("Matches senders against your address book on this device, so you see the name and face you already know. Nothing is read until you turn this on, and nothing is sent anywhere.")
                }

                Section("Reading") {
                    Picker("Density", selection: densityBinding) {
                        Text("Comfortable").tag("comfortable")
                        Text("Compact").tag("compact")
                    }
                    Toggle("Show AI summaries in the list", isOn: boolBinding(\.aiSummaries, default: true))
                    Toggle("Mark read when opened", isOn: boolBinding(\.autoMarkRead, default: true))
                    Toggle("Reply all by default", isOn: boolBinding(\.replyAllDefault, default: false))
                }

                Section("Composing") {
                    Picker("Default format", selection: formatBinding) {
                        ForEach(EditorFormat.allCases) { Text($0.title).tag($0) }
                    }
                }

                Section {
                    NavigationLink {
                        NotificationSettingsView()
                            .environment(app)
                            .environment(mail)
                    } label: {
                        Label("Notifications", systemImage: "bell.badge")
                    }
                    NavigationLink {
                        VerificationCodesView()
                            .environment(app)
                    } label: {
                        Label("Verification codes", systemImage: "number.square")
                    }
                    NavigationLink {
                        AppPasswordsView()
                            .environment(app)
                            .environment(mail)
                    } label: {
                        Label("IMAP app passwords", systemImage: "key")
                    }
                }

                Section("Instance") {
                    LabeledContent("Server", value: app.server?.baseURL.host() ?? "—")
                    LabeledContent("Realtime") {
                        switch mail.connection {
                        case .live: Label("Connected", systemImage: "bolt.fill").foregroundStyle(.green)
                        case .connecting: Text("Reconnecting").foregroundStyle(.orange)
                        case .offline: Text("Offline").foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("App version", value: Self.version)
                }

                Section {
                    Button("Sign out", role: .destructive) { showingSignOut = true }
                    Button("Change server…", role: .destructive) {
                        Task {
                            await app.forgetServer()
                            dismiss()
                        }
                    }
                } footer: {
                    Text("cfmail is a single Cloudflare Worker: the web app, this API, inbound mail and IMAP all run in one place.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear { displayName = app.user?.name ?? "" }
            .confirmationDialog("Sign out?", isPresented: $showingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await app.signOut()
                        dismiss()
                    }
                }
            }
            .sheet(isPresented: $showingPasswordChange) {
                ChangePasswordSheet()
                    .environment(app)
                    .presentationDetents([.medium])
            }
        }
        .bannerHost()
    }

    private static var version: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }

    private var contactsBinding: Binding<Bool> {
        Binding(
            get: { contacts.isEnabled },
            set: { wanted in
                if wanted {
                    Task {
                        if await contacts.enable() == false {
                            app.show(
                                "cfmail doesn't have access to Contacts. You can grant it in Settings → Privacy.",
                                kind: .failure
                            )
                        }
                    }
                } else {
                    contacts.isEnabled = false
                }
            }
        )
    }

    private var densityBinding: Binding<String> {
        Binding(
            get: { app.prefs.density ?? "comfortable" },
            set: { value in app.updatePrefs { $0.density = value } }
        )
    }

    private var formatBinding: Binding<EditorFormat> {
        Binding(
            get: { app.prefs.composeDefaultMode ?? .text },
            set: { value in app.updatePrefs { $0.composeDefaultMode = value } }
        )
    }

    private func boolBinding(_ key: WritableKeyPath<UserPrefs, Bool?>, default fallback: Bool) -> Binding<Bool> {
        Binding(
            get: { app.prefs[keyPath: key] ?? fallback },
            set: { value in app.updatePrefs { $0[keyPath: key] = value } }
        )
    }
}

struct ChangePasswordSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?

    private var isValid: Bool {
        !current.isEmpty && next.count >= 8 && next == confirm
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Current password", text: $current)
                    SecureField("New password", text: $next)
                    SecureField("Confirm new password", text: $confirm)
                } footer: {
                    if !next.isEmpty && next.count < 8 {
                        Text("At least 8 characters.").foregroundStyle(.red)
                    } else if !confirm.isEmpty && next != confirm {
                        Text("Those don't match.").foregroundStyle(.red)
                    }
                }
                FormError(message: error)
            }
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!isValid || busy)
                }
            }
        }
    }

    private func save() async {
        guard let client = app.client else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client.changePassword(current: current, new: next)
            app.show("Password changed.", kind: .success)
            dismiss()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Per-mailbox, per-priority alert style. The server stores this (it drives its
/// own Web Push tiering); the app reads the same config for local alerts.
struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail

    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        Form {
            Section {
                switch status {
                case .authorized, .provisional, .ephemeral:
                    Label("Notifications are allowed", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .denied:
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Notifications are off", systemImage: "bell.slash")
                            .foregroundStyle(.orange)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.footnote)
                    }
                default:
                    Button("Allow notifications") {
                        Task {
                            await Notifications.shared.requestAuthorization()
                            status = await Notifications.shared.authorizationStatus
                        }
                    }
                }
            } footer: {
                Text("Alerts are raised on this device — while the app is open it reacts to the server's live stream, and iOS wakes it periodically in the background to check for new mail.")
            }

            ForEach(mail.mailboxes) { mailbox in
                Section(mailbox.address) {
                    tierPicker("Important", mailbox: mailbox, keyPath: \.high)
                    tierPicker("Normal", mailbox: mailbox, keyPath: \.normal)
                    tierPicker("Low priority", mailbox: mailbox, keyPath: \.low)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { status = await Notifications.shared.authorizationStatus }
    }

    private func tierPicker(
        _ title: String,
        mailbox: MailboxSummary,
        keyPath: WritableKeyPath<NotifyConfig, NotifyLevel>
    ) -> some View {
        let config = mail.notifyConfigs[mailbox.id] ?? .defaultOn
        return Picker(title, selection: Binding(
            get: { config[keyPath: keyPath] },
            set: { value in
                var next = config
                next[keyPath: keyPath] = value
                Task { await save(next, for: mailbox) }
            }
        )) {
            ForEach(NotifyLevel.allCases) { Text($0.title).tag($0) }
        }
    }

    private func save(_ config: NotifyConfig, for mailbox: MailboxSummary) async {
        do {
            try await mail.client.setNotifyConfig(
                mailboxId: mailbox.id, high: config.high, normal: config.normal, low: config.low
            )
            await mail.refreshCatalogue()
        } catch {
            app.handle(error)
        }
    }
}
