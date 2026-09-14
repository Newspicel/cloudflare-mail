import Contacts
import OSLog
import SwiftUI

/// The device address book, used to put real names and faces on correspondents.
///
/// Off until the reader turns it on in Settings. Mail apps that read Contacts
/// the moment they launch are why the permission prompt is so tiresome; this
/// one asks when somebody asks it to, and does nothing at all otherwise.
///
/// Lookups are by email address, cached both ways — a hit and a miss — because
/// a list scrolls past the same handful of correspondents constantly.
@MainActor @Observable
final class SystemContacts {
    static let shared = SystemContacts()

    nonisolated private static let log = Logger(subsystem: "dev.newspicel.cfmail", category: "contacts")
    private static let enabledKey = "cfmail.useSystemContacts"

    private var names: [String: String] = [:]
    private var images: [String: UIImage] = [:]
    private var checked: Set<String> = []

    @ObservationIgnored private let store = CNContactStore()

    /// Whether the reader has opted in. Turning it off forgets everything read.
    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
            if !isEnabled { forgetEverything() }
        }
    }

    private init() {
        isEnabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    var authorization: CNAuthorizationStatus {
        CNContactStore.authorizationStatus(for: .contacts)
    }

    /// Ask for access and switch the feature on if granted. Returns the result
    /// so the settings toggle can snap back when the answer is no.
    @discardableResult
    func enable() async -> Bool {
        switch authorization {
        case .authorized:
            isEnabled = true
        case .notDetermined:
            let granted = (try? await store.requestAccess(for: .contacts)) ?? false
            isEnabled = granted
        case .limited:
            // A limited selection is a perfectly good answer — use what we're given.
            isEnabled = true
        default:
            isEnabled = false
        }
        return isEnabled
    }

    // ─── Lookup ─────────────────────────────────────────────────────────────

    func name(for address: String) -> String? {
        guard isEnabled else { return nil }
        return names[key(address)]
    }

    func image(for address: String) -> UIImage? {
        guard isEnabled else { return nil }
        return images[key(address)]
    }

    /// Resolve an address against the address book. Cheap to call repeatedly.
    func prefetch(_ address: String) {
        guard isEnabled, authorizationAllows else { return }
        let key = key(address)
        guard !key.isEmpty, !checked.contains(key) else { return }
        checked.insert(key)

        // `CNContactStore` isn't `Sendable`, so the background lookup makes its
        // own. Results are cached, so this is a handful of instantiations, not
        // one per row.
        Task.detached(priority: .utility) {
            let match = Self.lookup(address: key)
            guard let match else { return }
            await MainActor.run {
                if let name = match.name { self.names[key] = name }
                if let data = match.imageData, let image = UIImage(data: data) {
                    self.images[key] = image
                }
            }
        }
    }

    private var authorizationAllows: Bool {
        let status = authorization
        return status == .authorized || status == .limited
    }

    private nonisolated static func lookup(address: String) -> (name: String?, imageData: Data?)? {
        let store = CNContactStore()
        let keys: [any CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactThumbnailImageDataKey as CNKeyDescriptor,
        ]
        do {
            let matches = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(matchingEmailAddress: address),
                keysToFetch: keys
            )
            guard let contact = matches.first else { return nil }
            return (CNContactFormatter.string(from: contact, style: .fullName), contact.thumbnailImageData)
        } catch {
            log.debug("contacts lookup failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func key(_ address: String) -> String {
        address.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private func forgetEverything() {
        names.removeAll()
        images.removeAll()
        checked.removeAll()
    }
}
