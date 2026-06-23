import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { inputClass } from "@/components/ui/input.tsx";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type ImportProgress, runImport } from "@/lib/import.ts";
import { keys } from "@/lib/query-keys.ts";

export type SpamLevel = "off" | "auth" | "standard" | "ai";

interface MailboxSettings {
  id: string;
  type: "personal" | "group" | "service" | "temp";
  displayName: string | null;
  signature: string | null;
  replyTo: string | null;
  spamFilter: SpamLevel;
  spamAiTokenCap: number | null;
  spamUsage: { period: string; calls: number; tokens: number } | null;
}

export const SPAM_LEVELS: { value: SpamLevel; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No spam filtering." },
  { value: "auth", label: "Authentication only", hint: "Flag mail that fails SPF/DKIM/DMARC." },
  {
    value: "standard",
    label: "Standard",
    hint: "Authentication + content heuristics + IP blocklist.",
  },
  { value: "ai", label: "AI", hint: "Standard plus AI review of uncertain mail." },
];

/**
 * Per-mailbox settings form. Identity fields (display name, reply-to, signature)
 * are always editable by anyone with MANAGE; the spam filter level + AI budget are
 * admin-only, so they render read-only unless `admin` is set (which also routes
 * reads/writes through the admin endpoint).
 */
