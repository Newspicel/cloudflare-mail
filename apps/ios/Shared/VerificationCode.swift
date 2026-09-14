import Foundation

/// A one-time code found in an email, and the service it belongs to.
nonisolated struct VerificationCode: Codable, Sendable, Hashable, Identifiable {
    /// Stable handle shared with `ASOneTimeCodeCredentialIdentity`.
    var id: String
    var code: String
    /// Domain the code is for, matched against the site or app asking for it.
    var domain: String
    /// Human name for the QuickType suggestion ("GitHub").
    var service: String
    var subject: String
    var messageId: String
    var mailboxId: String
    var receivedAt: Date

    /// Codes are short-lived by design; anything older is noise in the
    /// QuickType bar and a small liability in the Keychain.
    static let lifetime: TimeInterval = 15 * 60

    var isLive: Bool { Date.now.timeIntervalSince(receivedAt) < Self.lifetime }

    /// What iOS shows under the code in the AutoFill suggestion.
    var label: String { "\(code) — \(service)" }
}

/// Finds verification codes in inbound mail.
///
/// Deliberately conservative: a bare number is not a code. There has to be a
/// word nearby that says so, in the subject or within a short window of the
/// match, and shapes that are obviously something else (years, money, times,
/// long digit runs) are rejected. A false positive here puts a wrong code in
/// somebody's QuickType bar, so the bar is set high.
nonisolated enum VerificationCodeDetector {
    /// Context words, English and German — the two languages this instance's
    /// owner is most likely to receive these in. Matching is case-insensitive.
    private static let contextWords = [
        "verification", "verify", "verification code", "security code", "one-time",
        "one time", "onetime", "otp", "passcode", "pass code", "access code",
        "confirmation code", "confirm", "authentication", "authenticate", "2fa",
        "two-factor", "two factor", "sign-in code", "sign in code", "login code",
        "temporary code", "your code", "code is", "single-use",
        // German
        "bestätigungscode", "bestätigung", "sicherheitscode", "verifizierung",
        "einmalcode", "einmal-code", "zugangscode", "anmeldecode", "dein code",
        "ihr code",
    ]

    /// 4–8 digits, optionally split once by a space or hyphen ("123 456"), or a
    /// 6–8 character alphanumeric block that isn't a plain word. Computed
    /// rather than stored: `Regex` isn't `Sendable`.
    private static var pattern: Regex<(Substring, Substring)> {
        /\b([0-9]{3,4}[ -]?[0-9]{3,4}|[0-9]{4,8}|[A-Z0-9]{6,8})\b/
    }

    /// Never treat these as codes even when the shape matches.
    private static let rejected: Set<String> = ["000000", "111111", "123456", "12345678"]

    struct Candidate: Sendable, Hashable {
        var code: String
        /// Higher wins when a message contains several shapes.
        var score: Int
    }

    /// Extract the most likely code from a message, or nil.
    static func code(subject: String, body: String) -> String? {
        let haystack = "\(subject)\n\(body)"
        guard mentionsCode(haystack) else { return nil }

        var best: Candidate?
        // The subject is the strongest signal — senders put the code there
        // precisely so it can be read without opening the mail.
        for candidate in candidates(in: subject, bonus: 40) + candidates(in: body, bonus: 0) {
            if best == nil || candidate.score > best!.score { best = candidate }
        }
        return best?.code
    }

    private static func mentionsCode(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return contextWords.contains { lowered.contains($0) }
    }

    private static func candidates(in text: String, bonus: Int) -> [Candidate] {
        let lowered = text.lowercased()
        var found: [Candidate] = []
        for match in text.matches(of: pattern) {
            let raw = String(match.output.1)
            let normalized = raw.replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: "-", with: "")
            guard isPlausible(normalized) else { continue }

            // Proximity to a context word is most of the signal: "your code is
            // 481923" scores far above a stray number in a footer.
            let distance = nearestContextDistance(to: match.range, in: text, lowered: lowered)
            var score = bonus
            score += max(0, 60 - distance / 2)
            if normalized.count == 6 { score += 20 }
            if normalized.allSatisfy(\.isNumber) { score += 10 }
            found.append(Candidate(code: normalized, score: score))
        }
        return found
    }

    private static func isPlausible(_ code: String) -> Bool {
        guard (4...8).contains(code.count), !rejected.contains(code) else { return false }
        // A run of one repeated character is a separator, not a code.
        if Set(code).count == 1 { return false }
        if code.allSatisfy(\.isNumber) {
            // Four digits that look like a recent year are almost always a year.
            if code.count == 4, let year = Int(code), (1990...2100).contains(year) { return false }
            return true
        }
        // Mixed alphanumerics only count when they actually mix — an all-letter
        // block is a word in a shouty heading.
        return code.contains(where: \.isNumber) && code.contains(where: \.isLetter)
    }

    private static func nearestContextDistance(
        to range: Range<String.Index>, in text: String, lowered: String
    ) -> Int {
        let position = text.distance(from: text.startIndex, to: range.lowerBound)
        var nearest = Int.max
        for word in contextWords {
            var searchStart = lowered.startIndex
            while let hit = lowered.range(of: word, range: searchStart..<lowered.endIndex) {
                let at = lowered.distance(from: lowered.startIndex, to: hit.lowerBound)
                nearest = min(nearest, abs(position - at))
                searchStart = hit.upperBound
            }
        }
        return nearest == .max ? 999 : nearest
    }

    // ─── Which service the code belongs to ──────────────────────────────────

    /// Mail-transport labels that say nothing about the service itself.
    private static let noiseLabels: Set<String> = [
        "mail", "email", "e-mail", "mailer", "smtp", "mg", "sg", "em",
        "noreply", "no-reply", "notify", "notifications", "notification",
        "accounts", "account", "auth", "login", "id", "security", "alerts",
        "send", "sender", "mandrillapp", "sparkpostmail", "bounce", "bounces",
    ]

    /// The domain to register the code against, derived from the sender.
    /// `security@accounts.github.com` → `github.com`.
    static func domain(forSender address: String) -> String? {
        guard let at = address.lastIndex(of: "@") else { return nil }
        let host = address[address.index(after: at)...]
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        guard host.contains("."), !host.isEmpty else { return nil }

        var labels = host.split(separator: ".").map(String.init)
        // Strip transport-ish prefixes, but never below two labels.
        while labels.count > 2, let first = labels.first, noiseLabels.contains(first) {
            labels.removeFirst()
        }
        return labels.joined(separator: ".")
    }

    /// A readable name for the QuickType row: "github.com" → "Github".
    static func serviceName(forDomain domain: String, fromName: String?) -> String {
        if let name = fromName?.trimmingCharacters(in: .whitespaces), !name.isEmpty,
           !name.lowercased().contains("no-reply"), !name.lowercased().contains("noreply"),
           !name.contains("@") {
            return name
        }
        guard let first = domain.split(separator: ".").first, !first.isEmpty else { return domain }
        return first.prefix(1).uppercased() + first.dropFirst()
    }
}
