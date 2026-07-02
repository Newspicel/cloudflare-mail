import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { CopyButton, GroupLabel, Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { authClient } from "@/lib/auth-client.ts";
import { meQuery } from "@/lib/queries.ts";

// qrcode.react is only needed during 2FA enrollment — load it on demand.
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));

function totpSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

export function TwoFactorSection({ enabled }: { enabled: boolean }) {
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
      qc.invalidateQueries({ queryKey: meQuery.queryKey });
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
      qc.invalidateQueries({ queryKey: meQuery.queryKey });
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
      qc.invalidateQueries({ queryKey: meQuery.queryKey });
      toast.success("Two-factor disabled");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const secret = totpUri ? totpSecret(totpUri) : null;

  return (
    <Section
      id="two-factor"
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
          <Button
            variant="primary"
            onClick={() => enable.mutate()}
            disabled={!password || enable.isPending}
          >
            Enable 2FA
          </Button>
        </div>
      )}

      {totpUri && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
            <GroupLabel className="mb-2">Authenticator setup</GroupLabel>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <div className="rounded-md bg-white p-2">
                <Suspense fallback={<div className="size-36" />}>
                  <QRCodeSVG value={totpUri} size={144} />
                </Suspense>
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
              <GroupLabel className="mb-1.5">Backup codes (save these now)</GroupLabel>
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
            <Button
              variant="primary"
              onClick={() => verify.mutate()}
              disabled={!verifyCode || verify.isPending}
            >
              Verify
            </Button>
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
          <Button
            variant="outline"
            onClick={() => disable.mutate()}
            disabled={!password || disable.isPending}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Disable 2FA
          </Button>
        </div>
      )}
    </Section>
  );
}
