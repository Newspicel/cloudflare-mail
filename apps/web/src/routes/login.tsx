import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { authClient } from "@/lib/auth-client.ts";
import { bootstrapQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const bootstrap = useQuery(bootstrapQuery);
  if (bootstrap.isLoading) {
    return <CardShell title="Loading…" />;
  }
  if (bootstrap.data?.needsBootstrap) {
    return <BootstrapForm />;
  }
  return <SignInForm />;
}

function BootstrapForm() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/bootstrap", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `bootstrap failed (${res.status})`);
      }
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "bootstrap failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Create administrator">
      <p className="mb-4 text-sm text-muted-foreground">
        First-run setup: this account becomes the system administrator. There is no public signup
        afterwards — the admin invites or creates users from the dashboard.
      </p>
      <form onSubmit={submit}>
        <Field label="Name" value={name} onChange={setName} required />
        <Field label="Email" type="email" value={email} onChange={setEmail} required />
        <Field
          label="Password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
        />
        <PrimaryButton busy={busy}>Create administrator</PrimaryButton>
      </form>
    </CardShell>
  );
}

function SignInForm() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message ?? "sign-in failed");
      // Better Auth's twoFactor plugin redirects to /two-factor via
      // onTwoFactorRedirect when a 2FA step is required.
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  // Conditional UI: preload passkeys so the browser can offer one in the
  // email field's autofill. No-op on browsers without conditional mediation.
  useEffect(() => {
    if (
      typeof PublicKeyCredential === "undefined" ||
      !PublicKeyCredential.isConditionalMediationAvailable
    ) {
      return;
    }
    PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
      if (ok) void authClient.signIn.passkey({ autoFill: true });
    });
  }, []);

  async function passkeySignIn() {
    setBusy(true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) throw new Error(res.error.message ?? "passkey sign-in failed");
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Sign in">
      <form onSubmit={submit}>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="username webauthn"
        />
        <Field
          label="Password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
          autoComplete="current-password webauthn"
        />
        <PrimaryButton busy={busy}>Sign in</PrimaryButton>
      </form>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={busy}
        onClick={passkeySignIn}
        className="mt-1 w-full"
      >
        <KeyRound className="size-4" />
        Sign in with a passkey
      </Button>
      <Link
        to="/forgot-password"
        className="mt-3 block w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Forgot password?
      </Link>
    </CardShell>
  );
}
