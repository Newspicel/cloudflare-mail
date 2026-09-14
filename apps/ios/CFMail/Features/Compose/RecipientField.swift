import SwiftUI

/// Wrapping row layout for recipient chips — SwiftUI has no flow stack, and a
/// recipient list is exactly the case that needs one.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                widest = max(widest, x - spacing)
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        widest = max(widest, x - spacing)
        return CGSize(width: min(widest, maxWidth), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

/// One addressee row (To / Cc / Bcc): existing addresses as removable chips,
/// plus a field that parses what you type and offers contacts as you go.
struct RecipientField: View {
    let title: String
    @Binding var people: [AddressObject]
    var contacts: [Contact]
    var blocked: Set<String> = []
    /// Mail's ⊕ at the end of the row, opening a contact list.
    var onPickContact: (() -> Void)?
    var onChange: () -> Void

    @State private var input = ""
    @FocusState private var focused: Bool

    private var suggestions: [Contact] {
        let query = input.trimmingCharacters(in: .whitespaces).lowercased()
        guard query.count >= 2 else { return [] }
        let chosen = Set(people.map { $0.address.lowercased() })
        return contacts
            .filter { contact in
                guard !chosen.contains(contact.address.lowercased()) else { return false }
                return contact.address.lowercased().contains(query)
                    || (contact.name?.lowercased().contains(query) ?? false)
            }
            .prefix(5)
            .map(\.self)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text("\(title):")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(.top, 7)

                VStack(alignment: .leading, spacing: 6) {
                    if !people.isEmpty {
                        FlowLayout {
                            ForEach(people) { person in
                                chip(person)
                            }
                        }
                    }
                    TextField("", text: $input)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focused)
                        .onSubmit { commit() }
                        .onChange(of: input) { _, value in
                            // A separator after something address-shaped
                            // finishes it, the way every mail client behaves.
                            // A space inside a name ("Ada Lovelace <…>") is
                            // just typing.
                            let separator = value.hasSuffix(",") || value.hasSuffix(";")
                                || (value.hasSuffix(" ") && value.contains("@") && !value.contains("<"))
                            if separator { commit() }
                        }
                        .padding(.vertical, 6)
                        .accessibilityLabel(title)
                }

                if let onPickContact {
                    Button(action: onPickContact) {
                        Image(systemName: "plus.circle")
                            .font(.title3)
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 5)
                    .accessibilityLabel("Add contact")
                }
            }
            .padding(.horizontal, 16)

            if focused, !suggestions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(suggestions) { contact in
                        Button {
                            add(contact.asAddress)
                        } label: {
                            HStack(spacing: 9) {
                                Avatar(address: contact.asAddress, size: 26)
                                VStack(alignment: .leading, spacing: 0) {
                                    if let name = contact.name?.nilIfBlank {
                                        Text(name).font(.subheadline).lineLimit(1)
                                    }
                                    Text(contact.address)
                                        .font(contact.name == nil ? .subheadline : .caption)
                                        .foregroundStyle(contact.name == nil ? .primary : .secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 6)
                .background(Color(.tertiarySystemGroupedBackground))
            }

            Divider().padding(.leading, 16)
        }
    }

    /// A recipient token. Tapping it shows the full address and offers to
    /// remove it, rather than removing on the first touch.
    private func chip(_ person: AddressObject) -> some View {
        let isBlocked = blocked.contains(person.address.lowercased())
        return Menu {
            Section(person.formatted) {
                Button("Copy Address", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = person.address
                }
                Button("Remove", systemImage: "minus.circle", role: .destructive) {
                    people.removeAll { $0.address == person.address }
                    onChange()
                }
            }
        } label: {
            HStack(spacing: 4) {
                if isBlocked {
                    Image(systemName: "hand.raised.fill").font(.caption2)
                }
                Text(person.displayName)
                    .font(.subheadline)
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                (isBlocked ? Color.red.opacity(0.16) : Color.accentColor.opacity(0.13)),
                in: .capsule
            )
            .foregroundStyle(isBlocked ? Color.red : Color.accentColor)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(person.formatted)
    }

    private func commit() {
        let raw = input.trimmingCharacters(in: CharacterSet(charactersIn: " ,;"))
        guard let parsed = Self.parse(raw) else {
            // Not an address yet — keep what was typed so it can be finished,
            // minus the separator that triggered the attempt.
            input = raw
            return
        }
        input = ""
        add(parsed)
    }

    private func add(_ person: AddressObject) {
        input = ""
        guard !people.contains(where: { $0.address.lowercased() == person.address.lowercased() })
        else { return }
        people.append(person)
        onChange()
    }

    /// Accepts `someone@example.com` and `Name <someone@example.com>`.
    static func parse(_ raw: String) -> AddressObject? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        if let open = trimmed.lastIndex(of: "<"), let close = trimmed.lastIndex(of: ">"), open < close {
            let address = String(trimmed[trimmed.index(after: open)..<close])
                .trimmingCharacters(in: .whitespaces)
            let name = String(trimmed[trimmed.startIndex..<open])
                .trimmingCharacters(in: CharacterSet(charactersIn: " \""))
            guard address.contains("@") else { return nil }
            return AddressObject(name: name.nilIfBlank, address: address)
        }
        guard trimmed.contains("@"), !trimmed.hasPrefix("@"), !trimmed.hasSuffix("@") else { return nil }
        return AddressObject(name: nil, address: trimmed)
    }
}
