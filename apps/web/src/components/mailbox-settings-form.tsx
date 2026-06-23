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
export type PgpMode = "off" | "sign" | "sign_encrypt";

interface MailboxSettings {
  id: string;
  type: "personal" | "group" | "service" | "temp";
  displayName: string | null;
  signature: string | null;
  replyTo: string | null;
  spamFilter: SpamLevel;
  spamAiTokenCap: number | null;
  spamUsage: { period: string; calls: number; tokens: number } | null;
  pgpMode: PgpMode;
  pgpFingerprint: string | null;
  pgpPublicKey: string | null;
  pgpConfigured: boolean;
}

interface ContactKey {
  id: string;
  email: string;
  fingerprint: string;
  source: "import" | "tofu";
  createdAt: string;
}

const PGP_MODES: { value: PgpMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No signing or encryption." },
  { value: "sign", label: "Sign", hint: "Sign outgoing mail so recipients can verify it." },
  {
    value: "sign_encrypt",
    label: "Sign + encrypt",
    hint: "Encrypt to recipients with a known key; sign-only (and warn) when a key is missing.",
  },
];

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
      {!admin && type !== "service" && type !== "temp" && (
        <MailboxPgpCard mailboxId={mailboxId} settingsKey={queryKey} />
      )}
      {!admin && type !== "service" && <MailboxImportCard mailboxId={mailboxId} />}
    </div>
  );
}

/**
 * Per-mailbox gateway PGP: enable signing/encryption, generate or import the
 * mailbox keypair, and manage correspondent public keys. The private key is held
 * server-side (wrapped at rest) — this is not end-to-end. All routes are owner
 * (Perm.MANAGE) endpoints under /api/mailboxes/:id.
 */
