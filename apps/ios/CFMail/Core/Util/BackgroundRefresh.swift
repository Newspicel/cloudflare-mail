import BackgroundTasks
import Foundation
import OSLog

/// Opportunistic new-mail check while the app isn't running.
///
/// iOS decides when (and whether) this runs, so it is a best-effort courtesy,
/// not a delivery guarantee — the same bar the Worker holds push to. It asks
/// for unread inbox threads across every mailbox, and notifies about the ones
/// it hasn't already announced.
nonisolated enum BackgroundRefresh {
    static let taskIdentifier = "dev.cfmail.refresh"
    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "refresh")
    private static let seenKey = "cfmail.notifiedThreads"
    private static let configKey = "cfmail.notifyConfigs"

    /// Ask iOS to schedule the next check. Called when the app backgrounds.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Simulators and devices with Background App Refresh off both throw;
            // neither is worth surfacing to the reader.
            log.debug("could not schedule: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func run() async {
        guard let config = ServerConfig.load() else { return }
        CookieJar.restore()
        guard CookieJar.hasSession(for: config.baseURL) else { return }
        let client = APIClient(baseURL: config.baseURL)

        do {
            let mailboxes = try await client.mailboxes()
            let levels = notifyLevels()
            let list = try await client.threads(
                mailboxId: APIClient.allMailboxes, view: .inbox, limit: 20, unreadOnly: true
            )

            var seen = notifiedThreads()
            var announced = 0
            // A verification code is worth a round-trip; a hundred of them is
            // not, and the refresh window is seconds long.
            var codeLookups = 0
            // Oldest first so the newest alert lands on top of the stack.
            for thread in list.threads.sorted(by: { $0.lastMsgAt < $1.lastMsgAt }) {
                guard !seen.contains(thread.id) else { continue }
                seen.insert(thread.id)
                let level = level(for: thread, config: levels[thread.mailboxId])
                guard level != .none, !FocusFilterState.silences(mailboxId: thread.mailboxId) else { continue }
                await Notifications.shared.newMail(
                    threadId: thread.id,
                    mailboxId: thread.mailboxId,
                    sender: Fmt.participants(thread.participants),
                    subject: thread.subject,
                    preview: thread.aiSummary?.nilIfBlank ?? "New message",
                    level: level
                )
                announced += 1

                if codeLookups < 5 {
                    codeLookups += 1
                    await captureCode(from: thread, using: client)
                }
            }
            store(notifiedThreads: seen)

            let unread = mailboxes.reduce(0) { $0 + $1.unread }
            await Notifications.shared.setBadge(unread)
            log.debug("refresh announced \(announced, privacy: .public) of \(list.threads.count, privacy: .public)")
        } catch {
            log.debug("refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Look for a one-time code in a newly-arrived thread so it's waiting in the
    /// QuickType bar by the time the reader switches to the app asking for it.
    private static func captureCode(from thread: MailThread, using client: APIClient) async {
        do {
            let detail = try await client.thread(thread.id)
            guard let newest = detail.messages.filter(\.isInbound).max(by: { $0.date < $1.date }),
                  let code = VerificationCodeDetector.code(
                      subject: newest.subject, body: newest.bodyText ?? newest.snippet
                  ),
                  let domain = VerificationCodeDetector.domain(forSender: newest.fromAddr)
            else { return }
            await CodeVault.add(
                VerificationCode(
                    id: UUID().uuidString,
                    code: code,
                    domain: domain,
                    service: VerificationCodeDetector.serviceName(
                        forDomain: domain, fromName: newest.fromName
                    ),
                    subject: newest.displaySubject,
                    messageId: newest.id,
                    mailboxId: newest.mailboxId,
                    receivedAt: newest.date
                )
            )
        } catch {
            log.debug("code lookup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Per-mailbox, per-priority notification style, as configured on the server
    /// (`GET /api/push/mailboxes`). Cached locally because a refresh task should
    /// spend its seconds on mail, not settings.
    private static func level(for thread: MailThread, config: NotifyConfig?) -> NotifyLevel {
        let config = config ?? .defaultOn
        return switch thread.aiPriority ?? .normal {
        case .high: config.high
        case .normal: config.normal
        case .low: config.low
        }
    }

    static func cache(notifyConfigs: [NotifyConfig]) {
        guard let data = try? JSONEncoder().encode(notifyConfigs) else { return }
        UserDefaults.standard.set(data, forKey: configKey)
    }

    private static func notifyLevels() -> [String: NotifyConfig] {
        guard let data = UserDefaults.standard.data(forKey: configKey),
              let configs = try? JSONDecoder().decode([NotifyConfig].self, from: data)
        else { return [:] }
        return Dictionary(uniqueKeysWithValues: configs.map { ($0.mailboxId, $0) })
    }

    // ─── "Already announced" bookkeeping ────────────────────────────────────

    private static func notifiedThreads() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? [])
    }

    private static func store(notifiedThreads ids: Set<String>) {
        // Bounded: only recent ids matter, and the set is rebuilt from whatever
        // is still unread on the next run.
        UserDefaults.standard.set(Array(ids.prefix(500)), forKey: seenKey)
    }

    /// Reading a thread retires its alert, so a later re-notify would be wrong.
    static func forget(threadId: String) {
        var ids = notifiedThreads()
        guard ids.remove(threadId) != nil else { return }
        store(notifiedThreads: ids)
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: seenKey)
        UserDefaults.standard.removeObject(forKey: configKey)
    }
}
