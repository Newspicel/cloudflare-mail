import SwiftUI

/// Everyone this account corresponds with.
///
/// The server builds the list from the mailboxes you can reach and the mail
/// they hold (`GET /api/contacts`) — it is a view of your own history, not an
/// address book the instance maintains. When device Contacts are switched on,
/// the names and faces you already have locally are layered over it.
struct ContactsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.composeAction) private var composeAction
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var isLoading = true
    @State private var systemContacts = SystemContacts.shared

    var onSearchMail: ((String) -> Void)?

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

    /// Grouped by first letter, the way an address book reads.
    private var sections: [(key: String, contacts: [Contact])] {
        Dictionary(grouping: contacts) { contact -> String in
            let first = displayName(contact).first.map(String.init)?.uppercased() ?? "#"
            return first.rangeOfCharacter(from: .letters) != nil ? first : "#"
        }
        .sorted { $0.key < $1.key }
        .map { (key: $0.key, contacts: $0.value) }
    }

    var body: some View {
        List {
            if isLoading && mail.contacts.isEmpty {
                ProgressView()
            } else if mail.contacts.isEmpty {
                EmptyState(
                    symbol: "person.2",
                    title: "No correspondents yet",
                    message: "Anyone you exchange mail with shows up here."
                )
                .listRowSeparator(.hidden)
            }

            ForEach(sections, id: \.key) { section in
                Section(section.key) {
                    ForEach(section.contacts) { contact in
                        row(contact)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Contacts")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search contacts")
        .refreshable { await reload() }
        .task {
            await reload()
            isLoading = false
        }
    }

    private func row(_ contact: Contact) -> some View {
        let address = contact.asAddress
        return Menu {
            if !mail.writableMailboxes.isEmpty {
                Button("New message", systemImage: "square.and.pencil") {
                    composeAction(
                        ComposeContext(
                            kind: .new,
                            mailboxId: mail.currentMailbox?.id ?? mail.writableMailboxes.first?.id,
                            initialTo: [address]
                        )
                    )
                }
            }
            Button("Find their mail", systemImage: "magnifyingglass") {
                if let onSearchMail {
                    onSearchMail(contact.address)
                    dismiss()
                } else {
                    mail.pendingSearch = contact.address
                }
            }
            Button("Copy address", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = contact.address
            }
        } label: {
            HStack(spacing: 12) {
                Avatar(address: address, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(displayName(contact))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(contact.address)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .task { systemContacts.prefetch(contact.address) }
    }

    /// A device contact's name wins: it's what the reader chose to call them.
    private func displayName(_ contact: Contact) -> String {
        systemContacts.name(for: contact.address)
            ?? contact.name?.nilIfBlank
            ?? contact.address
    }

    private func reload() async {
        mail.invalidateContacts()
        await mail.loadContactsIfNeeded()
    }
}
