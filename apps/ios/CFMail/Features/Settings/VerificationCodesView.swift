import SwiftUI

/// The in-app face of the AutoFill feature: what cfmail has found, and whether
/// iOS is allowed to offer it.
///
/// The point of the feature is that you never come here — the code shows up in
/// the QuickType bar above the keyboard in whatever app asked for it. This
/// screen exists to explain that, to show the switch isn't on yet, and to copy
/// a code by hand when something goes sideways.
struct VerificationCodesView: View {
    @Environment(AppModel.self) private var app

    @State private var codes: [VerificationCode] = []
    @State private var isEnabled = false
    @State private var copied: String?

    var body: some View {
        List {
            Section {
                if isEnabled {
                    Label("cfmail can fill codes for you", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Not turned on yet", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                        Text("Settings → General → AutoFill & Passwords → turn on **cfmail** under “Autofill From”.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.footnote)
                    }
                }
            } header: {
                Text("AutoFill")
            } footer: {
                Text("When a verification code arrives, cfmail offers it above the keyboard in the app or site that asked — the same way Messages does for SMS codes. Codes are kept for 15 minutes and never leave your device.")
            }

            Section {
                if codes.isEmpty {
                    Text("Nothing right now.").foregroundStyle(.secondary)
                }
                ForEach(codes) { code in
                    Button {
                        UIPasteboard.general.string = code.code
                        copied = code.id
                    } label: {
                        HStack(spacing: 12) {
                            Text(code.code)
                                .font(.title3.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.primary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(code.service).font(.subheadline).foregroundStyle(.primary)
                                Text(code.subject)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if copied == code.id {
                                Image(systemName: "checkmark").foregroundStyle(.green)
                            } else {
                                Text(code.receivedAt, style: .relative)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("Live codes")
            } footer: {
                Text("Tap to copy.")
            }

            if !codes.isEmpty {
                Section {
                    Button("Forget all codes", role: .destructive) {
                        Task {
                            await CodeVault.clear()
                            await reload()
                        }
                    }
                }
            }
        }
        .navigationTitle("Verification codes")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .animation(.snappy, value: codes)
    }

    private func reload() async {
        await CodeVault.prune()
        codes = CodeVault.load()
        isEnabled = await CodeVault.isAutoFillEnabled()
        copied = nil
    }
}
