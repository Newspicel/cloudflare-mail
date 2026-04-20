import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });
      if (res.error) throw new Error(res.error.message ?? "auth failed");
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-background to-muted p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-xl shadow-black/5"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground text-lg font-semibold">
            ✉
          </div>
          <div>
            <div className="text-lg font-semibold">cfmail</div>
            <div className="text-xs text-muted-foreground">mail on Cloudflare</div>
          </div>
        </div>

        <h1 className="mb-4 text-2xl font-semibold tracking-tight">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>

        {mode === "signup" && (
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium">Name</span>
            <input
              required
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none ring-0 focus:border-ring"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium">Email</span>
          <input
            required
            type="email"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium">Password</span>
          <input
            required
            type="password"
            minLength={8}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="mb-3 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