function MailboxPgpCard({ mailboxId, settingsKey }: { mailboxId: string; settingsKey: unknown[] }) {
  const qc = useQueryClient();
  const base = `/api/mailboxes/${mailboxId}`;
  const settingsQ = useQuery({
    queryKey: settingsKey,
    queryFn: () => api<MailboxSettings>(`${base}/settings`),
  });
  const contactsKey = ["mailbox-contacts", mailboxId];
  const contactsQ = useQuery({
    queryKey: contactsKey,
    queryFn: () => api<{ keys: ContactKey[] }>(`${base}/contacts`),
  });

  const [importKey, setImportKey] = useState("");
  const [importPass, setImportPass] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [contactKey, setContactKey] = useState("");

  const s = settingsQ.data;
  const configured = !!s?.pgpConfigured;

  const refreshSettings = () => {
    qc.invalidateQueries({ queryKey: settingsKey });
    qc.invalidateQueries({ queryKey: keys.mailboxes() });
  };

  const setMode = useMutation({
    mutationFn: (mode: PgpMode) =>
      api(`${base}/settings`, { method: "PATCH", body: JSON.stringify({ pgpMode: mode }) }),
    onSuccess: refreshSettings,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const generate = useMutation({
    mutationFn: () => api<{ fingerprint: string }>(`${base}/pgp/generate`, { method: "POST" }),
    onSuccess: (r) => {
      refreshSettings();
      toast.success(`Keypair generated (${shortFp(r.fingerprint)})`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Generate failed"),
  });

  const doImport = useMutation({
    mutationFn: () =>
      api<{ fingerprint: string }>(`${base}/pgp/import`, {
        method: "POST",
        body: JSON.stringify({ privateKey: importKey, passphrase: importPass || undefined }),
      }),
    onSuccess: (r) => {
      refreshSettings();
      setImportKey("");
      setImportPass("");
      setShowImport(false);
      toast.success(`Key imported (${shortFp(r.fingerprint)})`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Import failed"),
  });

  const removeKey = useMutation({
    mutationFn: () => api(`${base}/pgp`, { method: "DELETE" }),
    onSuccess: () => {
      refreshSettings();
      toast.success("PGP key removed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const addContact = useMutation({
    mutationFn: () =>
      api(`${base}/contacts`, {
        method: "POST",
        body: JSON.stringify({ publicKey: contactKey, email: contactEmail.trim() || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: contactsKey });
      setContactEmail("");
      setContactKey("");
      toast.success("Contact key added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeContact = useMutation({
    mutationFn: (id: string) => api(`${base}/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const contacts = contactsQ.data?.keys ?? [];

  return (
    <div className="rounded-md border bg-card">
      <header className="border-b px-5 py-3">
        <div className="font-medium">Encryption (PGP)</div>
        <div className="text-[11px] text-muted-foreground">
          Sign and encrypt mail for this mailbox. Keys are held on the server — this protects mail
          in transit, not from the server itself.
        </div>
      </header>
      <div className="grid gap-4 px-5 py-4 text-[13px]">
        {/* Mode */}
        <label className="grid gap-1.5">
          <span className="text-[11px] font-medium text-foreground">Mode</span>
          <select
            value={s?.pgpMode ?? "off"}
            disabled={!configured || setMode.isPending || settingsQ.isLoading}
            onChange={(e) => setMode.mutate(e.target.value as PgpMode)}
            className={cn(inputClass, "cursor-pointer appearance-none disabled:opacity-60")}
          >
            {PGP_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">
            {configured
              ? PGP_MODES.find((m) => m.value === (s?.pgpMode ?? "off"))?.hint
              : "Generate or import a keypair below to enable signing or encryption."}
          </span>
        </label>

        {/* Keypair */}
        {configured ? (
          <div className="grid gap-1.5">
            <span className="text-[11px] font-medium text-foreground">Mailbox key</span>
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
              <code className="truncate text-[12px]">{s?.pgpFingerprint}</code>
              <button
                type="button"
                onClick={() => removeKey.mutate()}
                disabled={removeKey.isPending}
                className="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
            {s?.pgpPublicKey && (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none">Public key</summary>
                <textarea
                  readOnly
                  value={s.pgpPublicKey}
                  rows={6}
                  onFocus={(e) => e.currentTarget.select()}
                  className={cn(
                    inputClass,
                    "mt-1 h-auto resize-y font-mono text-[10px] leading-tight",
                  )}
                />
              </details>
            )}
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="primary"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? "Generating…" : "Generate keypair"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowImport((v) => !v)}>
                Import existing
              </Button>
            </div>
            {showImport && (
              <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
                <textarea
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                  rows={5}
                  placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                  className={cn(inputClass, "h-auto resize-y font-mono text-[10px] leading-tight")}
                />
                <input
                  type="password"
                  value={importPass}
                  onChange={(e) => setImportPass(e.target.value)}
                  placeholder="Passphrase (if the key is protected)"
                  className={inputClass}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={!importKey.trim() || doImport.isPending}
                    onClick={() => doImport.mutate()}
                  >
                    {doImport.isPending ? "Importing…" : "Import key"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Contact keys */}
        <div className="grid gap-2 border-t pt-3">
          <span className="text-[11px] font-medium text-foreground">Recipient keys</span>
          <span className="text-[11px] text-muted-foreground">
            Public keys of people you email. Needed to encrypt to them; captured automatically when
            a signed message includes one.
          </span>
          {contacts.length > 0 && (
            <ul className="divide-y rounded-md border">
              {contacts.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[12px]">{k.email}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {shortFp(k.fingerprint)} · {k.source}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeContact.mutate(k.id)}
                    disabled={removeContact.isPending}
                    className="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email (optional — taken from the key if blank)"
              className={inputClass}
            />
            <textarea
              value={contactKey}
              onChange={(e) => setContactKey(e.target.value)}
              rows={4}
              placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
              className={cn(inputClass, "h-auto resize-y font-mono text-[10px] leading-tight")}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="primary"
                disabled={!contactKey.trim() || addContact.isPending}
                onClick={() => addContact.mutate()}
              >
                {addContact.isPending ? "Adding…" : "Add recipient key"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function shortFp(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 4)}…${fp.slice(-8)}`.toUpperCase() : fp.toUpperCase();
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
