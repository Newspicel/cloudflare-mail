import SwiftUI

@main
struct CFMailApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .task { await app.bootstrap() }
                .tint(.accentColor)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                app.mail?.sceneBecameActive()
            case .background:
                app.mail?.sceneWentBackground()
            default:
                break
            }
        }
        // iOS runs this when it feels like it; see BackgroundRefresh for why the
        // app polls at all rather than riding the Worker's Web Push.
        .backgroundTask(.appRefresh(BackgroundRefresh.taskIdentifier)) {
            await BackgroundRefresh.run()
            BackgroundRefresh.schedule()
        }
    }
}
