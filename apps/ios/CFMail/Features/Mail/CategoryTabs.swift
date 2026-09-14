import SwiftUI

/// The inbox category strip, in the shape of Mail's: a row of tinted pills
/// that narrows the list without leaving it. Shown only where the mailbox
/// actually classifies mail (see `MailStore.showsCategories`).
struct CategoryTabs: View {
    @Binding var selection: MailCategory
    var count: (MailCategory) -> Int

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
                    .font(.footnote.weight(.semibold))
                Text(category.shortTitle)
                    .font(.subheadline.weight(.semibold))
                if total > 0, category != .all {
                    Text(total.formatted())
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .opacity(0.8)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(isSelected ? Color.white : category.tint)
            .background(
                isSelected ? category.tint : category.tint.opacity(0.12),
                in: .capsule
            )
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.title)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
