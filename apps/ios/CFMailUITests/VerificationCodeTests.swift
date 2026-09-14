import XCTest

/// Unit coverage for the code detector. It runs in the test bundle rather than
/// against the app because it is pure logic — and because a false positive here
/// is the feature's worst failure: a wrong code offered in another app's
/// QuickType bar, with no hint of where it came from.
final class VerificationCodeTests: XCTestCase {
    // ─── Should find ────────────────────────────────────────────────────────

    func testFindsCodeInSubject() {
        XCTAssertEqual(
            VerificationCodeDetector.code(subject: "481923 is your verification code", body: ""),
            "481923"
        )
    }

    func testFindsCodeInBody() {
        XCTAssertEqual(
            VerificationCodeDetector.code(
                subject: "Sign-in attempt",
                body: "Your security code is 720518. It expires in 10 minutes."
            ),
            "720518"
        )
    }

    func testJoinsSplitCode() {
        XCTAssertEqual(
            VerificationCodeDetector.code(subject: "", body: "Your one-time passcode: 481 923"),
            "481923"
        )
    }

    func testFindsGermanCode() {
        XCTAssertEqual(
            VerificationCodeDetector.code(
                subject: "Ihr Bestätigungscode",
                body: "Ihr Code lautet 336291. Er ist 10 Minuten gültig."
            ),
            "336291"
        )
    }

    func testFindsAlphanumericCode() {
        XCTAssertEqual(
            VerificationCodeDetector.code(subject: "", body: "Verification code: A1B2C3"),
            "A1B2C3"
        )
    }

    func testPrefersTheCodeNearestTheContextWord() {
        // The order total must not win over the actual code.
        XCTAssertEqual(
            VerificationCodeDetector.code(
                subject: "",
                body: "Order 998877 shipped. Your verification code is 314159 for pickup."
            ),
            "314159"
        )
    }

    // ─── Should not find ────────────────────────────────────────────────────

    func testIgnoresMailWithNoCodeLanguage() {
        XCTAssertNil(
            VerificationCodeDetector.code(
                subject: "Invoice 4471 for September",
                body: "Your total is 6.38 and the order number is 889321."
            )
        )
    }

    func testIgnoresYears() {
        XCTAssertNil(
            VerificationCodeDetector.code(
                subject: "Security update",
                body: "Please verify your details before 2026."
            )
        )
    }

    func testIgnoresRepeatedDigits() {
        XCTAssertNil(
            VerificationCodeDetector.code(subject: "Your code", body: "------ 000000 ------")
        )
    }

    func testIgnoresAllLetterBlocks() {
        XCTAssertNil(
            VerificationCodeDetector.code(subject: "Verify", body: "PLEASE CONFIRM NOW")
        )
    }

    // ─── Service identity ───────────────────────────────────────────────────

    func testStripsTransportLabelsFromSenderDomain() {
        XCTAssertEqual(
            VerificationCodeDetector.domain(forSender: "security@accounts.github.com"),
            "github.com"
        )
        XCTAssertEqual(
            VerificationCodeDetector.domain(forSender: "no-reply@mail.notion.so"),
            "notion.so"
        )
        XCTAssertEqual(
            VerificationCodeDetector.domain(forSender: "hi@example.co.uk"),
            "example.co.uk"
        )
    }

    func testRejectsAddressesWithoutADomain() {
        XCTAssertNil(VerificationCodeDetector.domain(forSender: "broken"))
        XCTAssertNil(VerificationCodeDetector.domain(forSender: "who@localhost"))
    }

    func testServiceNamePrefersTheSenderName() {
        XCTAssertEqual(
            VerificationCodeDetector.serviceName(forDomain: "github.com", fromName: "GitHub"),
            "GitHub"
        )
        // "no-reply" is not a name anybody wants to read in a suggestion.
        XCTAssertEqual(
            VerificationCodeDetector.serviceName(forDomain: "github.com", fromName: "no-reply"),
            "Github"
        )
        XCTAssertEqual(
            VerificationCodeDetector.serviceName(forDomain: "notion.so", fromName: nil),
            "Notion"
        )
    }
}
