import { has, Perm } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MailboxSettingsForm } from "@/components/mailbox-settings-form.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { api } from "@/lib/api.ts";
import { authClient } from "@/lib/auth-client.ts";
import { cn } from "@/lib/cn.ts";
import { disablePush, enablePush, isPushEnabled, pushSupported } from "@/lib/push.ts";
import { type MailboxSummary, mailboxesQuery, meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const me = useQuery(meQuery);
  const mailboxesQ = useQuery(mailboxesQuery);
  const editable = (mailboxesQ.data?.mailboxes ?? []).filter(
    (m) => m.type !== "temp" && has(m.perms, Perm.MANAGE),
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header>
          <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Profile, security, and per-mailbox preferences.
          </p>
        </header>

        <Section title="Profile">
          <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{me.data?.user?.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{me.data?.user?.email}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              <span className="inline-flex items-center rounded border bg-muted px-1.5 py-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {me.data?.user?.role ?? "—"}
              </span>
            </dd>
          </dl>
        </Section>

        <TwoFactorSection enabled={!!me.data?.user?.twoFactorEnabled} />

        <NotificationsSection mailboxes={mailboxesQ.data?.mailboxes ?? []} />

        <div>
          <h2 className="mb-3 text-[14px] font-semibold tracking-tight">Mailboxes</h2>
          {editable.length === 0 && (
            <div className="rounded-md border bg-card px-5 py-4 text-[13px] text-muted-foreground">
              No editable mailboxes yet.
            </div>
          )}
          <div className="space-y-4">
            {editable.map((m) => (
              <MailboxSettingsForm key={m.id} mailboxId={m.id} address={m.address} type={m.type} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card">
      <header className="border-b px-5 py-3">
        <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "rounded-md border bg-background px-2.5 py-1.5 text-[13px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20",
        props.className,
      )}
    />
  );
}

function PrimaryBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50",
        props.className,
      )}
    />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition hover:bg-muted"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function totpSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [verifyCode, setVerifyCode] = useState("");

  const enable = useMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.enable({ password });
      if (res.error) throw new Error(res.error.message ?? "enable failed");
      return res.data;
    },
    onSuccess: (data) => {
      setTotpUri(data?.totpURI ?? null);
      setBackupCodes(data?.backupCodes ?? null);
      setPassword("");
      toast.success("Scan the QR / save backup codes, then verify below");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const verify = useMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.verifyTotp({ code: verifyCode });
      if (res.error) throw new Error(res.error.message ?? "verify failed");
    },
    onSuccess: () => {
      setVerifyCode("");
      setTotpUri(null);
      setBackupCodes(null);
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Two-factor enabled");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.disable({ password });
      if (res.error) throw new Error(res.error.message ?? "disable failed");
    },
    onSuccess: () => {
      setPassword("");
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Two-factor disabled");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const secret = totpUri ? totpSecret(totpUri) : null;

  return (
    <Section
      title="Two-factor authentication"
      description={
        enabled
          ? "TOTP is currently enabled on your account."
          : "Protect your sign-in with a TOTP authenticator app. Backup codes will be shown once."
      }
    >
      {!enabled && !totpUri && (
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="Current password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1"
          />
          <PrimaryBtn onClick={() => enable.mutate()} disabled={!password || enable.isPending}>
            Enable 2FA
          </PrimaryBtn>
        </div>
      )}

      {totpUri && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Authenticator setup
            </div>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <div className="rounded-md bg-white p-2">
                <QRCodeSVG value={totpUri} size={144} />
              </div>
              <div className="min-w-0 space-y-2">
                <div className="text-[11px] text-muted-foreground">
                  Scan with your authenticator app, or enter the secret manually.
                </div>
                {secret && <div className="font-mono text-[12px] break-all">{secret}</div>}
                <div className="flex flex-wrap gap-2">
                  {secret && <CopyButton value={secret} label="Copy secret" />}
                  <CopyButton value={totpUri} label="Copy URI" />
                </div>
              </div>
            </div>
          </div>
          {backupCodes && backupCodes.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Backup codes (save these now)
              </div>
              <ul className="grid grid-cols-2 gap-1 font-mono">
                {backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Code from authenticator"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              className="flex-1"
            />
            <PrimaryBtn onClick={() => verify.mutate()} disabled={!verifyCode || verify.isPending}>
              Verify
            </PrimaryBtn>
          </div>
        </div>
      )}

      {enabled && (
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="Current password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => disable.mutate()}
            disabled={!password || disable.isPending}
            className="rounded-md border px-3 py-1.5 text-[13px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
          >
            Disable 2FA
          </button>
        </div>
      )}
    </Section>
  );
}

function NotificationsSection({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const qc = useQueryClient();
  const supported = pushSupported();
  const [deviceOn, setDeviceOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    isPushEnabled()
      .then(setDeviceOn)
      .catch(() => {});
  }, []);

  const toggleDevice = async () => {
    setBusy(true);
    try {
      if (deviceOn) {
        await disablePush();
        setDeviceOn(false);
        toast.success("Notifications disabled on this device");
      } else {
        await enablePush();
        setDeviceOn(true);
        toast.success("Notifications enabled on this device");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const enabledQ = useQuery({
    queryKey: ["push-mailboxes"],
    queryFn: () => api<{ enabled: string[] }>("/api/push/mailboxes"),
  });
  const enabledSet = new Set(enabledQ.data?.enabled ?? []);

  const toggleMailbox = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/push/mailboxes/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["push-mailboxes"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Service mailboxes are send-only — they never receive mail to notify on.
  const receivable = mailboxes.filter((m) => m.type !== "service");

  return (
    <Section
      title="Notifications"
      description="Get a push notification when new mail arrives. Enable this device, then choose which mailboxes notify you."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="text-[13px]">
          <div className="font-medium">This device</div>
          <div className="text-[12px] text-muted-foreground">
            {supported
              ? deviceOn
                ? "Receiving notifications"
                : "Not enabled"
              : "Not supported in this browser"}
          </div>
        </div>
        <PrimaryBtn onClick={toggleDevice} disabled={!supported || busy}>
          {deviceOn ? "Disable" : "Enable"}
        </PrimaryBtn>
      </div>

      {receivable.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Per mailbox
          </div>
          <ul className="divide-y">
            {receivable.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 py-2 text-[13px]">
                <span className="min-w-0 truncate">{m.displayName ?? m.address}</span>
                <Switch
                  checked={enabledSet.has(m.id)}
                  disabled={toggleMailbox.isPending}
                  onCheckedChange={(checked) =>
                    toggleMailbox.mutate({ id: m.id, enabled: checked })
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
