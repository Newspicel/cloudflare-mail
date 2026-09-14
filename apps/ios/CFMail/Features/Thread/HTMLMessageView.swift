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
///
/// Mail styles its text for the page the sender's client assumed — nearly
/// always white — and rarely paints a background of its own, so on a dark
/// phone its `#333` copy would sit on a black card and vanish. After the
/// document loads, the same contrast pass the web app runs (`lib/contrast.ts`)
/// walks every run of text, works out what it actually sits on, and shifts its
/// lightness just far enough to read; the view stays hidden until that has
/// happened so nothing flashes unreadable first.
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
        config.suppressesIncrementalRendering = true
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
        // Revealed once the text has been made readable (see `didFinish`).
        view.alpha = 0
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let theme = Theme(scheme: context.environment.colorScheme)
        let document = Self.document(for: html, theme: theme)
        guard context.coordinator.loadedDocument != document else { return }
        context.coordinator.loadedDocument = document
        context.coordinator.theme = theme
        context.coordinator.armRevealFallback(view)
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

    // ─── Theme ──────────────────────────────────────────────────────────────

    /// The page colours for one appearance. The canvas is the card the body
    /// sits on — `systemBackground` resolved for that appearance — and is what
    /// the contrast pass measures unpainted text against.
    struct Theme: Equatable {
        let isDark: Bool
        let canvas: (r: Int, g: Int, b: Int)

        init(scheme: ColorScheme) {
            isDark = scheme == .dark
            let traits = UITraitCollection(userInterfaceStyle: isDark ? .dark : .light)
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            UIColor.systemBackground.resolvedColor(with: traits)
                .getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            canvas = (Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
        }

        static func == (a: Theme, b: Theme) -> Bool {
            a.isDark == b.isDark && a.canvas == b.canvas
        }

        var scheme: String { isDark ? "dark" : "light" }
        var canvasCSS: String { "rgb(\(canvas.r), \(canvas.g), \(canvas.b))" }
        var canvasJS: String { "[\(canvas.r), \(canvas.g), \(canvas.b), 1]" }
        var text: String { isDark ? "#f2f2f7" : "#1c1c1e" }
        var muted: String { isDark ? "#aeaeb2" : "#636366" }
        var link: String { isDark ? "#64a6ff" : "#0b63d6" }
        var rule: String { isDark ? "#3a3a3c" : "#e5e5ea" }
        var quoteBar: String { isDark ? "#48484a" : "#d1d1d6" }
    }

    private static func document(for body: String, theme: Theme) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          html { color-scheme: \(theme.scheme); }
          html, body {
            margin: 0; padding: 0; background: transparent;
            -webkit-text-size-adjust: 100%;
            overflow-x: hidden;
          }
          body {
            /* The system body font at the reader's Dynamic Type size. */
            font: -apple-system-body;
            line-height: 1.45;
            color: \(theme.text);
            word-break: break-word; overflow-wrap: anywhere;
          }
          img { max-width: 100% !important; height: auto; border-radius: 4px; }
          /* Layout emails love fixed-width tables; let them scroll instead of
             forcing the whole message body sideways. */
          table { max-width: 100% !important; }
          .cfmail-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          a { color: \(theme.link); }
          pre, code { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
          blockquote {
            margin: 8px 0; padding-left: 12px;
            border-left: 3px solid \(theme.quoteBar);
            color: \(theme.muted);
          }
          hr { border: none; border-top: 1px solid \(theme.rule); }
        </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    // ─── Contrast ───────────────────────────────────────────────────────────

    /// `adaptTextContrast` from the web app, as plain JavaScript run by the app
    /// (page scripts stay disabled). Takes the canvas as `[r, g, b, a]` and
    /// returns how many elements it re-tinted.
    ///
    /// For each element that paints text it resolves the opaque colour behind
    /// it — the email's own backgrounds composited down to our canvas — and,
    /// where the text falls short of WCAG contrast, moves its lightness (hue
    /// and saturation kept) toward whichever extreme reads. Text on a
    /// background the email painted is only lifted to the minimum; text on our
    /// canvas is restored to the contrast it had on the page it was written for
    /// (light or dark, decided by the bulk of the copy), so headings stay
    /// stronger than footers instead of collapsing to one grey. Hidden
    /// preheaders and sub-4px text are left alone so they stay hidden.
    private static let contrastScript = #"""
    (function (canvasBg) {
      if (!document.body) return 0;
      var MIN = 4.5, MIN_LARGE = 3;
      var LIGHT_TEXT_BELOW = Math.sqrt(1.05 * 0.05) - 0.05;
      function channel(c) { var s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
      function luminance(c) { return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]); }
      function contrast(a, b) { var la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
      function over(fg, bg) {
        var a = fg[3];
        return [Math.round(fg[0] * a + bg[0] * (1 - a)), Math.round(fg[1] * a + bg[1] * (1 - a)), Math.round(fg[2] * a + bg[2] * (1 - a))];
      }
      function rgbToHsl(c) {
        var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        var d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min), h;
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        return [h / 6, s, l];
      }
      function hslToRgb(h, s, l) {
        if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        function hue(t) {
          var x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
          if (x < 1 / 6) return p + (q - p) * 6 * x;
          if (x < 1 / 2) return q;
          if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
          return p;
        }
        return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
      }
      function readable(fg, bg, target) {
        var hsl = rgbToHsl(fg), h = hsl[0], s = hsl[1], l0 = hsl[2];
        var toward = luminance(bg) < LIGHT_TEXT_BELOW ? 1 : 0;
        function at(l) { return hslToRgb(h, s, l); }
        if (contrast(at(toward), bg) < target) return at(toward);
        var lo = l0, hi = toward;
        for (var i = 0; i < 20; i++) {
          var mid = (lo + hi) / 2;
          if (contrast(at(mid), bg) >= target) hi = mid; else lo = mid;
        }
        return at(hi);
      }
      var RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,\/]\s*([\d.]+)(%?))?\s*\)$/i;
      var ctx;
      function parse(value) {
        var m = RGB_RE.exec(value);
        if (m) {
          var a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
          return [Number(m[1]), Number(m[2]), Number(m[3]), a];
        }
        if (ctx === undefined) {
          var c = document.createElement('canvas'); c.width = 1; c.height = 1;
          ctx = c.getContext('2d', { willReadFrequently: true });
        }
        if (!ctx) return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#010203';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        var px = ctx.getImageData(0, 0, 1, 1).data;
        if (px[0] === 1 && px[1] === 2 && px[2] === 3 && px[3] === 255) return null;
        return [px[0], px[1], px[2], px[3] / 255];
      }
      function sameColor(a, b) { return Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2; }
      function ownTextLength(el) {
        var n = 0;
        for (var i = 0; i < el.childNodes.length; i++) {
          var c = el.childNodes[i];
          if (c.nodeType === 3) n += (c.nodeValue || '').trim().length;
        }
        return n;
      }
      function isRendered(el) {
        if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        return el.getClientRects().length > 0;
      }
      var body = document.body, root = document.documentElement;
      var ours = [canvasBg[0], canvasBg[1], canvasBg[2]];
      var backdrops = new Map();
      function backdropOf(el) {
        if (backdrops.has(el)) return backdrops.get(el);
        var cs = getComputedStyle(el);
        var own = parse(cs.backgroundColor);
        var result;
        if (!own || cs.backgroundImage !== 'none') {
          result = null;
        } else if (own[3] >= 1) {
          var isPage = el === body || el === root;
          result = { color: [own[0], own[1], own[2]], canvas: isPage && sameColor(own, canvasBg) };
        } else {
          var parent = el.parentElement;
          var under = parent ? backdropOf(parent) : { color: ours, canvas: true };
          if (!under) result = null;
          else if (own[3] === 0) result = under;
          else result = { color: over(own, under.color), canvas: false };
        }
        backdrops.set(el, result);
        return result;
      }
      var fixes = [], forLight = 0, forDark = 0;
      var walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      for (var node = walker.currentNode; node; node = walker.nextNode()) {
        var el = node;
        var chars = ownTextLength(el);
        if (chars === 0 || !isRendered(el)) continue;
        var cs = getComputedStyle(el);
        var size = parseFloat(cs.fontSize);
        if (!(size >= 4)) continue;
        var fgRaw = parse(cs.color);
        if (!fgRaw || fgRaw[3] === 0) continue;
        var backdrop = backdropOf(el);
        if (!backdrop) continue;
        var fg = fgRaw[3] < 1 ? over(fgRaw, backdrop.color) : [fgRaw[0], fgRaw[1], fgRaw[2]];
        if (backdrop.canvas) {
          if (luminance(fg) < LIGHT_TEXT_BELOW) forLight += chars; else forDark += chars;
        }
        var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        var min = size >= 24 || (bold && size >= 18.66) ? MIN_LARGE : MIN;
        if (contrast(fg, backdrop.color) >= min) continue;
        fixes.push({ el: el, fg: fg, backdrop: backdrop.color, canvas: backdrop.canvas, min: min });
      }
      var designedFor = forDark > forLight ? [0, 0, 0] : [255, 255, 255];
      for (var i = 0; i < fixes.length; i++) {
        var f = fixes[i];
        var target = f.canvas ? Math.max(f.min, contrast(f.fg, designedFor)) : f.min;
        var c = readable(f.fg, f.backdrop, target);
        f.el.style.setProperty('color', 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')', 'important');
      }
      return fixes.length;
    })
    """#

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var height: CGFloat
        let onOpenURL: (URL) -> Void
        var loadedDocument: String?
        var theme: Theme?
        private var measureTask: Task<Void, Never>?
        private var revealTask: Task<Void, Never>?

        init(height: Binding<CGFloat>, onOpenURL: @escaping (URL) -> Void) {
            _height = height
            self.onOpenURL = onOpenURL
        }

        /// If the load never reports back (broken markup, a hung image), show
        /// whatever rendered rather than a blank card forever.
        func armRevealFallback(_ webView: WKWebView) {
            revealTask?.cancel()
            revealTask = Task { [weak webView] in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled, let webView else { return }
                Self.reveal(webView)
            }
        }

        private static func reveal(_ webView: WKWebView) {
            guard webView.alpha < 1 else { return }
            UIView.animate(withDuration: 0.15) { webView.alpha = 1 }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measureTask?.cancel()
            measureTask = Task { [weak self, weak webView] in
                guard let self, let webView else { return }
                // Colours first, while the view is still hidden; only then the
                // first size, and only then the reveal.
                if let theme {
                    _ = try? await webView.evaluateJavaScript(
                        HTMLMessageView.contrastScript + "(\(theme.canvasJS));"
                    )
                }
                await self.measure(webView)
                self.revealTask?.cancel()
                Self.reveal(webView)
                // Images resolve after `didFinish`, so re-measure a few times
                // rather than trusting the first height.
                for delay in [0.15, 0.4, 1.0, 2.0] {
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled else { return }
                    await self.measure(webView)
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            Self.reveal(webView)
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
            .foregroundStyle(.primary)
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
