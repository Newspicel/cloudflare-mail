import { has, Perm } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
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
    <div className="mx-auto max-w-2xl space-y-6 p-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-2 text-lg font-medium">Profile</h2>
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{me.data?.user?.name}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{me.data?.user?.email}</dd>
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Mailboxes</h2>
        {editable.length === 0 && (
          <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
            No editable mailboxes yet.
          </p>
        )}
        {editable.map((m) => (
          <MailboxSettingsForm key={m.id} mailbox={m} />
        ))}
      </section>
    </div>
  );
}

interface MailboxSettings {
  id: string;
  type: "personal" | "group" | "service" | "temp";
  displayName: string | null;
  signature: string | null;
  replyTo: string | null;
}

function MailboxSettingsForm({ mailbox }: { mailbox: MailboxSummary }) {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ["mailbox-settings", mailbox.id],
    queryFn: () => api<MailboxSettings>(`/api/mailboxes/${mailbox.id}/settings`),
  });

  const [displayName, setDisplayName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    if (settingsQ.data) {
      setDisplayName(settingsQ.data.displayName ?? "");
      setReplyTo(settingsQ.data.replyTo ?? "");
      setSignature(settingsQ.data.signature ?? "");
    }
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/mailboxes/${mailbox.id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          replyTo: replyTo.trim() || null,
          signature: signature.trim() ? signature : null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mailbox-settings", mailbox.id] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      toast.success("Settings saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="rounded-xl border bg-card p-6"
    >
      <div className="mb-4">
        <div className="font-medium">{mailbox.address}</div>
        <div className="text-xs text-muted-foreground">{mailbox.type}</div>
      </div>
      <div className="grid gap-4 text-sm">
        <label className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Support"
            className="rounded-md border bg-background px-3 py-2 outline-none focus:border-ring"
            maxLength={200}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Reply-to address</span>
          <input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="replies@example.com"
            className="rounded-md border bg-background px-3 py-2 outline-none focus:border-ring"
            maxLength={320}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Signature</span>
          <textarea
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            rows={4}
            placeholder="Appended to every outgoing message"
            className="min-h-[6rem] resize-y rounded-md border bg-background px-3 py-2 outline-none focus:border-ring"
            maxLength={5000}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={save.isPending || settingsQ.isLoading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
