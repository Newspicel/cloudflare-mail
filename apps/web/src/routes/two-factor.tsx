import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { authClient } from "@/lib/auth-client.ts";

export const Route = createFileRoute("/two-factor")({
  component: TwoFactorPage,
});

function TwoFactorPage() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = useBackup
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({ code });
      if (res.error) throw new Error(res.error.message ?? "verify failed");
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "verify failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Two-factor authentication">
      <p className="mb-4 text-sm text-muted-foreground">
        Enter the {useBackup ? "backup code" : "six-digit code"} from your authenticator app.
      </p>
      <form onSubmit={submit}>
        <Field
          label={useBackup ? "Backup code" : "Authenticator code"}
          value={code}
          onChange={setCode}
          required
        />
        <PrimaryButton busy={busy}>Verify</PrimaryButton>
      </form>
      <button
        type="button"
        onClick={() => setUseBackup((v) => !v)}
        className="mt-1 block w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        {useBackup ? "Use authenticator code instead" : "Use a backup code instead"}
      </button>
      <Link
        to="/login"
        className="mt-3 block text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Back to sign in
      </Link>
    </CardShell>
  );
}
