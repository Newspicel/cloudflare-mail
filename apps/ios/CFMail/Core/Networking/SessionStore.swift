import Foundation
import Synchronization

/// Where the instance lives. There is no hosted service to discover — every
/// deployment is somebody's own Worker — so the base URL is user-supplied and
/// remembered across launches.
nonisolated struct ServerConfig: Codable, Sendable, Hashable {
    var baseURL: URL

    private static let key = "cfmail.server"

    static func load() -> ServerConfig? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.key)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Accepts "mail.example.com", "https://mail.example.com/", "http://localhost:8787".
    /// Returns nil when the input can't become an absolute http(s) origin.
    static func normalize(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var comps = URLComponents(string: text),
              let scheme = comps.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = comps.host, !host.isEmpty
        else { return nil }
        comps.scheme = scheme
        // The API is always mounted at the origin root; drop any path/query the
        // user pasted along from a browser address bar.
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }
}

/// Session cookies, persisted between launches.
///
/// Better Auth authenticates with a signed cookie (30-day expiry, `sameSite=lax`),
/// so the app's whole credential is whatever the cookie jar holds for the
/// instance's host. `URLSession` keeps that in memory happily but only persists
/// it on its own terms, so the jar is snapshotted into the Keychain after any
/// request that could have changed it, and restored on launch.
nonisolated enum CookieJar {
    private static let key = "cfmail.cookies"

    private struct Stored: Codable, Sendable {
        var name: String
        var value: String
        var domain: String
        var path: String
        var expires: Date?
        var isSecure: Bool
        var isHTTPOnly: Bool
    }

    /// Fingerprint of what was last written, so the common case (an unchanged
    /// cookie) costs a string compare instead of a Keychain write on every
    /// single API response.
    private static let lastWritten = Mutex<String?>(nil)

    static func save(for url: URL) {
        let jar = HTTPCookieStorage.shared
        let cookies = (jar.cookies(for: url) ?? []).sorted { $0.name < $1.name }
        let fingerprint = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: ";")
        let changed = lastWritten.withLock { stored -> Bool in
            guard stored != fingerprint else { return false }
            stored = fingerprint
            return true
        }
        guard changed else { return }

        let stored = cookies.map {
            Stored(
                name: $0.name, value: $0.value, domain: $0.domain, path: $0.path,
                expires: $0.expiresDate, isSecure: $0.isSecure, isHTTPOnly: $0.isHTTPOnly
            )
        }
        guard let data = try? JSONEncoder().encode(stored) else { return }
        Keychain.set(data, for: key)
    }

    static func restore() {
        guard let data = Keychain.get(key),
              let stored = try? JSONDecoder().decode([Stored].self, from: data)
        else { return }
        let jar = HTTPCookieStorage.shared
        for s in stored {
            // A cookie whose expiry has passed is dead weight; let it lapse.
            if let expires = s.expires, expires < Date() { continue }
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: s.name,
                .value: s.value,
                .domain: s.domain,
                .path: s.path.isEmpty ? "/" : s.path,
            ]
            if let expires = s.expires { props[.expires] = expires }
            if s.isSecure { props[.secure] = "TRUE" }
            if let cookie = HTTPCookie(properties: props) { jar.setCookie(cookie) }
        }
    }

    static func clear(for url: URL?) {
        let jar = HTTPCookieStorage.shared
        if let url, let cookies = jar.cookies(for: url) {
            for cookie in cookies { jar.deleteCookie(cookie) }
        }
        Keychain.remove(key)
        lastWritten.withLock { $0 = nil }
    }

    /// True when the jar holds a Better Auth session cookie for this origin.
    static func hasSession(for url: URL) -> Bool {
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        return cookies.contains { $0.name.contains("session_token") && !$0.value.isEmpty }
    }
}
