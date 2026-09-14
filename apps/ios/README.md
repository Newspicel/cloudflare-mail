# cfmail for iOS

A native SwiftUI client for a cfmail instance. It talks to the same Worker the
web app does — the REST API under `/api`, and the `UserHub` SSE stream for live
updates — so there is nothing new to deploy: point it at your instance and sign
in.

```
open apps/ios/CFMail.xcodeproj
```

## Signing

The project ships without a team, so set yours once (Signing & Capabilities, or
`DEVELOPMENT_TEAM=… xcodebuild … -allowProvisioningUpdates`) before building to
a device. `PRODUCT_BUNDLE_IDENTIFIER` is `dev.cfmail.CFMail`.

## Requirements

| | |
| --- | --- |
| Xcode | 26.6 or newer |
| Deployment target | iOS 26.0 (`IPHONEOS_DEPLOYMENT_TARGET`) |
| Language | Swift 6, strict concurrency, default `MainActor` isolation |
| Dependencies | none — Foundation, SwiftUI, WebKit, UserNotifications, BackgroundTasks |

The project has no package manager and no generated files: `CFMail.xcodeproj`
uses Xcode's synchronized folder groups, so adding a `.swift` file anywhere
under `CFMail/` is enough — there is no file list to keep in sync.

## What's in it

- **Sign-in** — server discovery (`/api/health`), Better Auth email + password,
  the TOTP / backup-code second factor, password reset. The session cookie is
  kept in the Keychain and restored on launch. Every request declares `Origin`:
  Better Auth runs its CSRF origin check on anything carrying a cookie, and a
  native client has no browser to set that header for it.
- **Mail** — Mail's own shape: a Mailboxes screen with All Inboxes, Starred,
  Drafts, Sent, Spam, Trash and All Mail across every mailbox plus a
  collapsible section per mailbox; a large-title list with the category strip,
  pull-to-reveal search, Mail's swipe set (read/unread, trash, star, move), an
  edit mode with Mark / Move / Trash, cursor paging and undo on every
  destructive move. iPad gets the three columns.
- **Reader** — one card per message, previous/next arrows through the list,
  sanitized HTML in a `WKWebView` (remote images still routed through the
  server's proxy, text at the reader's Dynamic Type size), plain-text
  fallback, attachments via QuickLook, `.eml` export, and the banners the
  server's data earns: spam verdict and reasons, PGP state, tracker count,
  calendar invite, one-click unsubscribe.
- **Compose** — recipient tokens with contact completion and a ⊕ contact
  picker, the folded Cc/Bcc/From line, attachments (photos and files),
  server-side draft autosave, send later, "remind me if no reply", and a
  blocked-recipient warning before you hit send.
- **Organisation** — labels, personal folders, rules (full condition/action
  editor), reminders, and a contacts list built from who you actually
  correspond with (`GET /api/contacts`).
- **Settings** — per-mailbox identity, signature, spam level, AI features, PGP
  mode and correspondent keys, notification tiers, IMAP app passwords,
  disposable addresses.
- **Live updates** — the SSE stream drives the list, the unread badges and
  notification dismissal; it reconnects with backoff and resumes on foreground.

## System integration

Where iOS already has an answer, the app uses it rather than inventing one.

- **Verification-code AutoFill** — when a one-time code arrives, cfmail offers
  it above the keyboard in whatever app or site asked for it, the way Messages
  does for SMS. See below; it needs one switch turned on.
- **Sender brand logos (BIMI)** — the Worker resolves a sender domain's BIMI
  record, sanitizes the SVG and caches it (`worker/src/mail/bimi.ts`); the app
  renders each logo once offscreen and keeps the bitmap, because nothing on iOS
  decodes SVG and a list must not touch a web view to draw a row. The logo is
  decoration: the mark certificate is never verified, and nothing about it
  feeds the trust banners.
- **Contacts** — opt in under Settings and senders are matched against the
  device address book for the name and face you already have. Nothing is read
  until you turn it on, and a contact photo outranks a brand logo.
- **Inbox categories** — the AI category the Worker already assigns is grouped
  into Primary / Transactions / Updates / Promotions, shown only for mailboxes
  that actually classify mail.
- **Shortcuts and Siri** — open a mailbox, start a message, search, or ask how
  much unread mail is waiting. The unread query answers without opening the app.
- **Focus filters** — pick a mailbox per Focus: during that Focus the app opens
  on it, and the other mailboxes' notifications are held back.
