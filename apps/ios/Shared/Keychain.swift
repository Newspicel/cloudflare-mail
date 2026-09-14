import Foundation
import Security

/// Minimal generic-password wrapper. The session cookie is a bearer credential
/// in all but name, so it lives here rather than in UserDefaults.
///
/// Items written with `accessGroup: .shared` are readable by the AutoFill
/// extension too — that's how a verification code reaches the QuickType bar
/// without a shared container.
nonisolated enum Keychain {
    private static let service = "dev.newspicel.cfmail"

    /// The team-prefixed group both targets declare in their entitlements.
    /// `$(AppIdentifierPrefix)` resolves at build time, so the literal here is
    /// only the suffix and the system matches it against the entitlement.
    static let sharedAccessGroup = "dev.newspicel.cfmail.shared"

    static func set(_ data: Data, for key: String, accessGroup: String? = nil) {
        var query = baseQuery(key, accessGroup: accessGroup)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        // After-first-unlock is the ceiling here: the background refresh reads
        // the session cookie and writes verification codes while the phone is
        // locked. `ThisDeviceOnly` keeps both out of iCloud Keychain and out of
        // a backup restored onto someone else's device.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(_ key: String, accessGroup: String? = nil) -> Data? {
        var query = baseQuery(key, accessGroup: accessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func remove(_ key: String, accessGroup: String? = nil) {
        SecItemDelete(baseQuery(key, accessGroup: accessGroup) as CFDictionary)
    }

    private static func baseQuery(_ key: String, accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
