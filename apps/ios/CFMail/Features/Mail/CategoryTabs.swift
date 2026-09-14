import SwiftUI

/// The inbox category strip, in the spirit of Mail's: a row of pills that
/// narrows the list without leaving it. Shown only where the mailbox actually
/// classifies mail (see `MailStore.showsCategories`).
struct CategoryTabs: View {
    @Binding var selection: MailCategory
    var count: (MailCategory) -> Int

    @Namespace private var pill

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(MailCategory.tabs) { category in
                        tab(category)
                            .id(category)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollIndicators(.hidden)
            .onChange(of: selection) { _, value in
                withAnimation(.snappy) { proxy.scrollTo(value, anchor: .center) }
            }
        }
        .background(.bar)
    }

    private func tab(_ category: MailCategory) -> some View {
        let isSelected = selection == category
        let total = count(category)
        return Button {
            withAnimation(.snappy(duration: 0.22)) { selection = category }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: category.symbol)
                    .font(.caption)
                Text(category.shortTitle)
                    .font(.subheadline.weight(isSelected ? .semibold : .regular))
                if total > 0, category != .all {
                    Text("\(total)")
                        .font(.caption2.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(isSelected ? .white.opacity(0.85) : .secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(isSelected ? .white : category.tint)
            .background {
                if isSelected {
                    Capsule()
                        .fill(category.tint.gradient)
                        .matchedGeometryEffect(id: "pill", in: pill)
                } else {
                    Capsule().fill(category.tint.opacity(0.12))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.title)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