export function MailboxSettingsForm({
  mailboxId,
  address,
  type,
  admin = false,
}: {
  mailboxId: string;
  address: string;
  type: MailboxSettings["type"];
  admin?: boolean;
}) {
  const qc = useQueryClient();
  const base = admin
    ? `/api/admin/mailboxes/${mailboxId}/settings`
    : `/api/mailboxes/${mailboxId}/settings`;
  const queryKey = [admin ? "admin-mailbox-settings" : "mailbox-settings", mailboxId];
  const settingsQ = useQuery({
    queryKey,
    queryFn: () => api<MailboxSettings>(base),
  });

  const [displayName, setDisplayName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [signature, setSignature] = useState("");
  const [spamFilter, setSpamFilter] = useState<SpamLevel>("standard");
  const [aiCap, setAiCap] = useState("");

  useEffect(() => {
    if (settingsQ.data) {
      setDisplayName(settingsQ.data.displayName ?? "");
      setReplyTo(settingsQ.data.replyTo ?? "");
      setSignature(settingsQ.data.signature ?? "");
      setSpamFilter(settingsQ.data.spamFilter ?? "standard");
      setAiCap(settingsQ.data.spamAiTokenCap ? String(settingsQ.data.spamAiTokenCap) : "");
    }
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: () =>
      api(base, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          replyTo: replyTo.trim() || null,
          signature: signature.trim() ? signature : null,
          ...(admin ? { spamFilter, spamAiTokenCap: aiCap.trim() ? Number(aiCap) : null } : {}),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: keys.mailboxes() });
      toast.success("Settings saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const spamLabel = SPAM_LEVELS.find((l) => l.value === spamFilter);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="rounded-md border bg-card"
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{address}</div>
            <div className="text-[11px] text-muted-foreground">{type}</div>
          </div>
        </header>
        <div className="grid gap-4 px-5 py-4 text-[13px]">
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium text-foreground">Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Support"
              maxLength={200}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium text-foreground">Reply-to address</span>
            <input
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="replies@example.com"
              maxLength={320}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium text-foreground">Signature</span>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={4}
              placeholder="Appended to every outgoing message"
              className={cn(inputClass, "h-auto min-h-[6rem] resize-y py-2 leading-normal")}
              maxLength={5000}
            />
          </label>
          {type !== "service" && admin && (
            <label className="grid gap-1.5">
              <span className="text-[11px] font-medium text-foreground">Spam filter</span>
              <select
                value={spamFilter}
                onChange={(e) => setSpamFilter(e.target.value as SpamLevel)}
                className={cn(inputClass, "cursor-pointer appearance-none")}
              >
                {SPAM_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted-foreground">{spamLabel?.hint}</span>
            </label>
          )}
          {type !== "service" && !admin && (
            <div className="grid gap-1.5">
              <span className="text-[11px] font-medium text-foreground">Spam filter</span>
              <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-[13px] text-muted-foreground">
                {spamLabel?.label ?? spamFilter}
              </div>
              <span className="text-[11px] text-muted-foreground">
                Set by your administrator. {spamLabel?.hint}
              </span>
            </div>
          )}
          {admin && spamFilter === "ai" && type !== "service" && (
            <label className="grid gap-1.5">
              <span className="text-[11px] font-medium text-foreground">
                AI monthly token budget
              </span>
              <input
                type="number"
                min={0}
                value={aiCap}
                onChange={(e) => setAiCap(e.target.value)}
                placeholder="Unlimited"
                className={inputClass}
              />
              <span className="text-[11px] text-muted-foreground">
                {settingsQ.data?.spamUsage
                  ? `Used ${settingsQ.data.spamUsage.tokens.toLocaleString()} tokens across ${settingsQ.data.spamUsage.calls} checks this month (${settingsQ.data.spamUsage.period}). AI falls back to Standard when the budget is reached.`
                  : "Leave empty for unlimited. AI runs only on uncertain mail to keep usage low."}
              </span>
            </label>
          )}
        </div>
        <div className="flex justify-end border-t bg-muted/30 px-5 py-2.5">
          <Button type="submit" variant="primary" disabled={save.isPending || settingsQ.isLoading}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
      {!admin && type !== "service" && <MailboxImportCard mailboxId={mailboxId} />}
    </div>
  );
}

/**
 * Bulk-import exported mail (.eml/.mbox/.zip) into this mailbox. Extraction runs
 * in the browser; each message is POSTed individually so large archives never
 * hit a Worker body/time limit. Imported mail is marked read and deduped by
 * Message-ID, so re-running an import is safe.
 */
function MailboxImportCard({ mailboxId }: { mailboxId: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);

  async function start() {
    if (!files.length || running) return;
    setRunning(true);
    setProgress(null);
    try {
      const result = await runImport(mailboxId, files, setProgress);
      const imported = result.done - result.duplicate - result.failed;
      const extra = [
        result.duplicate ? `${result.duplicate} skipped` : "",
        result.failed ? `${result.failed} failed` : "",
      ]
        .filter(Boolean)
        .join(", ");
      toast.success(
        `Imported ${imported} message${imported === 1 ? "" : "s"}${extra ? ` (${extra})` : ""}`,
      );
      qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
      qc.invalidateQueries({ queryKey: keys.mailboxes() });
      qc.invalidateQueries({ queryKey: keys.folders() });
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  }

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="rounded-md border bg-card">
      <header className="border-b px-5 py-3">
        <div className="font-medium">Import mail</div>
        <div className="text-[11px] text-muted-foreground">
          Upload exported messages — .eml, .mbox, or a .zip of either.
        </div>
      </header>
      <div className="grid gap-3 px-5 py-4 text-[13px]">
        <input
          ref={inputRef}
          type="file"
          accept=".eml,.mbox,.zip,message/rfc822"
          multiple
          disabled={running}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className={cn(
            inputClass,
            "h-auto cursor-pointer py-1.5 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-foreground",
          )}
        />
        {running && progress && (
          <div className="grid gap-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] text-muted-foreground">
              {progress.done} / {progress.total} processed
              {progress.duplicate ? ` · ${progress.duplicate} skipped` : ""}
              {progress.failed ? ` · ${progress.failed} failed` : ""}
            </span>
          </div>
        )}
      </div>
      <div className="flex justify-end border-t bg-muted/30 px-5 py-2.5">
        <Button type="button" variant="primary" disabled={!files.length || running} onClick={start}>
          {running
            ? "Importing…"
            : files.length
              ? `Import ${files.length} file${files.length === 1 ? "" : "s"}`
              : "Import"}
        </Button>
      </div>
    </div>
  );
}
