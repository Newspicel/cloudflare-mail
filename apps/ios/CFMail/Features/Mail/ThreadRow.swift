import SwiftUI

/// One conversation in the list.
///
/// The thread row carries no message snippet — `ThreadDto` is the thread table
/// itself (subject, participants, counts, and the denormalized AI summary), so
/// the third line is the AI gist when the mailbox has AI features on, and
/// nothing otherwise.
struct ThreadRow: View {
    let thread: MailThread
    let mailbox: MailboxSummary?
    let labels: [MessageLabelRef]
    var showsMailbox: Bool
    var showsAiSummary: Bool
    var isCompact: Bool
    var isSelecting: Bool
    var isSelected: Bool
    /// Highlighted as the conversation showing beside the list (iPad only).
    var isOpen = false
    var onTap: () -> Void

    private var lead: AddressObject {
        thread.participants.first ?? AddressObject(name: nil, address: "unknown")
    }

    private var avatarSize: CGFloat { isCompact ? 32 : 40 }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 8) {
                // Mail's unread gutter: the dot sits outside the avatar, and the
                // column stays reserved when read so rows never shift.
                UnreadDot(isVisible: thread.isUnread && !isSelecting)
                    .padding(.top, isCompact ? 8 : 9)

                // The check takes the avatar's own footprint rather than a
                // column of its own, so entering selection never shifts the text.
                ZStack {
                    Avatar(address: lead, size: avatarSize)
                        .opacity(isSelecting ? 0 : 1)
                    if isSelecting {
                        SelectionMark(isSelected: isSelected, size: avatarSize)
                            .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .frame(width: avatarSize, height: avatarSize)
                .animation(.snappy(duration: 0.2), value: isSelected)

                VStack(alignment: .leading, spacing: isCompact ? 1 : 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Fmt.participants(thread.participants))
                            .font(.headline)
                            .lineLimit(1)
                        if thread.msgCount > 1 {
                            Text(thread.msgCount.formatted())
                                .font(.caption.weight(.medium))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(.quaternary, in: .capsule)
                        }
                        Spacer(minLength: 4)
                        Text(Fmt.listDate(thread.lastMsgAt))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }

                    Text(thread.subject)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    // The thread row carries no message snippet, so the AI gist
                    // is the preview line when there is one.
                    if showsAiSummary, let summary = thread.aiSummary?.nilIfBlank, !isCompact {
                        Text(summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }

                    if !chipsAreEmpty {
                        HStack(spacing: 5) {
                            if let category = thread.aiCategory, category != .other {
                                CategoryChip(category: category)
                            }
                            ForEach(labels.prefix(2)) { label in
                                ColorChip(text: label.name, hex: label.color)
                            }
                            if labels.count > 2 {
                                Text("+\(labels.count - 2)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if showsMailbox, let mailbox {
                                Text(mailbox.address)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                            }
                            if thread.spam {
                                Image(systemName: "xmark.bin.fill")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                            }
                        }
                        .padding(.top, 2)
                    }
                }
            }
            .padding(.vertical, isCompact ? 4 : 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(rowBackground)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        // Stable handle for UI tests; the combined label above reads well for
        // VoiceOver but isn't something a test can match on.
        .accessibilityIdentifier(thread.subject)
    }

    private var rowBackground: Color? {
        if isSelected { return Color.accentColor.opacity(0.10) }
        if isOpen { return Color(.systemGray5) }
        return nil
    }

    private var chipsAreEmpty: Bool {
        let hasCategory = thread.aiCategory != nil && thread.aiCategory != .other
        return !hasCategory && labels.isEmpty && !showsMailbox && !thread.spam
    }

    private var accessibilityLabel: String {
        var parts = [Fmt.participants(thread.participants), thread.subject]
        if thread.isUnread { parts.insert("Unread", at: 0) }
        parts.append(Fmt.listDate(thread.lastMsgAt))
        return parts.joined(separator: ", ")
    }
}

/// Stands in for the avatar while selecting: an empty ring that fills with
/// the tint once the row is picked.
private struct SelectionMark: View {
    var isSelected: Bool
    var size: CGFloat

    var body: some View {
        Circle()
            .fill(isSelected ? Color.accentColor : Color(.quaternarySystemFill))
            .overlay {
                Circle()
                    .strokeBorder(Color(.tertiaryLabel), lineWidth: 1.5)
                    .opacity(isSelected ? 0 : 1)
            }
            .overlay {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.42, weight: .bold))
                    .foregroundStyle(.white)
                    .opacity(isSelected ? 1 : 0)
                    .scaleEffect(isSelected ? 1 : 0.5)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct DraftRow: View {
    let draft: Draft
    let mailbox: MailboxSummary?
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: draft.scheduledFor != nil ? "clock.badge" : "square.and.pencil")
                    .font(.system(size: 17))
                    .foregroundStyle(draft.scheduledError != nil ? .red : .secondary)
                    .frame(width: 32, height: 32)
                    .background(.quaternary.opacity(0.5), in: .circle)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(recipients)
                            .font(.headline)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(Fmt.listDate(draft.updatedAt))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(draft.displaySubject)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let body = draft.body.nilIfBlank {
                        Text(Fmt.snippet(body, limit: 120))
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    if let scheduled = draft.scheduledFor {
                        Label("Sends \(Fmt.relative(scheduled))", systemImage: "paperplane")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if let error = draft.scheduledError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .lineLimit(2)
                    }
                    if let mailbox {
                        Text("from \(mailbox.address)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(.vertical, 5)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var recipients: String {
        let all = draft.toAddrs + (draft.ccAddrs ?? [])
        return all.isEmpty ? "No recipients" : Fmt.participants(all)
    }
}

struct SearchResultRow: View {
    let result: SearchResult
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                Avatar(address: AddressObject(name: result.fromName, address: result.fromAddr), size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(AddressObject(name: result.fromName, address: result.fromAddr).displayName)
                            .font(.headline)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if let date = result.date {
                            Text(Fmt.listDate(date))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    Text(result.displaySubject)
                        .font(.subheadline)
                        .lineLimit(1)
                    if let snippet = result.snippet.nilIfBlank {
                        Text(Fmt.snippet(snippet, limit: 160))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Text(result.mailboxAddress)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if result.hasAttachments {
                            Image(systemName: "paperclip").font(.caption2).foregroundStyle(.tertiary)
                        }
                        if result.direction == .outgoing {
                            Image(systemName: "paperplane").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .padding(.vertical, 5)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// Summary of the structured filters currently narrowing a search.
struct ActiveFiltersRow: View {
    let query: SearchQuery
    var onEdit: () -> Void

    var body: some View {
        Button(action: onEdit) {
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal.decrease.circle.fill")
                    .foregroundStyle(Color.accentColor)
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }

    private var summary: String {
        var parts: [String] = []
        if query.searchIn != .all { parts.append("in \(query.searchIn.title.lowercased())") }
        if let from = query.from { parts.append("from \(from)") }
        if let to = query.to { parts.append("to \(to)") }
        if let subject = query.subject { parts.append("subject \(subject)") }
        if let exclude = query.exclude { parts.append("not \(exclude)") }
        if let after = query.after { parts.append("after \(after)") }
        if let before = query.before { parts.append("before \(before)") }
        if query.hasAttachment == true { parts.append("has attachment") }
        if query.folder != .any { parts.append(query.folder.title.lowercased()) }
        if query.direction == .outgoing { parts.append("sent") }
        if query.direction == .incoming { parts.append("received") }
        if query.sort != .newest { parts.append("sorted by \(query.sort.title.lowercased())") }
        return parts.isEmpty ? "Filters" : parts.joined(separator: " · ")
    }
}
