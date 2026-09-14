import SwiftUI
import WebKit

/// Renders a message's HTML body.
///
/// The Worker has already sanitized the markup, stripped known beacons and
/// rewritten every remote image to its own `/api/messages/proxy-image` route
/// (so opening mail never leaks the reader's IP), plus inline `cid:` parts to
/// same-origin attachment URLs. Both need the session cookie, so the web view
/// runs against the default data store with the app's cookies copied in, and
/// page JavaScript stays off.
struct HTMLMessageView: UIViewRepresentable {
    let html: String
    let baseURL: URL
    @Binding var height: CGFloat
    var onOpenURL: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $height, onOpenURL: onOpenURL)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.suppressesIncrementalRendering = false
        config.dataDetectorTypes = [.link, .phoneNumber, .calendarEvent, .address]

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let document = Self.document(for: html)
        guard context.coordinator.loadedDocument != document else { return }
        context.coordinator.loadedDocument = document
        Task {
            await Self.syncCookies(for: baseURL, into: view.configuration.websiteDataStore)
            view.loadHTMLString(document, baseURL: baseURL)
        }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
    }

    /// WKWebView keeps its own cookie jar; the proxy and attachment routes are
    /// session-authed, so copy the app's cookies across before loading.
    private static func syncCookies(for url: URL, into store: WKWebsiteDataStore) async {
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        for cookie in cookies {
            await store.httpCookieStore.setCookie(cookie)
        }
    }

    private static func document(for body: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: light dark; }
          html, body {
            margin: 0; padding: 0; background: transparent;
            -webkit-text-size-adjust: 100%;
            overflow-x: hidden;
          }
          body {
            /* The system body font at the reader's Dynamic Type size. */
            font: -apple-system-body;
            line-height: 1.45;
            color: light-dark(#1c1c1e, #f2f2f7);
            word-break: break-word; overflow-wrap: anywhere;
          }
          img { max-width: 100% !important; height: auto; border-radius: 4px; }
          /* Layout emails love fixed-width tables; let them scroll instead of
             forcing the whole message body sideways. */
          table { max-width: 100% !important; }
          .cfmail-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          a { color: light-dark(#0b63d6, #64a6ff); }
          pre, code { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
          blockquote {
            margin: 8px 0; padding-left: 12px;
            border-left: 3px solid light-dark(#d1d1d6, #48484a);
            color: light-dark(#636366, #aeaeb2);
          }
          hr { border: none; border-top: 1px solid light-dark(#e5e5ea, #3a3a3c); }
        </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var height: CGFloat
        let onOpenURL: (URL) -> Void
        var loadedDocument: String?
        private var measureTask: Task<Void, Never>?

        init(height: Binding<CGFloat>, onOpenURL: @escaping (URL) -> Void) {
            _height = height
            self.onOpenURL = onOpenURL
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measureTask?.cancel()
            // Images resolve after `didFinish`, so re-measure a few times rather
            // than trusting the first height.
            measureTask = Task { [weak self, weak webView] in
                for delay in [0.0, 0.15, 0.4, 1.0, 2.0] {
                    if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                    guard !Task.isCancelled, let webView else { return }
                    await self?.measure(webView)
                }
            }
        }

        private func measure(_ webView: WKWebView) async {
            let result = try? await webView.evaluateJavaScript(
                "Math.ceil(document.body.scrollHeight)"
            )
            guard let value = result as? CGFloat, value > 0 else { return }
            if abs(value - height) > 1 { height = value }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            // The only navigation this view performs is its own `loadHTMLString`.
            // Anything the reader taps leaves the app instead of replacing the
            // message body.
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url
            else {
                return .allow
            }
            onOpenURL(url)
            return .cancel
        }
    }
}

/// Plain-text bodies, with links and phone numbers made tappable.
struct PlainTextBodyView: View {
    let text: String

    var body: some View {
        Text(attributed)
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .tint(Color.accentColor)
    }

    private var attributed: AttributedString {
        var result = AttributedString(text)
        guard let detector = try? NSDataDetector(
            types: NSTextCheckingResult.CheckingType.link.rawValue
                | NSTextCheckingResult.CheckingType.phoneNumber.rawValue
        ) else { return result }

        let ns = text as NSString
        let matches = detector.matches(in: text, range: NSRange(location: 0, length: ns.length))
        for match in matches {
            guard let range = Range(match.range, in: result) else { continue }
            if let url = match.url {
                result[range].link = url
            } else if let number = match.phoneNumber,
                      let url = URL(string: "tel:\(number.filter { $0.isNumber || $0 == "+" })") {
                result[range].link = url
            }
        }
        return result
    }
}
