import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { authClient } from "@/lib/auth-client.ts";

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/reset-password")({
  validateSearch: searchSchema,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const nav = useNavigate();
  const { token } = useSearch({ from: Route.id });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    try {
      const res = await authClient.resetPassword({ newPassword: password, token });
      if (res.error) throw new Error(res.error.message ?? "reset failed");
      toast.success("Password updated — please sign in");
      nav({ to: "/login" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "reset failed");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <CardShell title="Invalid link">
        <p className="mb-4 text-sm text-muted-foreground">
          This reset link is missing a token. Request a new one.
        </p>
        <Link
          to="/forgot-password"
          className="mt-1 block text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Request password reset
        </Link>
      </CardShell>
    );
  }

  return (
    <CardShell title="Set new password">
      <form onSubmit={submit}>
        <Field
          label="New password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
        />
        <PrimaryButton busy={busy}>Update password</PrimaryButton>
      </form>
    </CardShell>
  );
}
