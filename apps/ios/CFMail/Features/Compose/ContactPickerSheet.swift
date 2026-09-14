import SwiftUI

/// The ⊕ on an addressee row: everyone this account corresponds with, searched
/// by name or address, one tap to add.
struct ContactPickerSheet: View {
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    /// Already on the row, so they're shown but not offered twice.
    var chosen: Set<String>
    var onPick: (AddressObject) -> Void

    @State private var query = ""
    @State private var systemContacts = SystemContacts.shared

    private var contacts: [Contact] {
        let text = query.trimmingCharacters(in: .whitespaces).lowercased()
        let all = mail.contacts.sorted {
            displayName($0).localizedCaseInsensitiveCompare(displayName($1)) == .orderedAscending
        }
        guard !text.isEmpty else { return all }
        return all.filter {
            $0.address.lowercased().contains(text) || displayName($0).lowercased().contains(text)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if mail.contacts.isEmpty {
                    EmptyState(
                        symbol: "person.2",
                        title: "No Contacts Yet",
                        message: "Anyone you exchange mail with shows up here."
                    )
                    .listRowSeparator(.hidden)
                }
                ForEach(contacts) { contact in
                    let taken = chosen.contains(contact.address.lowercased())
                    Button {
                        onPick(contact.asAddress)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            Avatar(address: contact.asAddress, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(displayName(contact))
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(contact.address)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if taken {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(taken)
                    .task { systemContacts.prefetch(contact.address) }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { await mail.loadContactsIfNeeded() }
        }
    }

    private func displayName(_ contact: Contact) -> String {
        systemContacts.name(for: contact.address) ?? contact.name?.nilIfBlank ?? contact.address
    }
}
