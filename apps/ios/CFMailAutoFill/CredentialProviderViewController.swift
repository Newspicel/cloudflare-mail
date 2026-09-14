import AuthenticationServices
import SwiftUI
import UIKit

/// AutoFill provider for verification codes found in mail.
///
/// The app writes codes into the shared Keychain and registers one
/// `ASOneTimeCodeCredentialIdentity` per live code; iOS then offers them in the
/// QuickType bar of whatever is asking. This extension's whole job is turning a
/// chosen identity back into its code — no network, no session, no UI in the
/// common case.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    /// QuickType path: the reader picked a suggestion, so answer immediately.
    override func provideCredentialWithoutUserInteraction(for request: any ASCredentialRequest) {
        guard let request = request as? ASOneTimeCodeCredentialRequest,
              let identity = request.credentialIdentity as? ASOneTimeCodeCredentialIdentity,
              let recordIdentifier = identity.recordIdentifier,
              let stored = CodeVault.code(forRecord: recordIdentifier),
              stored.isLive
        else {
            cancel(.credentialIdentityNotFound)
            return
        }
        extensionContext.completeOneTimeCodeRequest(
            using: ASOneTimeCodeCredential(code: stored.code)
        )
    }

    /// Shown when the system decides the pick needs confirming.
    override func prepareInterfaceToProvideCredential(for request: any ASCredentialRequest) {
        guard let request = request as? ASOneTimeCodeCredentialRequest,
              let identity = request.credentialIdentity as? ASOneTimeCodeCredentialIdentity,
              let recordIdentifier = identity.recordIdentifier,
              let stored = CodeVault.code(forRecord: recordIdentifier),
              stored.isLive
        else {
            present(codes: CodeVault.load())
            return
        }
        extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: stored.code))
    }

    /// Reached from the "show all codes" button in a code field: list what's
    /// live. This is the one-time-code flavour of the list callback; the
    /// password one never fires because the extension declares passwords off.
    override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let wanted = Set(serviceIdentifiers.map { $0.identifier.lowercased() })
        let all = CodeVault.load()
        // Codes for the asking site first, everything else after — the reader
        // may be pasting into a different app than the mail was addressed to.
        let ranked = all.sorted { lhs, rhs in
            let l = wanted.contains { $0.contains(lhs.domain) }
            let r = wanted.contains { $0.contains(rhs.domain) }
            return l == r ? lhs.receivedAt > rhs.receivedAt : l
        }
        present(codes: ranked)
    }

    // ─── UI ─────────────────────────────────────────────────────────────────

    private func present(codes: [VerificationCode]) {
        let view = CodeListView(
            codes: codes,
            onPick: { [weak self] code in
                self?.extensionContext.completeOneTimeCodeRequest(
                    using: ASOneTimeCodeCredential(code: code.code)
                )
            },
            onCancel: { [weak self] in self?.cancel(.userCanceled) }
        )
        let host = UIHostingController(rootView: view)
        addChild(host)
        host.view.frame = self.view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func cancel(_ code: ASExtensionError.Code) {
        extensionContext.cancelRequest(
            withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue)
        )
    }
}

/// The picker shown when the system asks for UI. Deliberately plain: it exists
/// to be tapped once and dismissed.
private struct CodeListView: View {
    let codes: [VerificationCode]
    var onPick: (VerificationCode) -> Void
    var onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if codes.isEmpty {
                    ContentUnavailableView {
                        Label("No codes", systemImage: "number")
                    } description: {
                        Text("Verification codes appear here for 15 minutes after cfmail receives them.")
                    }
                }
                ForEach(codes) { code in
                    Button {
                        onPick(code)
                    } label: {
                        HStack(spacing: 12) {
                            Text(code.code)
                                .font(.title3.monospacedDigit().weight(.semibold))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(code.service).font(.subheadline)
                                Text(code.domain)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(code.receivedAt, style: .relative)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("Verification codes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}
