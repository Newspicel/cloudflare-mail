import Foundation

/// Advanced search over `GET /api/search` (D1 FTS5 behind it). Paging is
/// offset-based there, not keyset, so "load more" is a page bump.
@Observable
final class SearchModel {
    var query = SearchQuery()
    private(set) var results: [SearchResult] = []
    private(set) var hasMore = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var error: String?
    private(set) var hasRun = false

    private var task: Task<Void, Never>?

    /// Free-text box, kept apart from the structured filters.
    var text: String {
        get { query.q }
        set { query.q = newValue }
    }

    var isActive: Bool { !query.isEmpty }

    func reset() {
        task?.cancel()
        query = SearchQuery()
        results = []
        hasMore = false
        error = nil
        hasRun = false
    }

    func run(_ client: APIClient, debounce: Bool = true) {
        task?.cancel()
        guard isActive else {
            results = []
            hasRun = false
            return
        }
        task = Task {
            if debounce { try? await Task.sleep(for: .milliseconds(280)) }
            guard !Task.isCancelled else { return }
            await load(client, page: 0)
        }
    }

    func loadMore(_ client: APIClient) async {
        guard hasMore, !isLoading, !isLoadingMore else { return }
        await load(client, page: query.page + 1)
    }

    private func load(_ client: APIClient, page: Int) async {
        if page == 0 { isLoading = true } else { isLoadingMore = true }
        error = nil
        defer {
            isLoading = false
            isLoadingMore = false
        }
        query.page = page
        do {
            let response = try await client.search(query)
            guard !Task.isCancelled else { return }
            results = page == 0 ? response.results : results + response.results
            hasMore = response.hasMore
            hasRun = true
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            if page == 0 { results = [] }
        }
    }
}
