import Foundation
import OSLog

/// What the realtime connection reports back. `UserHub` pings every 25s, so a
/// silent connection is a healthy one — reconnects are driven by the request
/// ending, not by an idle timer.
nonisolated enum StreamSignal: Sendable {
    case connected
    case disconnected
    case unauthorized
    case event(HubEvent)
}

/// SSE client for `GET /api/stream`.
///
/// Invariant 3 of the project: realtime is SSE via the `UserHub` Durable
/// Object — no websockets, no polling. The stream reconnects with backoff and
/// keeps running until the consuming task is cancelled.
nonisolated struct EventStream: Sendable {
    let client: APIClient
    private static let log = Logger(subsystem: "dev.newspicel.cfmail", category: "stream")

    func signals() -> AsyncStream<StreamSignal> {
        AsyncStream(bufferingPolicy: .bufferingNewest(64)) { continuation in
            let task = Task {
                var backoff: Duration = .seconds(1)
                while !Task.isCancelled {
                    do {
                        let (bytes, _) = try await client.eventBytes()
                        backoff = .seconds(1)
                        continuation.yield(.connected)
                        var dataLines: [String] = []
                        for try await line in bytes.lines {
                            if Task.isCancelled { break }
                            if line.isEmpty {
                                // Blank line terminates one event.
                                if !dataLines.isEmpty {
                                    let payload = dataLines.joined(separator: "\n")
                                    if let data = payload.data(using: .utf8),
                                       let event = HubEvent.parse(data) {
                                        continuation.yield(.event(event))
                                    }
                                    dataLines.removeAll(keepingCapacity: true)
                                }
                                continue
                            }
                            // `: connected` is the hub's opening comment; the
                            // `event:` line duplicates the JSON's own `type`.
                            if line.hasPrefix(":") || line.hasPrefix("event:") { continue }
                            if line.hasPrefix("data:") {
                                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                            }
                        }
                        continuation.yield(.disconnected)
                    } catch is CancellationError {
                        break
                    } catch let error as APIError where error.isAuthFailure {
                        continuation.yield(.unauthorized)
                        break
                    } catch {
                        Self.log.debug("stream dropped: \(error.localizedDescription, privacy: .public)")
                        continuation.yield(.disconnected)
                    }

                    if Task.isCancelled { break }
                    try? await Task.sleep(for: backoff)
                    backoff = min(backoff * 2, .seconds(30))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
