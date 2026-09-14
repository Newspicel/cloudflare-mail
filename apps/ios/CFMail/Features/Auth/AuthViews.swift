import SwiftUI

/// Step one: point the app at an instance. There is no hosted cfmail — every
/// deployment is somebody's own Worker — so this can't be skipped.
struct ServerSetupView: View {
    @Environment(AppModel.self) private var app
    @State private var address = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        AuthScaffold(
            title: "Connect to your instance",
            subtitle: "cfmail runs on your own Cloudflare Worker. Enter the address you use in the browser."
        ) {
            VStack(alignment: .leading, spacing: 16) {
                TextField("mail.example.com", text: $address)
                    .accessibilityIdentifier("server.address")
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit { Task { await connect() } }
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))

                FormError(message: error)

                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(busy ? "Checking…" : "Continue")
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("server.continue")
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)

                Text("https:// is assumed. Plain http works for a LAN address or `wrangler dev` on this machine.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { focused = true }
        .animation(.snappy, value: error)
    }

    private func connect() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.useServer(address)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showingReset = false
    @FocusState private var field: Field?

    private enum Field { case email, password }

    var body: some View {
        AuthScaffold(title: "Sign in", subtitle: app.server?.baseURL.host()) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(spacing: 10) {
                    TextField("Email", text: $email)
                        .accessibilityIdentifier("signin.email")
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($field, equals: .email)
                        .onSubmit { field = .password }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))

                    SecureField("Password", text: $password)
                        .accessibilityIdentifier("signin.password")
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($field, equals: .password)
                        .onSubmit { Task { await signIn() } }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                }

                FormError(message: error)

                Button {
                    Task { await signIn() }
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(busy ? "Signing in…" : "Sign in")
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("signin.submit")
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(busy || email.isEmpty || password.isEmpty)

                HStack {
                    Button("Forgot password?") { showingReset = true }
                    Spacer()
                    Button("Change server") { Task { await app.forgetServer() } }
                }
                .font(.footnote)

                Text("cfmail has no open sign-up: accounts come from an admin or an invite link.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { field = .email }
        .animation(.snappy, value: error)
        .sheet(isPresented: $showingReset) {
            PasswordResetSheet(email: email)
                .presentationDetents([.medium])
        }
    }

    private func signIn() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.signIn(email: email, password: password)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

struct TwoFactorView: View {
    @Environment(AppModel.self) private var app
    @State private var code = ""
    @State private var useBackupCode = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        AuthScaffold(
            title: "Two-factor",
            subtitle: useBackupCode
                ? "Enter one of your saved backup codes."
                : "Enter the six-digit code from your authenticator app."
        ) {
            VStack(alignment: .leading, spacing: 16) {
                TextField(useBackupCode ? "Backup code" : "000000", text: $code)
                    .accessibilityIdentifier("twofactor.code")
                    .textContentType(useBackupCode ? .none : .oneTimeCode)
                    .keyboardType(useBackupCode ? .asciiCapable : .numberPad)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(useBackupCode ? .body : .title2.monospacedDigit())
                    .multilineTextAlignment(useBackupCode ? .leading : .center)
                    .focused($focused)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                    .onChange(of: code) { _, value in
                        guard !useBackupCode else { return }
                        let digits = value.filter(\.isNumber)
                        if digits != value { code = digits }
                        if digits.count == 6 { Task { await verify() } }
                    }

                FormError(message: error)

                Button {
                    Task { await verify() }
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(busy ? "Verifying…" : "Verify")
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("twofactor.verify")
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(busy || code.isEmpty)

                HStack {
                    Button(useBackupCode ? "Use authenticator code" : "Use a backup code") {
                        useBackupCode.toggle()
                        code = ""
                        error = nil
                    }
                    Spacer()
                    Button("Cancel") { app.cancelTwoFactor() }
                }
                .font(.footnote)
            }
        }
        .onAppear { focused = true }
        .animation(.snappy, value: error)
    }

    private func verify() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.verifyTwoFactor(code: code, isBackupCode: useBackupCode)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            code = ""
        }
    }
}

/// Self-service reset exists for regular users only — admins recover through
/// backup codes or the CLI, by design (auth.ts `sendResetPassword`).
struct PasswordResetSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var email: String
    @State private var busy = false
    @State private var sent = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .accessibilityIdentifier("signin.email")
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("A reset link is emailed to you and is valid for an hour. Admin accounts can't reset this way — use a 2FA backup code.")
                }

                if sent {
                    Label("If that address has an account, a reset link is on its way.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
                FormError(message: error)
            }
            .navigationTitle("Reset password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await submit() } }
                        .disabled(busy || email.isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard let client = app.client else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client.requestPasswordReset(email: email)
            sent = true
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
