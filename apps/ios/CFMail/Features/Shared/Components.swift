import SwiftUI

/// Correspondent bubble: initials over a tint derived from the address, so the
/// same sender keeps the same colour everywhere in the app.
struct Avatar: View {
    let address: AddressObject
    var size: CGFloat = 40
    /// Brand logos are for correspondents; turn them off where the bubble
    /// stands for the signed-in account rather than a sender.
    var allowsBrandLogo = true

    @State private var bimi = BimiStore.shared
    @State private var contacts = SystemContacts.shared

    /// A face the reader has in their own address book beats a brand mark, which
    /// beats initials.
    private var picture: UIImage? {
        if let photo = contacts.image(for: address.address) { return photo }
        return allowsBrandLogo ? bimi.logo(for: address.address) : nil
    }

    var body: some View {
        Circle()
            .fill(Fmt.avatarTint(address.address).gradient.opacity(0.9))
            .overlay {
                if let logo = picture {
                    Image(uiImage: logo)
                        .resizable()
                        .scaledToFill()
                        .clipShape(.circle)
                        .transition(.opacity)
                } else {
                    Text(Fmt.initials(address))
                        .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: size, height: size)
            .animation(.easeIn(duration: 0.15), value: picture != nil)
            .task(id: address.address) {
                contacts.prefetch(address.address)
                guard allowsBrandLogo else { return }
                bimi.prefetch(for: address.address)
            }
            .accessibilityHidden(true)
    }
}

struct UnreadDot: View {
    var isVisible: Bool

    var body: some View {
        Circle()
            .fill(Color.accentColor)
            .frame(width: 8, height: 8)
            .opacity(isVisible ? 1 : 0)
            .accessibilityHidden(true)
    }
}

/// A label or folder chip. Labels carry their own `#rrggbb`.
struct ColorChip: View {
    let text: String
    let hex: String

    var body: some View {
        let color = Color(hex: hex)
        Text(text)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: .capsule)
    }
}

struct CategoryChip: View {
    let category: AiCategory

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: category.symbol)
            Text(category.title)
        }
        .font(.caption2.weight(.medium))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(category.tint)
        .background(category.tint.opacity(0.13), in: .capsule)
    }
}

/// The web app's unread pill: a filled capsule, hidden at zero.
struct UnreadBadge: View {
    let count: Int
    var tint: Color = .accentColor

    var body: some View {
        if count > 0 {
            Text(count > 999 ? "999+" : count.formatted())
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(tint, in: .capsule)
                .foregroundStyle(.white)
        }
    }
}

/// The one empty/errored state used across every list.
struct EmptyState: View {
    let symbol: String
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            if let message { Text(message) }
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.glassProminent)
            }
        }
    }
}

/// A short, non-blocking message stacked over the content (send confirmations,
/// failures, "moved to trash" with undo).
struct BannerOverlay: View {
    let banner: Banner
    var onUndo: () -> Void
    var onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: banner.symbol)
                .foregroundStyle(banner.tint)
                .imageScale(.medium)
            Text(banner.text)
                .font(.subheadline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let undo = banner.undo {
                Button(undo.title, action: onUndo)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: 520)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .padding(.horizontal, 16)
        .contentShape(.rect)
        .onTapGesture(perform: onDismiss)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .combine)
    }
}

/// Inline advisory inside a message (spam verdict, PGP state, trackers).
struct NoticeBanner: View {
    let symbol: String
    let title: String
    var detail: String?
    var tint: Color = .orange
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .font(.system(size: 15, weight: .semibold))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .background(tint.opacity(0.10), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(0.22)))
    }
}

/// Row spinner for "loading the next page".
struct LoadingFooter: View {
    var body: some View {
        HStack {
            Spacer()
            ProgressView()
                .controlSize(.small)
                .padding(.vertical, 14)
            Spacer()
        }
        .listRowSeparator(.hidden)
    }
}

/// Shows the app's transient banner over whatever it is attached to. The root
/// view hosts one, and so does every sheet — a sheet covers the root's, and a
/// failure raised inside the composer has to land somewhere the reader can
/// see it.
private struct BannerHost: ViewModifier {
    @Environment(AppModel.self) private var app
    var bottomPadding: CGFloat

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let banner = app.banner {
                    BannerOverlay(
                        banner: banner,
                        onUndo: { app.performUndo() },
                        onDismiss: { app.dismissBanner() }
                    )
                    .padding(.bottom, bottomPadding)
                }
            }
            .animation(.snappy(duration: 0.25), value: app.banner)
    }
}

extension View {
    /// Host the transient banner here. `bottomPadding` lifts it clear of a
    /// bottom toolbar when the screen has one.
    func bannerHost(bottomPadding: CGFloat = 12) -> some View {
        modifier(BannerHost(bottomPadding: bottomPadding))
    }

    /// Applies a modifier only when a condition holds — used sparingly, for
    /// platform-shaped layout differences.
    @ViewBuilder
    func applyIf(_ condition: Bool, _ transform: (Self) -> some View) -> some View {
        if condition { transform(self) } else { self }
    }
}
