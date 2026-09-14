import SwiftUI

/// Per-mailbox inbound automation. Rules run in `priority` order at delivery
/// time; `stopProcessing` and `hardBlock` short-circuit the rest.
struct RulesView: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    let mailbox: MailboxSummary

    @State private var rules: [Rule] = []
    @State private var isLoading = true
    @State private var editing: RuleDraft?

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if rules.isEmpty {
                EmptyState(
                    symbol: "line.3.horizontal.decrease",
                    title: "No rules",
                    message: "Rules act on mail as it arrives — label it, file it, mark it read, forward it, or reject it outright.",
                    actionTitle: "New rule"
                ) {
                    editing = RuleDraft(mailboxId: mailbox.id)
                }
                .listRowSeparator(.hidden)
            }

            ForEach(rules) { rule in
                Button {
                    editing = RuleDraft(rule: rule)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(rule.name)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(rule.enabled ? .primary : .secondary)
                            Spacer()
                            if !rule.enabled {
                                Text("Off")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(summary(rule))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await delete(rule) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        Task { await setEnabled(rule, !rule.enabled) }
                    } label: {
                        Label(rule.enabled ? "Disable" : "Enable", systemImage: rule.enabled ? "pause" : "play")
                    }
                    .tint(.indigo)
                }
            }
        }
        .navigationTitle("Rules")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New rule", systemImage: "plus") {
                    editing = RuleDraft(mailboxId: mailbox.id)
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { draft in
            RuleEditor(draft: draft, mailbox: mailbox) { await load() }
                .environment(app)
                .environment(mail)
        }
    }

    private func summary(_ rule: Rule) -> String {
        let conditions = rule.conditions
            .map { "\($0.field.title) \($0.op.title) “\($0.value)”" }
            .joined(separator: rule.conditionMode == .all ? " and " : " or ")
        let actions = rule.actions.map(describe).joined(separator: ", ")
        return "If \(conditions) → \(actions)"
    }

    private func describe(_ action: RuleAction) -> String {
        switch action {
        case .applyLabel(let id):
            let name = (mail.labelsByMailbox[mailbox.id] ?? []).first { $0.id == id }?.name
            return "label \(name ?? "…")"
        case .moveFolder(let id):
            return "file in \(mail.folders.first { $0.id == id }?.name ?? "…")"
        case .markRead: return "mark read"
        case .markSpam: return "mark spam"
        case .forward(let to): return "forward to \(to)"
        case .autoReply: return "auto-reply"
        case .hardBlock: return "reject at SMTP"
        case .stopProcessing: return "stop"
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            rules = try await mail.client.rules(mailboxId: mailbox.id)
            await mail.reloadLabels(mailboxId: mailbox.id)
        } catch {
            app.handle(error)
        }
    }

    private func setEnabled(_ rule: Rule, _ enabled: Bool) async {
        do {
            try await mail.client.updateRule(rule.id, RuleInput(enabled: enabled))
            await load()
        } catch {
            app.handle(error)
        }
    }

    private func delete(_ rule: Rule) async {
        do {
            try await mail.client.deleteRule(rule.id)
            await load()
        } catch {
            app.handle(error)
        }
    }
}

/// Editable copy of a rule (or a blank one).
@Observable
final class RuleDraft: Identifiable {
    let id = UUID()
    var ruleId: String?
    var mailboxId: String
    var name = ""
    var conditions: [RuleCondition] = [RuleCondition(field: .from, op: .contains, value: "")]
    var conditionMode: RuleConditionMode = .all
    var actions: [RuleAction] = [.markRead]
    var enabled = true

    init(mailboxId: String) {
        self.mailboxId = mailboxId
    }

    init(rule: Rule) {
        ruleId = rule.id
        mailboxId = rule.mailboxId
        name = rule.name
        conditions = rule.conditions
        conditionMode = rule.conditionMode
        actions = rule.actions
        enabled = rule.enabled
    }

    var isValid: Bool {
        name.nilIfBlank != nil
            && !conditions.isEmpty
            && conditions.allSatisfy { $0.value.nilIfBlank != nil }
            && !actions.isEmpty
    }
}

