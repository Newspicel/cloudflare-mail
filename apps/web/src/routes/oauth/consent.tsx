import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CardShell } from "@/components/auth-card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { authClient, followOAuthRedirect } from "@/lib/auth-client.ts";

// Better Auth's OAuth provider sends the user here (with a signed query) the
// first time an MCP client asks for access. Approving stores the consent and
// returns the browser to the client with an authorization code; the consent is
// what Settings → Connected apps lists and revokes.
export const Route = createFileRoute("/oauth/consent")({
  component: ConsentPage,
});

// CIMD client ids are URLs; anything else (or a malformed client_uri) just
// shows as given.
function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function ConsentPage() {
  const clientId = new URLSearchParams(window.location.search).get("client_id") ?? "";
  const [busy, setBusy] = useState(false);
  const { data: client, isLoading } = useQuery({
    queryKey: ["oauth-client", clientId],
    queryFn: async () => {
      const res = await authClient.oauth2.publicClient({ query: { client_id: clientId } });
      if (res.error) throw new Error(res.error.message ?? "unknown app");
      return res.data;
    },
    enabled: Boolean(clientId),
    retry: false,
  });

  async function decide(accept: boolean) {
    setBusy(true);
    try {
      const res = await authClient.oauth2.consent({ accept });
      if (res.error) throw new Error(res.error.message ?? "could not record your choice");
      if (!followOAuthRedirect(res.data)) throw new Error("the app gave no address to return to");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "could not record your choice");
      setBusy(false);
    }
  }

  if (isLoading) return <CardShell title="Loading…" />;
  if (!client) {
    return (
      <CardShell title="Unknown app">
        <p className="text-sm text-muted-foreground">
          This authorization request is missing or has expired. Start again from the app.
        </p>
      </CardShell>
    );
  }

  const name = client.client_name ?? clientId;
  const host = hostOf(client.client_uri) ?? hostOf(clientId) ?? clientId;
  return (
    <CardShell title={`Allow ${name}?`}>
      <p className="mb-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{host}</span> wants access to your mail.
      </p>
      <ul className="mb-5 list-disc space-y-1 pl-5 text-sm">
        <li>Read and search mail in every mailbox you can open</li>
        <li>Mark, star, label, trash and flag threads where you may edit</li>
        <li>Send mail and replies from mailboxes you may write to</li>
      </ul>
      <p className="mb-5 text-[12px] text-muted-foreground">
        You can revoke this at any time in Settings → Connected apps.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="lg"
          disabled={busy}
          onClick={() => decide(false)}
          className="flex-1"
        >
          Deny
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={busy}
          onClick={() => decide(true)}
          className="flex-1"
        >
          Allow
        </Button>
      </div>
    </CardShell>
  );
}
