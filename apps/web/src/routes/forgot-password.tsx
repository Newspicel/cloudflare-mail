import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { authClient } from "@/lib/auth-client.ts";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (res.error) throw new Error(res.error.message ?? "request failed");
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <CardShell title="Check your email">
        <p className="mb-4 text-sm text-muted-foreground">
          If an account exists for <strong>{email}</strong> and email is configured, you'll receive
          a reset link shortly. Administrator accounts cannot be reset this way — contact the system
          administrator.
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

  return (
    <CardShell title="Reset password">
      <p className="mb-4 text-sm text-muted-foreground">
        Enter the email for your account. You'll receive a link to set a new password.
      </p>
      <form onSubmit={submit}>
        <Field label="Email" type="email" value={email} onChange={setEmail} required />
        <PrimaryButton busy={busy}>Send reset link</PrimaryButton>
      </form>
      <Link
        to="/login"
        className="mt-1 block text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Back to sign in
      </Link>
    </CardShell>
  );
}