struct RuleEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(MailStore.self) private var mail
    @Environment(\.dismiss) private var dismiss

    @Bindable var draft: RuleDraft
    let mailbox: MailboxSummary
    var onSave: () async -> Void

    @State private var busy = false

    private var labels: [MailLabel] { mail.labelsByMailbox[mailbox.id] ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("What does this rule do?", text: $draft.name)
                    Toggle("Enabled", isOn: $draft.enabled)
                }

                Section {
                    Picker("Match", selection: $draft.conditionMode) {
                        ForEach(RuleConditionMode.allCases) { Text($0.title).tag($0) }
                    }
                    ForEach(Array(draft.conditions.enumerated()), id: \.offset) { index, _ in
                        conditionRow(index)
                    }
                    .onDelete { offsets in
                        draft.conditions.remove(atOffsets: offsets)
                        if draft.conditions.isEmpty {
                            draft.conditions = [RuleCondition(field: .from, op: .contains, value: "")]
                        }
                    }
                    Button("Add condition", systemImage: "plus") {
                        draft.conditions.append(RuleCondition(field: .subject, op: .contains, value: ""))
                    }
                } header: {
                    Text("Conditions")
                } footer: {
                    Text("“Delivered to” matches the exact incoming address, plus-aliases included.")
                }

                Section {
                    ForEach(Array(draft.actions.enumerated()), id: \.offset) { index, action in
                        actionRow(index, action)
                    }
                    .onDelete { offsets in
                        draft.actions.remove(atOffsets: offsets)
                    }
                    Menu {
                        ForEach(availableActions, id: \.0) { title, action in
                            Button(title) { draft.actions.append(action) }
                        }
                    } label: {
                        Label("Add action", systemImage: "plus")
                    }
                } header: {
                    Text("Actions")
                } footer: {
                    Text("Reject at SMTP refuses the message outright — nothing is stored, and the sender gets a bounce. Forwarding and auto-replies are best-effort and never hold up delivery.")
                }
            }
            .navigationTitle(draft.ruleId == nil ? "New rule" : "Edit rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!draft.isValid || busy)
                }
            }
        }
    }

    private var availableActions: [(String, RuleAction)] {
        var options: [(String, RuleAction)] = [
            ("Mark read", .markRead),
            ("Mark spam", .markSpam),
            ("Forward to…", .forward(to: "")),
            ("Auto-reply…", .autoReply(subject: nil, body: "")),
            ("Reject at SMTP", .hardBlock),
            ("Stop processing", .stopProcessing),
        ]
        if let label = labels.first { options.insert(("Apply label", .applyLabel(labelId: label.id)), at: 0) }
        if let folder = mail.folders.first { options.insert(("File in folder", .moveFolder(folderId: folder.id)), at: 1) }
        return options
    }

    private func conditionRow(_ index: Int) -> some View {
        VStack(spacing: 6) {
            HStack {
                Picker("Field", selection: $draft.conditions[index].field) {
                    ForEach(RuleField.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                Picker("Operator", selection: $draft.conditions[index].op) {
                    ForEach(RuleOp.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
            }
            TextField("Value", text: $draft.conditions[index].value)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func actionRow(_ index: Int, _ action: RuleAction) -> some View {
        switch action {
        case .applyLabel(let labelId):
            Picker("Apply label", selection: Binding(
                get: { labelId },
                set: { draft.actions[index] = .applyLabel(labelId: $0) }
            )) {
                ForEach(labels) { Text($0.name).tag($0.id) }
            }
        case .moveFolder(let folderId):
            Picker("File in", selection: Binding(
                get: { folderId },
                set: { draft.actions[index] = .moveFolder(folderId: $0) }
            )) {
                ForEach(mail.folders) { Text($0.name).tag($0.id) }
            }
        case .forward(let to):
            LabeledContent("Forward to") {
                TextField("address", text: Binding(
                    get: { to },
                    set: { draft.actions[index] = .forward(to: $0) }
                ))
                .multilineTextAlignment(.trailing)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
        case .autoReply(let subject, let body):
            VStack(alignment: .leading, spacing: 6) {
                TextField("Reply subject (optional)", text: Binding(
                    get: { subject ?? "" },
                    set: { draft.actions[index] = .autoReply(subject: $0.nilIfBlank, body: body) }
                ))
                TextField("Reply body", text: Binding(
                    get: { body },
                    set: { draft.actions[index] = .autoReply(subject: subject, body: $0) }
                ), axis: .vertical)
                .lineLimit(2...6)
            }
        case .markRead:
            Label("Mark read", systemImage: "envelope.open")
        case .markSpam:
            Label("Mark spam", systemImage: "exclamationmark.octagon")
        case .hardBlock:
            Label("Reject at SMTP", systemImage: "hand.raised").foregroundStyle(.red)
        case .stopProcessing:
            Label("Stop processing", systemImage: "stop.circle")
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let input = RuleInput(
            mailboxId: draft.ruleId == nil ? draft.mailboxId : nil,
            name: draft.name,
            conditions: draft.conditions,
            conditionMode: draft.conditionMode,
            actions: draft.actions,
            enabled: draft.enabled
        )
        do {
            if let ruleId = draft.ruleId {
                try await mail.client.updateRule(ruleId, input)
            } else {
                _ = try await mail.client.createRule(input)
            }
            await onSave()
            dismiss()
        } catch {
            app.handle(error)
        }
    }
}
