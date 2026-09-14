import Foundation
import SwiftUI

nonisolated enum Fmt {
    /// List-row stamp: time for today, weekday inside the last week, day+month
    /// this year, else a short numeric date. Mirrors how Mail.app abbreviates.
    static func listDate(_ date: Date, now: Date = .now) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return date.formatted(.dateTime.hour().minute())
        }
        if cal.isDateInYesterday(date) {
            return "Yesterday"
        }
        if let days = cal.dateComponents([.day], from: date, to: now).day, days < 7, days >= 0 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        if cal.component(.year, from: date) == cal.component(.year, from: now) {
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
        return date.formatted(.dateTime.day().month(.abbreviated).year(.twoDigits))
    }

    /// Header stamp inside an open message: "12 Sept 2026 at 14:03".
    static func messageDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    /// "in 3 hours" / "2 days ago" — used by reminders and scheduled sends.
    static func relative(_ date: Date, now: Date = .now) -> String {
        date.formatted(.relative(presentation: .named))
    }

    static func bytes(_ count: Int) -> String {
        count.formatted(.byteCount(style: .file))
    }

    /// Up to two initials for an avatar bubble, from a display name or address.
    static func initials(_ address: AddressObject) -> String {
        let source = address.name?.nilIfBlank ?? address.address
        let words = source
            .split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" || $0 == "-" })
            .filter { $0.first?.isLetter == true }
        if words.count >= 2, let a = words[0].first, let b = words[1].first {
            return String([a, b]).uppercased()
        }
        if let first = source.first(where: { $0.isLetter || $0.isNumber }) {
            return String(first).uppercased()
        }
        return "?"
    }

    /// Deterministic tint per correspondent so the same sender keeps a colour.
    static func avatarTint(_ address: String) -> Color {
        let palette: [Color] = [
            .indigo, .teal, .orange, .pink, .purple, .green, .blue, .brown, .mint, .cyan,
        ]
        var hash: UInt64 = 5381
        for byte in address.lowercased().utf8 { hash = (hash &* 33) &+ UInt64(byte) }
        return palette[Int(hash % UInt64(palette.count))]
    }

    /// Participant summary for a thread row ("Ada, Grace" / "Ada + 3").
    static func participants(_ people: [AddressObject], fallback: String = "(unknown)") -> String {
        let names = people.map { person -> String in
            if let name = person.name?.nilIfBlank { return name.split(separator: " ").first.map(String.init) ?? name }
            return String(person.address.prefix(while: { $0 != "@" }))
        }
        guard !names.isEmpty else { return fallback }
        if names.count <= 2 { return names.joined(separator: ", ") }
        return "\(names[0]) + \(names.count - 1)"
    }

    /// `YYYY-MM-DD` for the search API's date filters.
    static func searchDate(_ date: Date) -> String {
        date.formatted(.iso8601.year().month().day().dateSeparator(.dash))
    }

    /// Collapse a plain-text body into a one-line preview.
    static func snippet(_ text: String, limit: Int = 200) -> String {
        let flat = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return flat.count > limit ? String(flat.prefix(limit)) + "…" : flat
    }
}

nonisolated extension Color {
    /// `#rrggbb` as stored on labels and folders. Falls back to gray.
    init(hex: String) {
        var raw = hex.trimmingCharacters(in: .whitespaces)
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else {
            self = .gray
            return
        }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

nonisolated extension AiCategory {
    var title: String {
        switch self {
        case .personal: "Personal"
        case .newsletter: "Newsletter"
        case .promotion: "Promotion"
        case .shipping: "Shipping"
        case .receipt: "Receipt"
        case .finance: "Finance"
        case .travel: "Travel"
        case .social: "Social"
        case .security: "Security"
        case .update: "Update"
        case .notification: "Notification"
        case .calendar: "Calendar"
        case .other: "Other"
        }
    }

    var symbol: String {
        switch self {
        case .personal: "person"
        case .newsletter: "newspaper"
        case .promotion: "tag"
        case .shipping: "shippingbox"
        case .receipt: "receipt"
        case .finance: "creditcard"
        case .travel: "airplane"
        case .social: "bubble.left.and.bubble.right"
        case .security: "lock.shield"
        case .update: "arrow.trianglehead.2.clockwise"
        case .notification: "bell"
        case .calendar: "calendar"
        case .other: "envelope"
        }
    }

    var tint: Color {
        switch self {
        case .personal: .blue
        case .newsletter: .indigo
        case .promotion: .pink
        case .shipping: .orange
        case .receipt: .teal
        case .finance: .green
        case .travel: .cyan
        case .social: .purple
        case .security: .red
        case .update: .gray
        case .notification: .yellow
        case .calendar: .mint
        case .other: .secondary
        }
    }
}

nonisolated extension MailboxType {
    var symbol: String {
        switch self {
        case .personal: "person.crop.circle"
        case .group: "person.2"
        case .service: "gearshape.2"
        case .temp: "clock.badge.exclamationmark"
        }
    }

    var title: String {
        switch self {
        case .personal: "Personal"
        case .group: "Shared"
        case .service: "Service"
        case .temp: "Disposable"
        }
    }
}
