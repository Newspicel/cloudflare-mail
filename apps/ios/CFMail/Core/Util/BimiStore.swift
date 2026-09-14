import OSLog
import SwiftUI
import WebKit

/// Sender brand logos (BIMI), fetched from the instance and kept as images.
///
/// The Worker resolves the domain's BIMI record and serves a sanitized SVG
/// (`mail/bimi.ts`). Nothing on iOS can decode SVG into a `UIImage`, so each
/// logo is rendered once in an offscreen web view, snapshotted, and cached in
/// memory and on disk — a list scrolls past hundreds of rows and must never
/// touch a web view to draw one.
///
/// A logo is decoration. It is drawn in place of initials and says nothing
/// about whether a message is genuine; the reader's trust signals stay in the
/// authentication and spam banners.
@MainActor @Observable
final class BimiStore {
    static let shared = BimiStore()

    private static let log = Logger(subsystem: "dev.cfmail.CFMail", category: "bimi")
    /// Rendered at 2× the largest avatar so it stays crisp everywhere.
    private static let renderSize: CGFloat = 96

    private var images: [String: UIImage] = [:]
    /// Domains known to publish nothing, so they're asked about once a launch.
    private var missing: Set<String> = []
    private var inFlight: Set<String> = []

    @ObservationIgnored private var client: APIClient?
    @ObservationIgnored private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        // Unlike the API session, this one *wants* the HTTP cache: the server
        // marks both logos and misses cacheable for a day.
        config.requestCachePolicy = .useProtocolCachePolicy
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config)
    }()

    private init() {}

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    func configure(client: APIClient?) {
        // A different instance means different mail and a different cache.
        if self.client?.baseURL != client?.baseURL {
            images.removeAll()
            missing.removeAll()
            inFlight.removeAll()
        }
        self.client = client
    }

    func reset() {
        client = nil
        images.removeAll()
        missing.removeAll()
        inFlight.removeAll()
        try? FileManager.default.removeItem(at: Self.cacheDirectory)
    }

    // ─── Lookup ─────────────────────────────────────────────────────────────

    /// The logo for an address, if one is already in hand. Reading this in a
    /// view body also subscribes it, so the avatar swaps in when the load
    /// finishes.
    func logo(for address: String) -> UIImage? {
        guard let domain = Self.domain(of: address) else { return nil }
        return images[domain]
    }

    /// Ask for a domain's logo. Safe to call on every row, every render.
    func prefetch(for address: String) {
        guard let client, let domain = Self.domain(of: address) else { return }
        guard images[domain] == nil, !missing.contains(domain), !inFlight.contains(domain) else {
            return
        }
        inFlight.insert(domain)

        Task {
            defer { inFlight.remove(domain) }
            if let cached = Self.readDisk(domain) {
                images[domain] = cached
                return
            }
            guard let svg = await fetchSvg(domain: domain, client: client) else {
                missing.insert(domain)
                return
            }
            guard let image = await render(svg: svg) else {
                missing.insert(domain)
                return
            }
            images[domain] = image
            Self.writeDisk(domain, image)
        }
    }

    private func fetchSvg(domain: String, client: APIClient) async -> String? {
        var request = URLRequest(url: client.url("api/avatar/domain/\(domain)"))
        request.setValue("image/svg+xml", forHTTPHeaderField: "Accept")
        request.setValue(client.originHeaderValue, forHTTPHeaderField: "Origin")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return String(data: data, encoding: .utf8)
        } catch {
            Self.log.debug("bimi fetch failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // ─── Rendering ──────────────────────────────────────────────────────────

    /// One web view, used strictly one logo at a time. A second `loadHTMLString`
    /// while the first is in flight cancels it and swaps the delegate out from
    /// under the waiting snapshot, so renders queue instead of racing.
    @ObservationIgnored private var renderer: WKWebView?
    @ObservationIgnored private var rendering = false
    @ObservationIgnored private var waiting: [CheckedContinuation<Void, Never>] = []

    private func acquireRenderer() async {
        guard rendering else {
            rendering = true
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    private func releaseRenderer() {
        if waiting.isEmpty {
            rendering = false
        } else {
            waiting.removeFirst().resume()
        }
    }

    private func render(svg: String) async -> UIImage? {
        await acquireRenderer()
        defer { releaseRenderer() }

        let renderSize = Self.renderSize
        let webView = renderer ?? {
            let config = WKWebViewConfiguration()
            config.defaultWebpagePreferences.allowsContentJavaScript = false
            let view = WKWebView(
                frame: CGRect(x: 0, y: 0, width: renderSize, height: renderSize),
                configuration: config
            )
            view.isOpaque = false
            view.backgroundColor = .clear
            view.scrollView.backgroundColor = .clear
            renderer = view
            return view
        }()

        // Without a viewport the page lays out at WebKit's 980px default, so a
        // `width: 100%` logo renders six times too large and the snapshot rect
        // catches only its top-left corner.
        let document = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=\(Int(renderSize)), initial-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: transparent;
                       width: \(Int(renderSize))px; height: \(Int(renderSize))px; }
          svg { width: 100%; height: 100%; display: block; }
        </style></head><body>\(svg)</body></html>
        """

        let delegate = LoadWaiter()
        webView.navigationDelegate = delegate
        webView.loadHTMLString(document, baseURL: nil)
        guard await delegate.wait() else { return nil }

        // The SVG's own resources are inline, but give layout a beat to settle
        // before snapshotting — an unpainted snapshot is a blank avatar.
        try? await Task.sleep(for: .milliseconds(120))

        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: renderSize, height: renderSize)
        config.snapshotWidth = NSNumber(value: Double(renderSize))
        return try? await webView.takeSnapshot(configuration: config)
    }

    /// Bridges `didFinish` / `didFail` into one awaited answer.
    private final class LoadWaiter: NSObject, WKNavigationDelegate {
        private var continuation: CheckedContinuation<Bool, Never>?
        private var settled = false

        func wait() async -> Bool {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                // WebKit occasionally reports neither on malformed markup.
                Task {
                    try? await Task.sleep(for: .seconds(5))
                    self.finish(false)
                }
            }
        }

        private func finish(_ success: Bool) {
            guard !settled else { return }
            settled = true
            continuation?.resume(returning: success)
            continuation = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }

        func webView(
            _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error
        ) {
            finish(false)
        }

        func webView(
            _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: any Error
        ) {
            finish(false)
        }
    }

    // ─── Disk cache ─────────────────────────────────────────────────────────

    private static let cacheDirectory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("bimi", isDirectory: true)
    }()

    private static func cacheURL(_ domain: String) -> URL {
        cacheDirectory.appendingPathComponent("\(domain).png")
    }

    private static func readDisk(_ domain: String) -> UIImage? {
        guard let data = try? Data(contentsOf: cacheURL(domain)) else { return nil }
        return UIImage(data: data)
    }

    private static func writeDisk(_ domain: String, _ image: UIImage) {
        guard let data = image.pngData() else { return }
        try? FileManager.default.createDirectory(
            at: cacheDirectory, withIntermediateDirectories: true
        )
        try? data.write(to: cacheURL(domain), options: .atomic)
    }

    // ─── Domains ────────────────────────────────────────────────────────────

    /// The domain half of an address, when it looks like a real domain.
    static func domain(of address: String) -> String? {
        guard let at = address.lastIndex(of: "@") else { return nil }
        let host = address[address.index(after: at)...]
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        guard host.contains("."), !host.hasPrefix("."), !host.hasSuffix(".") else { return nil }
        // Keep it to what the server will accept, so a malformed address never
        // becomes a request.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-.")
        guard host.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return host
    }
}
