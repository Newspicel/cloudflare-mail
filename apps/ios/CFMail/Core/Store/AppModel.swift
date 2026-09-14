import Foundation
import SwiftUI

/// A transient message shown over the UI. Errors linger; confirmations don't.
struct Banner: Identifiable, Equatable {
    enum Kind: Equatable { case info, success, failure }

    let id = UUID()
    var text: String
    var kind: Kind = .info
    var undo: UndoAction?

    struct UndoAction: Equatable {
        let id = UUID()
        var title: String
        static func == (a: UndoAction, b: UndoAction) -> Bool { a.id == b.id }
    }

    var symbol: String {
        switch kind {
        case .info: "info.circle.fill"
        case .success: "checkmark.circle.fill"
        case .failure: "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch kind {
        case .info: .accentColor
        case .success: .green
        case .failure: .red
        }
    }
}

/// Session and routing: which instance we talk to, who is signed in, and what
/// the root view should be showing.
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        /// No instance configured yet — the app is useless without one.
        case needsServer
        case signedOut
        /// Password accepted, Better Auth wants the second factor.
        case twoFactor
        case ready
    }

    private(set) var phase: Phase = .launching
    private(set) var server: ServerConfig?
    private(set) var client: APIClient?
    private(set) var user: MeUser?
    private(set) var mail: MailStore?

    var prefs: UserPrefs = .empty
    var banner: Banner?
    /// Set by a notification tap; the root view consumes it and navigates.
    var pendingTap: NotificationTap?

    private var bannerDismissTask: Task<Void, Never>?
    private var undoHandler: (@MainActor @Sendable () async -> Void)?

    // ─── Launch ─────────────────────────────────────────────────────────────

    func bootstrap() async {
        Notifications.shared.onTap = { [weak self] tap in
            self?.pendingTap = tap
        }
        guard let config = ServerConfig.load() else {
            phase = .needsServer
            return
        }
        server = config
        CookieJar.restore()
        let client = APIClient(baseURL: config.baseURL)
        self.client = client
        await resumeSession(with: client)
    }

    private func resumeSession(with client: APIClient) async {
        guard CookieJar.hasSession(for: client.baseURL) else {
            phase = .signedOut
            return
        }
        do {
            guard let user = try await client.me() else {
                phase = .signedOut
                return
            }
            await enterApp(user: user, client: client)
        } catch let error as APIError where error.isAuthFailure {
            phase = .signedOut
        } catch {
            // A cold start with no network shouldn't dump the reader back to a
            // login form — the cookie is still good.
            show(error.localizedDescription, kind: .failure)
            phase = .signedOut
        }
    }

    private func enterApp(user: MeUser, client: APIClient) async {
        self.user = user
        prefs = UserPrefs.parse(user.preferences)
        BimiStore.shared.configure(client: client)
        let store = MailStore(client: client, app: self)
        mail = store
        phase = .ready
        await store.start()
    }

    // ─── Instance + credentials ─────────────────────────────────────────────

    func useServer(_ input: String) async throws {
        guard let url = ServerConfig.normalize(input) else {
            throw APIError.transport("That doesn't look like a server address.")
        }
        let candidate = APIClient(baseURL: url)
        // Probe before committing: a typo should fail here, not on the next screen.
        struct Health: Decodable { var ok: Bool }
        let health: Health = try await candidate.get("api/health")
        guard health.ok else { throw APIError.transport("That server isn't a cfmail instance.") }

        let config = ServerConfig(baseURL: url)
        config.save()
        server = config
        client = candidate
        await resumeSession(with: candidate)
    }

    func forgetServer() async {
        await signOut()
        ServerConfig.clear()
        server = nil
        client = nil
        phase = .needsServer
    }

    func signIn(email: String, password: String) async throws {
        guard let client else { throw APIError.noServer }
        switch try await client.signIn(email: email, password: password) {
        case .needsTwoFactor:
            phase = .twoFactor
        case .signedIn:
            guard let user = try await client.me() else { throw APIError.unauthorized }
            await enterApp(user: user, client: client)
        }
    }

    func verifyTwoFactor(code: String, isBackupCode: Bool) async throws {
        guard let client else { throw APIError.noServer }
        if isBackupCode {
            try await client.verifyBackupCode(code: code)
        } else {
            try await client.verifyTotp(code: code)
        }
        guard let user = try await client.me() else { throw APIError.unauthorized }
        await enterApp(user: user, client: client)
    }

    func cancelTwoFactor() {
        phase = .signedOut
    }

    func signOut() async {
        mail?.stop()
        if let client { try? await client.signOut() }
        CookieJar.clear(for: server?.baseURL)
        BackgroundRefresh.reset()
        MailboxSnapshot.clear()
        SpotlightIndex.clear()
        BimiStore.shared.reset()
        await CodeVault.clear()
        Notifications.shared.setBadge(0)
        mail = nil
        user = nil
        prefs = .empty
        phase = server == nil ? .needsServer : .signedOut
    }

    /// Any request can come back 401 if the session was revoked server-side.
    func handle(_ error: any Error) {
        if let apiError = error as? APIError, apiError.isAuthFailure {
            Task { await signOut() }
            show("Your session expired. Sign in again.", kind: .failure)
            return
        }
        if error is CancellationError { return }
        show(error.localizedDescription, kind: .failure)
    }

    // ─── Preferences ────────────────────────────────────────────────────────

    func updatePrefs(_ mutate: (inout UserPrefs) -> Void) {
        var next = prefs
        mutate(&next)
        guard next != prefs else { return }
        prefs = next
        guard let client, let encoded = next.encoded() else { return }
        Task {
            do {
                try await client.updateProfile(preferences: encoded)
            } catch {
                handle(error)
            }
        }
    }

    func updateDisplayName(_ name: String) async {
        guard let client, let trimmed = name.nilIfBlank else { return }
        do {
            try await client.updateProfile(name: trimmed)
            user?.name = trimmed
            show("Name updated.", kind: .success)
        } catch {
            handle(error)
        }
    }

    // ─── Banners ────────────────────────────────────────────────────────────

    func show(_ text: String, kind: Banner.Kind = .info, undo: (@MainActor @Sendable () async -> Void)? = nil) {
        undoHandler = undo
        banner = Banner(
            text: text, kind: kind,
            undo: undo == nil ? nil : Banner.UndoAction(title: "Undo")
        )
        bannerDismissTask?.cancel()
        bannerDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(kind == .failure ? 6 : 4))
            guard !Task.isCancelled else { return }
            self?.banner = nil
            self?.undoHandler = nil
        }
    }

    func dismissBanner() {
        bannerDismissTask?.cancel()
        banner = nil
        undoHandler = nil
    }

    func performUndo() {
        guard let handler = undoHandler else { return }
        dismissBanner()
        Task { await handler() }
    }
}
