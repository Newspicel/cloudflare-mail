import type { AppPasswordCreatedDto } from "@cfmail/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton, GroupLabel, Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import { appPasswordsQuery, type MailboxSummary } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { formatDateTime } from "@/lib/time.ts";

export function AppPasswordsSection({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const qc = useQueryClient();
  const fmt = useDateTimeFmt();
  const { confirmDelete } = useConfirmHelpers();
  const { data } = useQuery(appPasswordsQuery);
  const passwords = data?.passwords ?? [];
  const imap = data?.imap ?? null;

  // Service mailboxes are key-driven and never user-facing; temp ones expire.
  const eligible = mailboxes.filter((m) => m.type !== "service" && m.type !== "temp");
  const options = eligible.map((m) => ({ value: m.id, label: m.address }));
  const [pickedMailbox, setPickedMailbox] = useState("");
  const mailboxId = pickedMailbox || eligible[0]?.id || "";
  const [name, setName] = useState("");
  const [created, setCreated] = useState<AppPasswordCreatedDto | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: keys.appPasswords() });

  const create = useMutation({
    mutationFn: () => unwrap(rpc["app-passwords"].$post({ json: { mailboxId, name } })),
    onSuccess: (res) => {
      setCreated(res);
      setName("");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(rpc["app-passwords"][":id"].$delete({ param: { id } })),
    onSuccess: () => {
      invalidate();
      toast.success("App password revoked");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  async function onRevoke(id: string, label: string) {
    const ok = await confirmDelete(
      `app password "${label}"`,
      "Any mail app using it will stop syncing immediately.",
    );
    if (ok) remove.mutate(id);
  }

  return (
    <Section
      id="imap"
      title="IMAP access"
      description="Read this mailbox from Apple Mail, Thunderbird, Outlook or any other mail app. Each app password unlocks one mailbox and can be revoked here at any time."
    >
      <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
        <GroupLabel className="mb-2">Server settings</GroupLabel>
        {imap ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="font-mono">{imap.host}</dd>
            <dt className="text-muted-foreground">Port</dt>
            <dd className="font-mono">{imap.port} (SSL/TLS)</dd>
            <dt className="text-muted-foreground">Username</dt>
            <dd className="font-mono">the mailbox address</dd>
            <dt className="text-muted-foreground">Password</dt>
            <dd>an app password from below</dd>
          </dl>
        ) : (
          <div className="text-muted-foreground">
            The IMAP hostname hasn't been configured yet — an admin sets it under Admin → Domains.
            Passwords created now will work once it is.
          </div>
        )}
      </div>

      {eligible.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Select
            items={options}
            value={mailboxId}
            onValueChange={(v) => setPickedMailbox((v ?? "") as string)}
          >
            <SelectTrigger className="sm:w-56" aria-label="Mailbox">
              <SelectValue placeholder="Mailbox" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()}
            placeholder="Device or app name (e.g. iPhone)"
            maxLength={64}
            className="flex-1"
          />
          <Button
            variant="primary"
            onClick={() => create.mutate()}
            disabled={!name.trim() || !mailboxId || create.isPending}
          >
            Create password
          </Button>
        </div>
      )}

      <div className="mt-4 border-t pt-4">
        <GroupLabel className="mb-1.5">App passwords</GroupLabel>
        {passwords.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">No app passwords yet.</div>
        ) : (
          <ul className="divide-y">
            {passwords.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {p.mailboxAddress} · created {formatDateTime(new Date(p.createdAt), fmt)}
                    {p.lastUsedAt
                      ? ` · last used ${formatDateTime(new Date(p.lastUsedAt), fmt)}`
                      : " · never used"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${p.name}`}
                  disabled={remove.isPending}
                  onClick={() => onRevoke(p.id, p.name)}
                  className="hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>App password created</DialogTitle>
            <DialogDescription>
              Copy it into your mail app now — it won't be shown again.
            </DialogDescription>
          </DialogHeader>
          {created && (
            <div className="space-y-3 text-[13px]">
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
                <code className="font-mono text-[15px] tracking-wider">{created.password}</code>
                <CopyButton value={created.password} label="Copy" />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">Server</dt>
                <dd className="font-mono">{imap?.host ?? "(ask your admin)"}</dd>
                <dt className="text-muted-foreground">Port</dt>
                <dd className="font-mono">{imap?.port ?? 993} (SSL/TLS)</dd>
                <dt className="text-muted-foreground">Username</dt>
                <dd className="flex items-center gap-2">
                  <span className="font-mono">{created.username}</span>
                  <CopyButton value={created.username} label="Copy" />
                </dd>
              </dl>
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="primary">Done</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
