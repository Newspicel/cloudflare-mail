import SwiftUI

/// The inbox categories Mail groups messages into, mapped onto the AI taxonomy
/// the Worker already assigns (`AI_CATEGORIES` in packages/db/src/enums.ts).
///
/// The server's taxonomy is finer-grained than four buckets, which is the point:
/// the chips on a row keep saying "Receipt" or "Shipping" while the tab bar
/// groups them the way a reader triages. Only offered when a mailbox has AI
/// features on — without them every message is uncategorised and the control
/// would be four tabs over one pile.
enum MailCategory: String, CaseIterable, Identifiable, Hashable {
    case all
    case primary
    case transactions
    case updates
    case promotions

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All Mail"
        case .primary: "Primary"
        case .transactions: "Transactions"
        case .updates: "Updates"
        case .promotions: "Promotions"
        }
    }

    /// Short form for the tab strip, where four labels have to share a row.
    var shortTitle: String {
        switch self {
        case .all: "All"
        default: title
        }
    }

    var symbol: String {
        switch self {
        case .all: "tray"
        case .primary: "person"
        case .transactions: "cart"
        case .updates: "megaphone"
        case .promotions: "tag"
        }
    }

    var tint: Color {
        switch self {
        case .all: .gray
        case .primary: .blue
        case .transactions: .green
        case .updates: .purple
        case .promotions: .pink
        }
    }

    /// Which AI categories land in this bucket. `nil` (never scored) reads as
    /// Primary so a message is never hidden by a classifier that didn't run.
    func contains(_ category: AiCategory?) -> Bool {
        guard self != .all else { return true }
        guard let category else { return self == .primary }
        return Self.bucket(for: category) == self
    }

    static func bucket(for category: AiCategory) -> MailCategory {
        switch category {
        case .personal, .other:
            .primary
        case .receipt, .finance, .shipping, .travel, .calendar:
            .transactions
        case .newsletter, .update, .notification, .security:
            .updates
        case .promotion, .social:
            .promotions
        }
    }

    /// The tabs worth showing, in Mail's order.
    static let tabs: [MailCategory] = [.all, .primary, .transactions, .updates, .promotions]
}
