import CryptoKit
import XCTest

/// End-to-end smoke test against a running cfmail instance.
///
/// Point it at one with environment variables (defaults match `wrangler dev`):
///
///     CFMAIL_TEST_SERVER=http://localhost:8787 \
///     CFMAIL_TEST_EMAIL=you@example.com \
///     CFMAIL_TEST_PASSWORD=… \
///     xcodebuild test -scheme CFMail -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
///
/// Add `CFMAIL_TEST_TOTP_SECRET` (the base32 secret from the account's
/// authenticator setup) when the account has two-factor enabled.
///
/// It signs in, reads the list, opens a conversation and raises the composer —
/// the paths that break first when the API contract moves.
final class MailFlowUITests: XCTestCase {
    private var app: XCUIApplication!

    private var server: String {
        ProcessInfo.processInfo.environment["CFMAIL_TEST_SERVER"] ?? "http://localhost:8787"
    }

    private var email: String {
        ProcessInfo.processInfo.environment["CFMAIL_TEST_EMAIL"] ?? "demo@local.test"
    }

    private var password: String {
        ProcessInfo.processInfo.environment["CFMAIL_TEST_PASSWORD"] ?? "demo-password-123"
    }

    /// Base32 TOTP secret for an account with two-factor on. Set it to cover
    /// the second-factor step; leave it unset and the test expects a
    /// single-step sign-in.
    private var totpSecret: String? {
        ProcessInfo.processInfo.environment["CFMAIL_TEST_TOTP_SECRET"]?
            .trimmingCharacters(in: .whitespaces).nilIfEmpty
    }

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    /// The app asks for notification permission the first time the mail UI
    /// appears; the system alert sits above everything until it's answered.
    private func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don't Allow", "OK"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                return
            }
        }
    }

    func testSignInReadAndCompose() throws {
        signInIfNeeded()

        // ─── The list ───────────────────────────────────────────────────────
        dismissSystemAlerts()
        let deploy = threadRow("Deploy pipeline is green again")
        XCTAssertTrue(deploy.waitForExistence(timeout: 40), "seeded thread missing from the list")
        attach(name: "01-thread-list")

        // ─── The reader ─────────────────────────────────────────────────────
        deploy.tap()
        let reader = app.staticTexts["Grace Hopper"]
        XCTAssertTrue(reader.waitForExistence(timeout: 20), "conversation didn't open")
        // The newest message is opened for you; its body is fetched separately
        // from the raw .eml, so give it a beat.
        XCTAssertTrue(
            app.staticTexts["Shipped. Rollout took 40 seconds, no errors in the tail."]
                .waitForExistence(timeout: 15),
            "the open message's body never rendered"
        )
        attach(name: "02-thread-detail")

        // Expanding the first message pulls in an HTML body, which renders in a
        // web view rather than as text.
        // Older messages in the thread are collapsed; opening the first one
        // pulls in an HTML body, which renders in a web view rather than text.
        let collapsed = app.descendants(matching: .any)
            .matching(identifier: "message.collapsed").firstMatch
        if collapsed.waitForExistence(timeout: 5) {
            collapsed.tap()
            let rendered = app.webViews.firstMatch.waitForExistence(timeout: 20)
            attach(name: "02b-html-body")
            XCTAssertTrue(rendered, "HTML body didn't render")
        }

        // ─── The composer ───────────────────────────────────────────────────
        let reply = app.buttons["Reply"].firstMatch
        if reply.waitForExistence(timeout: 10) {
            reply.tap()
            XCTAssertTrue(
                app.navigationBars["Reply"].waitForExistence(timeout: 15),
                "composer didn't open for a reply"
            )
            attach(name: "03-compose-reply")
            app.buttons["Cancel"].firstMatch.tap()
            // Cancelling a reply with a quoted body asks what to do with it.
            let discard = app.buttons["Delete Draft"].firstMatch
            if discard.waitForExistence(timeout: 4) { discard.tap() }
        }

        // ─── Back to the list ───────────────────────────────────────────────
        goBack()
        var returned = threadRow("Deploy pipeline is green again").waitForExistence(timeout: 15)
        if !returned {
            // The composer's dismissal can swallow the first tap.
            goBack()
            returned = threadRow("Deploy pipeline is green again").waitForExistence(timeout: 15)
        }
        attach(name: "04-back-in-list")
        XCTAssertTrue(returned, "didn't return to the list")
    }

    func testSidebarAndSettings() throws {
        signInIfNeeded()
        dismissSystemAlerts()
        XCTAssertTrue(
            app.staticTexts["Deploy pipeline is green again"].waitForExistence(timeout: 40),
            "thread list never appeared"
        )

        // The sidebar is the split view's first column; on iPhone it's behind
        // the leading navigation-bar button.
        let sidebarButton = app.navigationBars.buttons.element(boundBy: 0)
        if sidebarButton.exists, sidebarButton.isHittable {
            sidebarButton.tap()
            XCTAssertTrue(
                app.staticTexts["ada@local.test"].waitForExistence(timeout: 10)
                    || app.staticTexts["Mailboxes"].waitForExistence(timeout: 10),
                "sidebar didn't show mailboxes"
            )
            attach(name: "05-sidebar")

            let settings = app.buttons["Settings"].firstMatch
            if settings.waitForExistence(timeout: 5) {
                settings.tap()
                XCTAssertTrue(
                    app.navigationBars["Settings"].waitForExistence(timeout: 10),
                    "settings didn't open"
                )
                attach(name: "06-settings")
            }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private func signInIfNeeded() {
        let serverField = app.textFields["server.address"]
        if serverField.waitForExistence(timeout: 15) {
            serverField.tap()
            serverField.typeText(server)
            app.buttons["server.continue"].tap()
        }

        let emailField = app.textFields["signin.email"]
        guard emailField.waitForExistence(timeout: 20) else {
            // Already signed in from a previous run — nothing to do.
            return
        }
        emailField.tap()
        emailField.typeText(email)
        let passwordField = app.secureTextFields["signin.password"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 5), "no password field")
        passwordField.tap()
        passwordField.typeText(password)
        app.buttons["signin.submit"].tap()
        completeTwoFactorIfNeeded()
    }

    /// Better Auth runs its CSRF origin check on any request carrying a cookie,
    /// so the second factor is the first call that fails when the client sends
    /// no `Origin` header. Worth walking for real.
    private func completeTwoFactorIfNeeded() {
        let field = app.textFields["twofactor.code"]
        guard field.waitForExistence(timeout: 10) else { return }
        guard let secret = totpSecret else {
            XCTFail("the account asks for a second factor; set CFMAIL_TEST_TOTP_SECRET")
            return
        }
        field.tap()
        field.typeText(Self.totpCode(secret: secret))
        // Six digits submit on their own; the button is the fallback.
        let verify = app.buttons["twofactor.verify"]
        if verify.exists, verify.isHittable { verify.tap() }
    }

    /// RFC 6238, 30-second step, 6 digits, SHA-1 — what authenticator apps use.
    private static func totpCode(secret: String, at date: Date = .now) -> String {
        guard let key = base32Decode(secret) else { return "000000" }
        var counter = UInt64(date.timeIntervalSince1970 / 30).bigEndian
        let message = withUnsafeBytes(of: &counter) { Data($0) }
        let digest = Array(HMAC<Insecure.SHA1>.authenticationCode(
            for: message, using: SymmetricKey(data: key)
        ))
        let offset = Int(digest[digest.count - 1] & 0x0F)
        let truncated = (UInt32(digest[offset] & 0x7F) << 24)
            | (UInt32(digest[offset + 1]) << 16)
            | (UInt32(digest[offset + 2]) << 8)
            | UInt32(digest[offset + 3])
        return String(format: "%06u", truncated % 1_000_000)
    }

    private static func base32Decode(_ input: String) -> Data? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bits = 0
        var value = 0
        var output = Data()
        for character in input.uppercased() where character != "=" {
            guard let index = alphabet.firstIndex(of: character) else { return nil }
            value = (value << 5) | index
            bits += 5
            if bits >= 8 {
                output.append(UInt8((value >> (bits - 8)) & 0xFF))
                bits -= 8
            }
        }
        return output
    }

    /// Pops the top screen. A back button is labelled with the previous title;
    /// `app.navigationBars.buttons` spans every bar still in the hierarchy, so
    /// picking by index reaches the screen underneath instead.
    private func goBack() {
        for title in ["All Inboxes", "Inbox", "Mailboxes"] {
            let named = app.navigationBars.buttons[title]
            if named.exists, named.isHittable {
                named.tap()
                return
            }
        }
        let bars = app.navigationBars
        guard bars.count > 0 else { return }
        let top = bars.element(boundBy: bars.count - 1).buttons.element(boundBy: 0)
        if top.exists { top.tap() }
    }

    /// A list row, matched on the identifier `ThreadRow` sets from the subject.
    /// The row combines its children for VoiceOver, so the subject is not a
    /// standalone element to match on.
    private func threadRow(_ subject: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: subject).firstMatch
    }

    private func attach(name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}


private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}