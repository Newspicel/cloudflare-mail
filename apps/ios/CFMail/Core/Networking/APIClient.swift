import Foundation
import UniformTypeIdentifiers

nonisolated enum APIError: LocalizedError, Sendable {
    case noServer
    case unauthorized
    case forbidden(String)
    case http(status: Int, message: String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .noServer: "No server configured."
        case .unauthorized: "Your session expired. Sign in again."
        case .forbidden(let m): m
        case .http(_, let m): m
        case .transport(let m): m
        case .decoding(let m): "Unexpected response: \(m)"
        }
    }

    /// Whether the app should drop to the sign-in screen.
    var isAuthFailure: Bool { if case .unauthorized = self { true } else { false } }
}

/// The worker's one error envelope: `{ "error": "…" }` (api/index.ts `onError`).
private nonisolated struct ErrorEnvelope: Decodable {
    var error: String?
    var message: String?
}

nonisolated final class APIClient: Sendable {
    let baseURL: URL
    private let session: URLSession
    /// Separate session for SSE + downloads: no request timeout, since a stream
    /// is idle by design between events.
    private let streamSession: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        // A mail body is decrypted content, and URLCache would write it to
        // Caches/ where it outlives the session — the body route is served
        // `private, immutable, max-age=1y`. The policy above already means it
        // is never read back, so the store is exposure with no upside.
        config.urlCache = nil
        self.session = URLSession(configuration: config)

        let streamConfig = URLSessionConfiguration.default
        streamConfig.httpCookieStorage = HTTPCookieStorage.shared
        streamConfig.httpCookieAcceptPolicy = .always
        streamConfig.httpShouldSetCookies = true
        streamConfig.timeoutIntervalForRequest = 3600
        streamConfig.timeoutIntervalForResource = 86400
        streamConfig.waitsForConnectivity = true
        streamConfig.urlCache = nil
        self.streamSession = URLSession(configuration: streamConfig)
    }

    // ─── Coding ─────────────────────────────────────────────────────────────

    /// `c.json()` serializes D1's `Date` columns with `toISOString()`, so every
    /// timestamp arrives as ISO-8601 — usually with milliseconds, not always.
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        let withMillis = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = try? withMillis.parse(raw) { return date }
            if let date = try? plain.parse(raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "bad date \(raw)")
            )
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    // ─── Core plumbing ──────────────────────────────────────────────────────

    /// The instance origin, sent as `Origin` on every request.
    ///
    /// Better Auth runs its CSRF origin check on any request that carries a
    /// cookie, and rejects one with no `Origin` header ("missing or null
    /// origin"). A browser sets that header itself; URLSession doesn't, so
    /// sign-in works (no cookie yet) and everything after it — 2FA verify,
    /// sign-out, password change — would fail without this.
    var originHeaderValue: String { origin }

    private var origin: String {
        var comps = URLComponents()
        comps.scheme = baseURL.scheme
        comps.host = baseURL.host()
        comps.port = baseURL.port
        return comps.url?.absoluteString ?? baseURL.absoluteString
    }

    /// Headers every request carries, whatever its body type.
    private func applyDefaults(to req: inout URLRequest, accept: String) {
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue(origin, forHTTPHeaderField: "Origin")
    }

    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        return comps.url!
    }

    private func request(_ method: String, _ url: URL, body: Data? = nil, contentType: String? = nil) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        applyDefaults(to: &req, accept: "application/json")
        if let body {
            req.httpBody = body
            req.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    @discardableResult
    private func perform(_ req: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Not an HTTP response.")
        }
        // Any request can rotate the session cookie (Better Auth refreshes it on
        // `updateAge`), so re-snapshot the jar rather than only doing it at login.
        CookieJar.save(for: baseURL)

        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden(Self.message(from: data) ?? "You don't have access to that.")
        default:
            let message = Self.message(from: data) ?? "Request failed (\(http.statusCode))."
            throw APIError.http(status: http.statusCode, message: message)
        }
    }

    private static func message(from data: Data) -> String? {
        guard let env = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) else {
            return String(data: data, encoding: .utf8)?.nilIfBlank
        }
        return (env.error ?? env.message)?.nilIfBlank.map(humanize)
    }

    /// Server codes read like `mailbox_not_found`; make them presentable.
    private static func humanize(_ raw: String) -> String {
        guard !raw.contains(" "), raw.contains("_") else { return raw }
        let words = raw.split(separator: "_").map(String.init)
        guard let first = words.first else { return raw }
        return ([first.prefix(1).uppercased() + first.dropFirst()] + words.dropFirst()).joined(separator: " ")
    }

    private func decode<T: Decodable>(_ data: Data, as type: T.Type = T.self) throws -> T {
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(T.self): \(error)")
        }
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        try decode(try await perform(request("GET", url(path, query: query))))
    }

    func post<T: Decodable>(_ path: String, body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        try decode(try await perform(request("POST", url(path), body: try encodeBody(body))))
    }

    func patch<T: Decodable>(_ path: String, body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        try decode(try await perform(request("PATCH", url(path), body: try encodeBody(body))))
    }

    func put<T: Decodable>(_ path: String, body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        try decode(try await perform(request("PUT", url(path), body: try encodeBody(body))))
    }

    func send(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws {
        try await perform(request(method, url(path, query: query), body: try encodeBody(body)))
    }

    /// A request whose body is raw bytes rather than JSON (attachment upload).
    func upload<T: Decodable>(_ request: URLRequest, as type: T.Type = T.self) async throws -> T {
        var req = request
        applyDefaults(to: &req, accept: "application/json")
        return try decode(try await perform(req))
    }

    private func encodeBody(_ body: (any Encodable)?) throws -> Data? {
        guard let body else { return nil }
        do {
            return try Self.encoder.encode(body)
        } catch {
            throw APIError.decoding("request body: \(error)")
        }
    }

    // ─── Raw byte routes (attachments, .eml, images) ────────────────────────

    /// Stream a URL to a temp file. Used for attachments and `.eml` exports,
    /// which can be tens of megabytes and shouldn't sit in memory.
    func download(_ url: URL, suggestedName: String) async throws -> URL {
        var req = URLRequest(url: url)
        applyDefaults(to: &req, accept: "*/*")
        let (temp, response) = try await streamSession.download(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: temp)
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.http(status: http.statusCode, message: "Download failed (\(http.statusCode)).")
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachments", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]
        )
        let dest = dir.appendingPathComponent(Self.safeFilename(suggestedName))
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: temp, to: dest)
        // A move carries the temp file's own class, so set it on the
        // destination. `unlessOpen` rather than `complete`: Quick Look holds a
        // preview open across a lock, and a video would stop mid-play.
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: dest.path
        )
        return dest
    }

    private static func safeFilename(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return cleaned.nilIfBlank ?? "attachment"
    }

    /// The raw SSE byte stream for `GET /api/stream`.
    func eventBytes() async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        var req = URLRequest(url: url("api/stream"))
        applyDefaults(to: &req, accept: "text/event-stream")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (bytes, response) = try await streamSession.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Not an HTTP response.")
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode, message: "Stream failed (\(http.statusCode)).")
        }
        return (bytes, http)
    }
}
