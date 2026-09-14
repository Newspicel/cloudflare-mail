import QuickLook
import SwiftUI

struct MessageCard: View {
    @Environment(\.openURL) private var openURL
    @Bindable var model: ThreadDetailModel
    let message: Message
    var isExpanded: Bool
    var onToggle: () -> Void
    var onReply: (QuoteKind, Bool) -> Void

    @State private var showingDetails = false
    @State private var bodyHeight: CGFloat = 40
    @State private var previewURL: URL?
    @State private var downloading: Set<String> = []
    @State private var blockNote = ""
    @State private var showingBlockPrompt = false
    @State private var showsRemoteHTML = true

    private var body_: MessageBody? { model.bodies[message.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isExpanded {
                expandedHeader
                Divider().padding(.leading, 16)
                VStack(alignment: .leading, spacing: 14) {
                    if showingDetails { detailsBlock }
                    banners
                    bodyBlock
                    if let attachments = body_?.visibleAttachments, !attachments.isEmpty {
                        attachmentsBlock(attachments)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 18)
            } else {
                collapsedHeader
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
        .quickLookPreview($previewURL)
        .alert("Ask an admin to block this sender?", isPresented: $showingBlockPrompt) {
            TextField("Why? (optional)", text: $blockNote)
            Button("Cancel", role: .cancel) {}
            Button("Send Request") {
                Task { await model.requestBlock(message, note: blockNote) }
                blockNote = ""
            }
        } message: {
            Text("The blocklist is deployment-wide, so an admin reviews the request before \(message.fromAddr) is blocked for everyone.")
        }
    }

    // ─── Header ─────────────────────────────────────────────────────────────

    /// Mail's open-message header: who, when, and a "to …" line that opens the
    /// full address list. No card, no chrome — the message is the page.
    private var expandedHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(address: message.sender, size: 40)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(message.sender.displayName)
                        .font(.headline)
                        .lineLimit(1)
                    if message.isStarred {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(.yellow)
                    }
                    Spacer(minLength: 4)
                    Text(Fmt.listDate(message.date))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    messageMenu
                }
                Button {
                    withAnimation(.snappy) { showingDetails.toggle() }
                } label: {
                    HStack(spacing: 3) {
                        Text("To: \(recipientSummary)")
                            .lineLimit(1)
                        Image(systemName: showingDetails ? "chevron.up" : "chevron.down")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .contentShape(.rect)
        .onTapGesture(perform: onToggle)
        .accessibilityIdentifier("message.expanded")
    }

    /// An older message in the thread, one line like Mail's collapsed rows.
    private var collapsedHeader: some View {
        Button(action: onToggle) {
            HStack(alignment: .center, spacing: 12) {
                Avatar(address: message.sender, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(message.sender.displayName)
                            .font(.subheadline.weight(message.isSeen ? .semibold : .bold))
                            .lineLimit(1)
                        if !message.isSeen && message.isInbound {
                            UnreadDot(isVisible: true)
                        }
                        Spacer(minLength: 4)
                        Text(Fmt.listDate(message.date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(message.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("message.collapsed")
    }

    private var recipientSummary: String {
        let all = message.toAddrs + (message.ccAddrs ?? [])
        return all.isEmpty ? "undisclosed recipients" : Fmt.participants(all, fallback: "undisclosed recipients")
    }

    private var detailsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            detailRow("From", [message.sender])
            detailRow("To", message.toAddrs)
            if let cc = message.ccAddrs, !cc.isEmpty { detailRow("Cc", cc) }
            if let bcc = message.bccAddrs, !bcc.isEmpty { detailRow("Bcc", bcc) }
            if let deliveredTo = message.deliveredTo, deliveredTo != message.toAddrs.first?.address {
                labelled("Delivered to", deliveredTo)
            }
            labelled("Date", Fmt.messageDate(message.date))
            if message.sizeBytes > 0 { labelled("Size", Fmt.bytes(message.sizeBytes)) }
            if let auth = message.spamAuth, !auth.isEmpty {
                labelled("Authentication", authSummary(auth))
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground), in: .rect(cornerRadius: 10))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func detailRow(_ title: String, _ people: [AddressObject]) -> some View {
        labelled(title, people.map(\.formatted).joined(separator: ", "))
    }

    private func labelled(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 86, alignment: .leading)
            Text(value)
                .font(.caption)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func authSummary(_ auth: SpamAuth) -> String {
        [("SPF", auth.spf), ("DKIM", auth.dkim), ("DMARC", auth.dmarc)]
            .compactMap { name, value in value.map { "\(name) \($0)" } }
            .joined(separator: " · ")
    }

    /// Mail's per-message reply arrow: a tap replies, a press offers the rest.
    /// A read-only mailbox gets the rest under an ellipsis instead.
    @ViewBuilder
    private var messageMenu: some View {
        if model.canWrite {
            Menu {
                messageMenuItems
            } label: {
                Image(systemName: "arrowshape.turn.up.left")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            } primaryAction: {
                onReply(.reply, false)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reply")
        } else {
            Menu {
                messageMenuItems
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("More")
        }
    }

    @ViewBuilder
    private var messageMenuItems: some View {
        if model.canWrite {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { onReply(.reply, false) }
            Button("Reply All", systemImage: "arrowshape.turn.up.left.2") { onReply(.reply, true) }
            Button("Forward", systemImage: "arrowshape.turn.up.right") { onReply(.forward, false) }
            Divider()
        }
        Group {
            Button(message.isStarred ? "Unstar" : "Star", systemImage: message.isStarred ? "star.slash" : "star") {
                Task { await model.toggleStar(message) }
            }
            Button("Copy Address", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = message.fromAddr
            }
            if body_?.html?.nilIfBlank != nil, body_?.text?.nilIfBlank != nil {
                Button(
                    showsRemoteHTML ? "View as Plain Text" : "View Formatted",
                    systemImage: showsRemoteHTML ? "text.alignleft" : "doc.richtext"
                ) {
                    showsRemoteHTML.toggle()
                }
            }
            Button("Export as .eml", systemImage: "square.and.arrow.down") {
                Task { await exportRaw() }
            }
            if message.isInbound {
                Button("Report Sender…", systemImage: "hand.raised") { showingBlockPrompt = true }
            }
            Divider()
            Button("Move to Trash", systemImage: "trash", role: .destructive) {
                Task { await model.trashMessage(message) }
            }
            Button("Delete Permanently", systemImage: "trash.fill", role: .destructive) {
                Task { await model.deleteMessage(message) }
            }
        }
    }

    // ─── Banners ────────────────────────────────────────────────────────────

    @ViewBuilder
    private var banners: some View {
        if let verdict = message.spamVerdict, verdict != .clean {
            NoticeBanner(
                symbol: verdict == .spam ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill",
                title: verdict == .spam ? "Looks like spam" : "This message looks suspicious",
                detail: message.spamReasons?.prefix(3).joined(separator: " · "),
                tint: verdict == .spam ? .red : .orange
            )
        }

        if message.pgpEncrypted || message.pgpSigned {
            NoticeBanner(
                symbol: pgpSymbol,
                title: pgpTitle,
                detail: pgpDetail,
                tint: pgpTint,
                actionTitle: message.pgpKeyEvent != nil || message.pgpVerify == .unknown ? "Trust key" : nil,
                action: message.pgpKeyEvent != nil || message.pgpVerify == .unknown
                    ? { Task { await model.trustSender(of: message) } }
                    : nil
            )
        }

        if let blocked = body_?.trackersBlocked, blocked > 0 {
            NoticeBanner(
                symbol: "eye.slash",
                title: "\(blocked) tracker\(blocked == 1 ? "" : "s") blocked",
                detail: "Remote images load through the server, so the sender never sees your address or IP.",
                tint: .green
            )
        }

        if let calendar = body_?.calendar {
            CalendarBanner(event: calendar)
        }

        if message.isNewsletter && message.isInbound && model.canWrite {
            NoticeBanner(
                symbol: "envelope.open",
                title: "Mailing list",
                detail: message.supportsOneClickUnsubscribe
                    ? "The sender supports one-click unsubscribe."
                    : "Unsubscribing may open the sender's page.",
                tint: .blue,
                actionTitle: model.unsubscribing ? "Working…" : "Unsubscribe"
            ) {
                Task {
                    if let url = await model.unsubscribe(from: message) { openURL(url) }
                }
            }
        }
    }

    private var pgpSymbol: String {
        switch message.pgpVerify {
        case .good: "lock.shield.fill"
        case .bad: "lock.trianglebadge.exclamationmark.fill"
        default: message.pgpEncrypted ? "lock.fill" : "signature"
        }
    }

    private var pgpTint: Color {
        switch message.pgpVerify {
        case .good: .green
        case .bad: .red
        case .unknown: .orange
        case nil: message.pgpEncrypted ? .green : .secondary
        }
    }

    private var pgpTitle: String {
        if message.pgpKeyEvent == .rotated { return "Signed with a different key" }
        if message.pgpKeyEvent == .captured { return "New sender key saved" }
        switch (message.pgpEncrypted, message.pgpSigned, message.pgpVerify) {
        case (true, true, .good): return "Encrypted and verified"
        case (true, _, _): return "Encrypted"
        case (_, true, .good): return "Signature verified"
        case (_, true, .bad): return "Signature does not match"
        case (_, true, _): return "Signed — can't verify"
        default: return "PGP"
        }
    }

    private var pgpDetail: String? {
        var parts: [String] = []
        if let signedBy = message.pgpSignedBy?.nilIfBlank { parts.append("Signed by \(signedBy)") }
        if let key = message.pgpKey {
            parts.append("\(key.source.label)\(key.verified ? ", confirmed" : "")")
            parts.append(Self.fingerprint(key.fingerprint))
        }
        if message.pgpEncrypted {
            parts.append("Decrypted by the gateway — this is not end-to-end encryption.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func fingerprint(_ raw: String) -> String {
        let upper = raw.uppercased()
        return stride(from: 0, to: upper.count, by: 4)
            .map { offset in
                let start = upper.index(upper.startIndex, offsetBy: offset)
                let end = upper.index(start, offsetBy: min(4, upper.count - offset))
                return String(upper[start..<end])
            }
            .joined(separator: " ")
    }

    // ─── Body ───────────────────────────────────────────────────────────────

    @ViewBuilder
    private var bodyBlock: some View {
        if let body = body_ {
            if let html = body.html?.nilIfBlank, showsRemoteHTML {
                HTMLMessageView(
                    html: html,
                    baseURL: model.baseURL,
                    height: $bodyHeight,
                    onOpenURL: { openURL($0) }
                )
                .frame(height: bodyHeight)
                .animation(.smooth(duration: 0.2), value: bodyHeight)
            } else if let text = body.text?.nilIfBlank {
                PlainTextBodyView(text: text)
            } else {
                Text("This message has no readable body.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else if model.loadingBodies.contains(message.id) {
            HStack {
                ProgressView().controlSize(.small)
                Text("Loading message…").font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
        } else {
            Text(message.snippet)
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    // ─── Attachments ────────────────────────────────────────────────────────

    private func attachmentsBlock(_ attachments: [Attachment]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                "\(attachments.count) attachment\(attachments.count == 1 ? "" : "s")",
                systemImage: "paperclip"
            )
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)

            ForEach(attachments) { attachment in
                Button {
                    Task { await open(attachment) }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: symbol(for: attachment.contentType))
                            .font(.system(size: 18))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.filename)
                                .font(.subheadline)
                                .lineLimit(1)
                            Text(Fmt.bytes(attachment.sizeBytes))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if downloading.contains(attachment.id) {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.down.circle")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(10)
                    .background(Color(.tertiarySystemGroupedBackground), in: .rect(cornerRadius: 10))
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func symbol(for contentType: String) -> String {
        switch contentType.lowercased() {
        case let type where type.hasPrefix("image/"): "photo"
        case let type where type.hasPrefix("video/"): "film"
        case let type where type.hasPrefix("audio/"): "waveform"
        case let type where type.contains("pdf"): "doc.richtext"
        case let type where type.contains("zip") || type.contains("compressed"): "doc.zipper"
        case let type where type.contains("calendar"): "calendar"
        case let type where type.hasPrefix("text/"): "doc.plaintext"
        default: "doc"
        }
    }

    private func open(_ attachment: Attachment) async {
        guard !downloading.contains(attachment.id) else { return }
        downloading.insert(attachment.id)
        defer { downloading.remove(attachment.id) }
        do {
            previewURL = try await model.download(attachment, of: message)
        } catch {
            model.report(error)
        }
    }

    private func exportRaw() async {
        do {
            previewURL = try await model.downloadRaw(message)
        } catch {
            model.report(error)
        }
    }
}

/// Calendar invites carried by a message (`.ics` → `CalendarEventDto`). The app
/// shows them; it doesn't manage calendars, which matches the server's intent.
struct CalendarBanner: View {
    @Environment(\.openURL) private var openURL
    let event: CalendarEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "calendar")
                    .foregroundStyle(.mint)
                Text(event.summary?.nilIfBlank ?? "Calendar invite")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let method = event.method?.nilIfBlank {
                    Text(method.capitalized)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.mint.opacity(0.16), in: .capsule)
                }
            }
            if let when {
                Label(when, systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            }
            if let location = event.location?.nilIfBlank {
                Label(location, systemImage: "mappin.and.ellipse")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if event.rrule != nil {
                Label("Repeats", systemImage: "repeat").font(.caption).foregroundStyle(.secondary)
            }
            if let organizer = event.organizer {
                Label("Organized by \(organizer.display)", systemImage: "person")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !event.attendees.isEmpty {
                Text(event.attendees.map(\.display).joined(separator: ", "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
            if let meeting = event.meetingUrl.flatMap(URL.init(string:)) {
                Button("Join meeting", systemImage: "video") { openURL(meeting) }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.mint.opacity(0.10), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.mint.opacity(0.22)))
    }

    private var when: String? {
        guard let start = event.start else { return nil }
        if event.allDay {
            guard let end = event.end, Calendar.current.dateComponents([.day], from: start, to: end).day ?? 0 > 1
            else { return start.formatted(date: .complete, time: .omitted) }
            return "\(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
        }
        guard let end = event.end else { return Fmt.messageDate(start) }
        return "\(Fmt.messageDate(start)) – \(end.formatted(date: .omitted, time: .shortened))"
    }
}