- **Spotlight** — conversations are indexed (participants, subject, AI gist —
  never message bodies) and a result opens the thread. The index is torn down on
  sign-out.
- **Handoff** — an open conversation is offered to your other devices, and
  carries a web URL so a Mac without the app hands off to the instance's web app
  at the same thread.
- **Writing Tools, Live Text, Quick Look, Dynamic Type, VoiceOver** — inherited
  by using the system's own text, preview and layout components.

## Verification codes

`CFMailAutoFill` is an AutoFill Credential Provider extension that offers
one-time codes found in your mail. The app scans inbound messages for a code
(conservatively — there has to be code-ish language nearby, and shapes like
years and order numbers are rejected), stores it in a Keychain group shared with
the extension, and registers an `ASOneTimeCodeCredentialIdentity` against the
sender's domain. iOS does the rest. Codes expire after 15 minutes, never leave
the device, and are wiped on sign-out.

Two things have to be true for it to work:

1. **Signing.** The capability needs a provisioning profile that carries
   `com.apple.developer.authentication-services.autofill-credential-provider`
   and the `dev.cfmail.shared` Keychain group. Sign into Xcode
   (Settings → Accounts) and build once — automatic signing adds both. Without
   an account signed in, `xcodebuild` can't create the profile and the build
   fails on that capability; building with `CODE_SIGN_ENTITLEMENTS` pointed at
   an empty plist produces a working app with the feature inert.
2. **The switch.** Settings → General → AutoFill & Passwords → turn on
   **cfmail**. Settings → Verification codes inside the app shows whether it's
   on, and lists what's currently live.

## Notifications

The Worker's push path is Web Push (VAPID), which iOS only delivers to a web app
added to the Home Screen — a native build can't subscribe to it. So alerts are
raised on-device instead:

- while the app is running, from the SSE stream;
- otherwise from a `BGAppRefreshTask` that compares unread threads against what
  it has already announced.

Both honour the per-mailbox, per-priority tiers stored on the server
(`/api/push/mailboxes`), so a mailbox set to "silent" stays silent. Background
refresh is opportunistic — iOS decides when it runs. Real push would need an
APNs sender in the Worker (a device-token table, a token-signed JWT, and a fan-out
alongside `mail/push.ts`); that isn't built.

## Running the UI tests

`CFMailUITests` signs in against a live instance — including the second factor —
reads a conversation and opens the composer. Point it at one:

```sh
TEST_RUNNER_CFMAIL_TEST_SERVER=http://localhost:8787 \
TEST_RUNNER_CFMAIL_TEST_EMAIL=you@example.com \
TEST_RUNNER_CFMAIL_TEST_PASSWORD=… \
TEST_RUNNER_CFMAIL_TEST_TOTP_SECRET=…base32… \
xcodebuild test -project apps/ios/CFMail.xcodeproj -scheme CFMail \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

The `TEST_RUNNER_` prefix is how `xcodebuild` forwards a variable into the test
runner; it's stripped before the test sees it. Drop the TOTP line for an account
without two-factor. The secret is the base32 string from the account's
authenticator setup — the test derives codes from it the way an authenticator
app does, because the second factor is the first request that carries a cookie,
and so the first one to fail if the client ever stops sending `Origin`.

Plain HTTP works for `localhost` and LAN addresses (`NSAllowsLocalNetworking`);
anything public needs HTTPS.

## Layout

```
CFMail/
  App/           CFMailApp, RootView (phase routing + banner overlay)
  Core/
    Models/      wire types — one-for-one with packages/shared/src/responses.ts
    Networking/  APIClient + Endpoints, SSE stream, cookie jar, Keychain
    Store/       AppModel (session) and MailStore (catalogue, list, realtime)
    Util/        formatting, local notifications, background refresh
  Features/      Auth, Mail, Thread, Compose, Intents, Settings, Shared
                 (Shared/Navigation.swift is how any screen opens another)
  Resources/     asset catalog
Shared/          code the app and the AutoFill extension both compile
CFMailAutoFill/  the AutoFill Credential Provider extension
CFMailUITests/   end-to-end flow + verification-code detector tests
```

`Core/Models` is the contract with the server: every type there matches a DTO in
`packages/shared/src/responses.ts`, and every request body matches an input
schema in `packages/shared/src/schemas.ts`. When one of those changes, that
folder is what changes here.
