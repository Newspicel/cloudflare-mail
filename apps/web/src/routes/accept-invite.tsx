import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { api } from "@/lib/api.ts";
import { authClient } from "@/lib/auth-client.ts";

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/accept-invite")({
  validateSearch: searchSchema,
  component: AcceptInvitePage,
});

interface InviteInfo {
  email: string;
  role: "admin" | "user";
  used: boolean;
  expired: boolean;
}

function AcceptInvitePage() {
  const nav = useNavigate();
  const { token } = useSearch({ from: Route.id });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const inviteQ = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InviteInfo>(`/api/users/invites/by-token/${encodeURIComponent(token!)}`),
    enabled: Boolean(token),
    retry: false,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    try {
      await api("/api/users/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token, name, password }),
      });
      if (inviteQ.data?.email) {
        const res = await authClient.signIn.email({ email: inviteQ.data.email, password });
        if (res.error) throw new Error(res.error.message ?? "sign-in failed");
      }
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "accept failed");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <CardShell title="Invalid invite link">
        <p className="mb-4 text-sm text-muted-foreground">
          This invitation link is missing a token.
        </p>
        <Link
          to="/login"
          className="mt-1 block text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </Link>
      </CardShell>
    );
  }

  if (inviteQ.isLoading) return <CardShell title="Loading…" />;
  if (inviteQ.error) {
    return (
      <CardShell title="Invite not found">
        <p className="mb-4 text-sm text-muted-foreground">
          This invitation is invalid or has been revoked.
        </p>
      </CardShell>
    );
  }
  if (inviteQ.data?.used) {
    return (
      <CardShell title="Already used">
        <p className="mb-4 text-sm text-muted-foreground">
          This invitation has already been accepted. Sign in with the password you set.
        </p>
        <Link
          to="/login"
          className="mt-1 block text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Sign in
        </Link>
      </CardShell>
    );
  }
  if (inviteQ.data?.expired) {
    return (
      <CardShell title="Expired">
        <p className="mb-4 text-sm text-muted-foreground">
          This invitation has expired. Ask the administrator for a new one.
        </p>
      </CardShell>
    );
  }

  return (
    <CardShell title="Accept invitation">
      <p className="mb-4 text-sm text-muted-foreground">
        Setting up an account for <strong>{inviteQ.data?.email}</strong>.
      </p>
      <form onSubmit={submit}>
        <Field label="Name" value={name} onChange={setName} required />
        <Field
          label="Password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
        />
        <PrimaryButton busy={busy}>Create account</PrimaryButton>
      </form>
    </CardShell>
  );
}
