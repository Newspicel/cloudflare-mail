import AuthenticationServices
import Foundation
import OSLog

/// Where found verification codes live between the app finding them and the
/// AutoFill extension handing them to whatever asked.
///
/// The store is the shared Keychain group both targets declare, so there's no
/// app group to register and the codes sit behind the same protection as the
/// session cookie. Entries are pruned on every read and write: a code older
/// than `VerificationCode.lifetime` is gone, not merely hidden.
nonisolated enum CodeVault {
    private static let key = "cfmail.otp"
    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "otp")
    private static let maximum = 20

    static func load() -> [VerificationCode] {
        guard let data = Keychain.get(key, accessGroup: Keychain.sharedAccessGroup),
              let stored = try? JSONDecoder().decode([VerificationCode].self, from: data)
        else { return [] }
        return stored.filter(\.isLive).sorted { $0.receivedAt > $1.receivedAt }
    }

    private static func save(_ codes: [VerificationCode]) {
        let live = Array(codes.filter(\.isLive).sorted { $0.receivedAt > $1.receivedAt }.prefix(maximum))
        guard let data = try? JSONEncoder().encode(live) else { return }
        Keychain.set(data, for: key, accessGroup: Keychain.sharedAccessGroup)
    }

    /// Add a code and republish the AutoFill identities. Returns false when the
    /// code was already known, so callers don't re-notify.
    @discardableResult
    static func add(_ code: VerificationCode) async -> Bool {
        var codes = load()
        guard !codes.contains(where: { $0.messageId == code.messageId }) else { return false }
        codes.append(code)
        save(codes)
        await publish(codes)
        return true
    }

    /// Drop expired entries and re-publish. Cheap enough to call on launch and
    /// whenever the app comes forward.
    static func prune() async {
        let codes = load()
        save(codes)
        await publish(codes)
    }

    static func clear() async {
        Keychain.remove(key, accessGroup: Keychain.sharedAccessGroup)
        try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
    }

    static func code(forRecord identifier: String) -> VerificationCode? {
        load().first { $0.id == identifier }
    }

    // ─── AutoFill identities ────────────────────────────────────────────────

    /// Hand the current set to iOS so the codes appear in the QuickType bar of
    /// whatever site or app is asking for them. Silently does nothing when the
    /// reader hasn't enabled cfmail under Passwords → AutoFill.
    static func publish(_ codes: [VerificationCode]) async {
        let state = await ASCredentialIdentityStore.shared.state()
        guard state.isEnabled else { return }

        let identities = codes.filter(\.isLive).map { code in
            ASOneTimeCodeCredentialIdentity(
                serviceIdentifier: ASCredentialServiceIdentifier(identifier: code.domain, type: .domain),
                label: code.label,
                recordIdentifier: code.id
            )
        }
        do {
            // Replace rather than merge: expiry is the whole point, and a stale
            // suggestion is worse than no suggestion.
            try await ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities)
        } catch {
            log.debug("could not publish codes: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Whether the reader has turned cfmail on as an AutoFill provider.
    static func isAutoFillEnabled() async -> Bool {
        await ASCredentialIdentityStore.shared.state().isEnabled
    }
}
