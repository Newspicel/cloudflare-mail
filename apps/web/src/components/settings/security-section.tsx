import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GroupLabel, Section } from "@/components/settings-ui.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { Input } from "@/components/ui/input.tsx";
import { authClient } from "@/lib/auth-client.ts";

interface SessionRow {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string | Date;
}

interface PasskeyRow {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  createdAt: string | Date;
}

function PasskeyRowEditor({
  passkey,
  busy,
  onRename,
  onDelete,
}: {
  passkey: PasskeyRow;
  busy: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(passkey.name ?? "");
  const created = new Date(passkey.createdAt).toLocaleDateString();

  return (
    <li className="flex items-center gap-2 py-2.5 text-[13px]">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <Input
          value={name}
          placeholder="Passkey"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          maxLength={64}
          className="h-8"
        />
        <div className="mt-1 text-[12px] text-muted-foreground">Added {created}</div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete passkey"
        disabled={busy}
        onClick={onDelete}
        className="hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function shortUA(ua?: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Firefox/.test(ua)
    ? "Firefox"
    : /Edg/.test(ua)
      ? "Edge"
      : /Chrome/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Macintosh|Mac OS/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}

export function SecuritySection() {
  const qc = useQueryClient();
  const { confirm, confirmDelete } = useConfirmHelpers();
  const { data: current } = authClient.useSession();
  const currentToken = current?.session?.token;

  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");

  const changePw = useMutation({
    mutationFn: async () => {
      const res = await authClient.changePassword({
        currentPassword: curPw,
        newPassword: newPw,
        revokeOtherSessions: true,
      });
      if (res.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => {
      setCurPw("");
      setNewPw("");
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Password changed; other devices signed out");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const { data: passkeysData, isLoading: passkeysLoading } = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => {
      const res = await authClient.passkey.listUserPasskeys();
      if (res.error) throw new Error(res.error.message ?? "Failed");
      return (res.data ?? []) as unknown as PasskeyRow[];
    },
  });

  const addPasskey = useMutation({
    mutationFn: async () => {
      // addPasskey always resolves to a { data, error } object — it never throws,
      // even when the WebAuthn ceremony is cancelled. Inspect error explicitly.
      const res = await authClient.passkey.addPasskey();
      if (res?.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["passkeys"] });
      toast.success("Passkey added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const renamePasskey = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await authClient.passkey.updatePasskey({ id, name });
      if (res.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removePasskey = useMutation({
    mutationFn: async (id: string) => {
      const res = await authClient.passkey.deletePasskey({ id });
      if (res.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const passkeys = passkeysData ?? [];

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const res = await authClient.listSessions();
      if (res.error) throw new Error(res.error.message ?? "Failed");
      return (res.data ?? []) as unknown as SessionRow[];
    },
  });

  const revoke = useMutation({
    mutationFn: async (token: string) => {
      const res = await authClient.revokeSession({ token });
      if (res.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const revokeOthers = useMutation({
    mutationFn: async () => {
      const res = await authClient.revokeOtherSessions();
      if (res.error) throw new Error(res.error.message ?? "Failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Signed out other devices");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const sessions = sessionsData ?? [];
  const hasOthers = sessions.some((s) => s.token !== currentToken);

  return (
    <Section
      id="security"
      title="Security"
      description="Password and active sessions."
      contentClassName="space-y-5"
    >
      <div className="space-y-2.5">
        <GroupLabel>Change password</GroupLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            placeholder="Current password"
            value={curPw}
            onChange={(e) => setCurPw(e.target.value)}
            className="flex-1"
            autoComplete="current-password"
          />
          <Input
            type="password"
            placeholder="New password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            className="flex-1"
            autoComplete="new-password"
          />
          <Button
            variant="primary"
            onClick={() => changePw.mutate()}
            disabled={!curPw || newPw.length < 8 || changePw.isPending}
          >
            Update
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Changing your password signs out all other devices.
        </p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <GroupLabel>Passkeys</GroupLabel>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => addPasskey.mutate()}
            disabled={addPasskey.isPending}
          >
            <KeyRound className="size-3.5" />
            Add passkey
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Sign in with your fingerprint, face, or a security key instead of a password.
        </p>
        {passkeysLoading && <div className="text-[12px] text-muted-foreground">Loading…</div>}
        {!passkeysLoading && passkeys.length === 0 && (
          <div className="text-[13px] text-muted-foreground">No passkeys yet.</div>
        )}
        <ul className="divide-y">
          {passkeys.map((p) => (
            <PasskeyRowEditor
              key={`${p.id}:${p.name ?? ""}`}
              passkey={p}
              busy={renamePasskey.isPending || removePasskey.isPending}
              onRename={(name) =>
                name && name !== (p.name ?? "") && renamePasskey.mutate({ id: p.id, name })
              }
              onDelete={async () => {
                if (await confirmDelete(`passkey "${p.name || "Passkey"}"`))
                  removePasskey.mutate(p.id);
              }}
            />
          ))}
        </ul>
      </div>

      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <GroupLabel>Active sessions</GroupLabel>
          {hasOthers && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Sign out all other devices?",
                    description: "Every session except this one will be revoked.",
                    confirmLabel: "Sign out",
                    destructive: true,
                  })
                )
                  revokeOthers.mutate();
              }}
              disabled={revokeOthers.isPending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Sign out other devices
            </Button>
          )}
        </div>
        {sessionsLoading && <div className="text-[12px] text-muted-foreground">Loading…</div>}
        <ul className="divide-y">
          {sessions.map((s) => {
            const isCurrent = s.token === currentToken;
            return (
              <li key={s.id} className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    {shortUA(s.userAgent)}
                    {isCurrent && (
                      <Badge variant="primary" className="uppercase tracking-wider">
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="text-[12px] text-muted-foreground">{s.ipAddress ?? "—"}</div>
                </div>
                {!isCurrent && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: "Revoke this session?",
                          description: `${shortUA(s.userAgent)} will be signed out.`,
                          confirmLabel: "Revoke",
                          destructive: true,
                        })
                      )
                        revoke.mutate(s.token);
                    }}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
