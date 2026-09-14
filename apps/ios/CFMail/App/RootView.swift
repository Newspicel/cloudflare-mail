import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            switch app.phase {
            case .launching:
                LaunchView()
            case .needsServer:
                ServerSetupView()
            case .signedOut:
                SignInView()
            case .twoFactor:
                TwoFactorView()
            case .ready:
                if let mail = app.mail {
                    MailHomeView()
                        .environment(mail)
                } else {
                    LaunchView()
                }
            }
        }
        .animation(.smooth(duration: 0.28), value: app.phase)
        .overlay(alignment: .bottom) {
            if let banner = app.banner {
                BannerOverlay(
                    banner: banner,
                    onUndo: { app.performUndo() },
                    onDismiss: { app.dismissBanner() }
                )
                .padding(.bottom, 12)
            }
        }
        .animation(.snappy(duration: 0.25), value: app.banner)
    }
}

private struct LaunchView: View {
    var body: some View {
        VStack(spacing: 18) {
            AppMark(size: 64)
            ProgressView().controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}

/// The app's envelope-and-cloud mark, drawn rather than shipped as an asset so
/// it scales cleanly wherever it's used in-app.
struct AppMark: View {
    var size: CGFloat = 56

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.23, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [Color(hex: "#F98A13"), Color(hex: "#EC4F16")],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .overlay {
                Image(systemName: "envelope.fill")
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.16), radius: size * 0.08, y: size * 0.04)
            .accessibilityHidden(true)
    }
}

/// Shared chrome for the three pre-session screens.
struct AuthScaffold<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 40)
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 14) {
                        AppMark()
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title)
                                .font(.largeTitle.bold())
                                .lineLimit(2)
                                .minimumScaleFactor(0.8)
                            if let subtitle {
                                Text(subtitle)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    content
                }
                .padding(24)
                .frame(maxWidth: 460)
                Spacer(minLength: 40)
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .scrollDismissesKeyboard(.interactively)
    }
}

/// Error text under a form. Kept as a view so every auth screen shows failures
/// the same way.
struct FormError: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
        }
    }
}
