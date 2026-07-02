import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CardHeader,
  cardClass,
  fieldClass,
  GroupLabel,
  Region,
  Section,
} from "@/components/settings-ui.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { LabeledField as Field } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
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
  aiFeatures: boolean;
  aiTokenCap: number | null;
  aiUsage: { period: string; calls: number; tokens: number } | null;
  // Present on the owner endpoint (/api/mailboxes/:id/settings); the admin
  // settings endpoint doesn't return gateway-PGP state.
  pgpMode?: PgpMode;
  pgpFingerprint?: string | null;
  pgpPublicKey?: string | null;
  pgpConfigured?: boolean;
  pgpAutoFetch?: boolean;
}

interface ImportTarget {
  id: string;
  address: string;
  displayName?: string | null;
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

// Same settings document behind two mounts: the admin endpoint additionally
// accepts the admin-only fields (spam level, budgets).
function settingsApi(admin: boolean) {
  return admin ? rpc.admin.mailboxes[":id"].settings : rpc.mailboxes[":id"].settings;
}

const SPAM_LEVELS: { value: SpamLevel; label: string; hint: string }[] = [
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
  const queryKey = [admin ? "admin-mailbox-settings" : "mailbox-settings", mailboxId];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => unwrap(settingsApi(admin).$get({ param: { id: mailboxId } })),
  });

  return (
    <section className={cardClass}>
      <CardHeader
        title={address}
        action={
          <Badge variant="outline" className="uppercase tracking-wider">
            {type}
          </Badge>
        }
      />
      <MailboxSettingsFields
        key={data ? "ready" : "loading"}
        settings={data}
        loading={isLoading}
        mailboxId={mailboxId}
        queryKey={queryKey}
        admin={admin}
        type={type}
      />
      {!admin && type !== "service" && type !== "temp" && (
        <MailboxPgpCard mailboxId={mailboxId} settingsKey={queryKey} />
      )}
    </section>
  );
}

function MailboxSettingsFields({
  settings,
  loading,
  mailboxId,
  queryKey,
  admin,
  type,
}: {
  settings: MailboxSettings | undefined;
  loading: boolean;
  mailboxId: string;
  queryKey: unknown[];
  admin: boolean;
  type: MailboxSettings["type"];
}) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(() => settings?.displayName ?? "");
  const [replyTo, setReplyTo] = useState(() => settings?.replyTo ?? "");
  const [signature, setSignature] = useState(() => settings?.signature ?? "");
  const [spamFilter, setSpamFilter] = useState<SpamLevel>(() => settings?.spamFilter ?? "standard");
  const [aiCap, setAiCap] = useState(() =>
    settings?.spamAiTokenCap ? String(settings.spamAiTokenCap) : "",
  );
  const [aiFeatures, setAiFeatures] = useState(() => settings?.aiFeatures ?? false);
  const [aiFeatureCap, setAiFeatureCap] = useState(() =>
    settings?.aiTokenCap ? String(settings.aiTokenCap) : "",
  );

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        settingsApi(admin).$patch({
          param: { id: mailboxId },
          json: {
            displayName: displayName.trim() || null,
            replyTo: replyTo.trim() || null,
            signature: signature.trim() ? signature : null,
            ...(admin
              ? {
                  spamFilter,
                  spamAiTokenCap: aiCap.trim() ? Number(aiCap) : null,
                  aiFeatures,
                  aiTokenCap: aiFeatureCap.trim() ? Number(aiFeatureCap) : null,
                }
              : {}),
          },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: keys.mailboxes() });
      toast.success("Settings saved");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const spamLabel = SPAM_LEVELS.find((l) => l.value === spamFilter);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Region label="Identity">
        <div className="space-y-4">
          <Field label="Display name">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Support"
              maxLength={200}
            />
          </Field>
          <Field label="Reply-to address">
            <Input
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="replies@example.com"
              maxLength={320}
            />
          </Field>
          <Field label="Signature" hint="Appended to every outgoing message.">
            <Textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={4}
              placeholder="Your name, role, links…"
              className="min-h-[6rem] resize-y"
              maxLength={5000}
            />
          </Field>
          {type !== "service" && admin && (
            <Field label="Spam filter" hint={spamLabel?.hint}>
              <Select
                items={SPAM_LEVELS}
                value={spamFilter}
                onValueChange={(v) => setSpamFilter(v as SpamLevel)}
              >
                <SelectTrigger aria-label="Spam filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPAM_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {type !== "service" && !admin && (
            <Field label="Spam filter" hint={`Set by your administrator. ${spamLabel?.hint}`}>
              <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-[13px] text-muted-foreground">
                {spamLabel?.label ?? spamFilter}
              </div>
            </Field>
          )}
          {admin && spamFilter === "ai" && type !== "service" && (
            <Field
              label="AI monthly token budget"
              hint={
                settings?.spamUsage
                  ? `Used ${settings.spamUsage.tokens.toLocaleString()} tokens across ${settings.spamUsage.calls} checks this month (${settings.spamUsage.period}). AI falls back to Standard when the budget is reached.`
                  : "Leave empty for unlimited. AI runs only on uncertain mail to keep usage low."
              }
            >
              <Input
                type="number"
                min={0}
                value={aiCap}
                onChange={(e) => setAiCap(e.target.value)}
                placeholder="Unlimited"
              />
            </Field>
          )}
          {type !== "service" && admin && (
            <Field
              label="AI features"
              hint="Summarise & categorise inbound mail in the list, plus smart replies and thread summaries. Uses Workers AI."
            >
              <Select
                items={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                ]}
                value={aiFeatures ? "on" : "off"}
                onValueChange={(v) => setAiFeatures(v === "on")}
              >
                <SelectTrigger aria-label="AI features">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {type !== "service" && !admin && (
            <Field label="AI features" hint="Set by your administrator.">
              <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-[13px] text-muted-foreground">
                {settings?.aiFeatures ? "On" : "Off"}
              </div>
            </Field>
          )}
          {admin && aiFeatures && type !== "service" && (
            <Field
              label="AI monthly token budget"
              hint={
                settings?.aiUsage
                  ? `Used ${settings.aiUsage.tokens.toLocaleString()} tokens across ${settings.aiUsage.calls} calls this month (${settings.aiUsage.period}). Features pause when the budget is reached; mail still delivers.`
                  : "Leave empty for unlimited. Summaries run once per inbound message; replies and thread summaries only when requested."
              }
            >
              <Input
                type="number"
                min={0}
                value={aiFeatureCap}
                onChange={(e) => setAiFeatureCap(e.target.value)}
                placeholder="Unlimited"
              />
            </Field>
          )}
          <div className="flex justify-end pt-1">
            <Button type="submit" variant="primary" disabled={save.isPending || loading}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </Region>
    </form>
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
  const { confirm, confirmDelete } = useConfirmHelpers();
  const mbx = rpc.mailboxes[":id"];
  const param = { id: mailboxId };
  const { data: s, isLoading: settingsLoading } = useQuery({
    queryKey: settingsKey,
    queryFn: () => unwrap(mbx.settings.$get({ param })),
  });
  const contactsKey = ["mailbox-contacts", mailboxId];
  const { data: contactsData } = useQuery({
    queryKey: contactsKey,
    queryFn: () => unwrap(mbx.contacts.$get({ param })),
  });

  const [importKey, setImportKey] = useState("");
  const [importPass, setImportPass] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [contactKey, setContactKey] = useState("");

  const configured = !!s?.pgpConfigured;

  const refreshSettings = () => {
    qc.invalidateQueries({ queryKey: settingsKey });
    qc.invalidateQueries({ queryKey: keys.mailboxes() });
  };

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidates via refreshSettings()
  const setMode = useMutation({
    mutationFn: (mode: PgpMode) => unwrap(mbx.settings.$patch({ param, json: { pgpMode: mode } })),
    onSuccess: refreshSettings,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidates via refreshSettings()
  const generate = useMutation({
    mutationFn: () => unwrap(mbx.pgp.generate.$post({ param })),
    onSuccess: (r) => {
      refreshSettings();
      toast.success(`Keypair generated (${shortFp(r.fingerprint)})`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Generate failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidates via refreshSettings()
  const doImport = useMutation({
    mutationFn: () =>
      unwrap(
        mbx.pgp.import.$post({
          param,
          json: { privateKey: importKey, passphrase: importPass || undefined },
        }),
      ),
    onSuccess: (r) => {
      refreshSettings();
      setImportKey("");
      setImportPass("");
      setShowImport(false);
      toast.success(`Key imported (${shortFp(r.fingerprint)})`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Import failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidates via refreshSettings()
  const removeKey = useMutation({
    mutationFn: () => unwrap(mbx.pgp.$delete({ param })),
    onSuccess: () => {
      refreshSettings();
      toast.success("PGP key removed");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const addContact = useMutation({
    mutationFn: () =>
      unwrap(
        mbx.contacts.$post({
          param,
          json: { publicKey: contactKey, email: contactEmail.trim() || undefined },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: contactsKey });
      setContactEmail("");
      setContactKey("");
      toast.success("Contact key added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeContact = useMutation({
    mutationFn: (id: string) =>
      unwrap(mbx.contacts[":contactId"].$delete({ param: { ...param, contactId: id } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const setVerified = useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
      unwrap(
        mbx.contacts[":contactId"].$patch({
          param: { ...param, contactId: id },
          json: { verified },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- invalidates via refreshSettings()
  const setAutoFetch = useMutation({
    mutationFn: (pgpAutoFetch: boolean) =>
      unwrap(mbx.settings.$patch({ param, json: { pgpAutoFetch } })),
    onSuccess: refreshSettings,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const contacts = contactsData?.keys ?? [];

  return (
    <Region
      label="Encryption (PGP)"
      description="Sign and encrypt mail for this mailbox. Keys are held on the server — this protects mail in transit, not from the server itself."
    >
      <div className="space-y-4">
        <Field
          label="Mode"
          hint={
            configured
              ? PGP_MODES.find((m) => m.value === (s?.pgpMode ?? "off"))?.hint
              : "Generate or import a keypair below to enable signing or encryption."
          }
        >
          <Select
            items={PGP_MODES}
            value={s?.pgpMode ?? "off"}
            disabled={!configured || setMode.isPending || settingsLoading}
            onValueChange={(v) => setMode.mutate(v as PgpMode)}
          >
            <SelectTrigger aria-label="PGP mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PGP_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {configured ? (
          <Field label="Mailbox key">
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
              <code className="truncate text-[12px]">{s?.pgpFingerprint}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Remove the mailbox PGP key?",
                      description:
                        "Signing and encryption turn off, and encrypted mail can no longer be decrypted.",
                      confirmLabel: "Remove",
                      destructive: true,
                    })
                  )
                    removeKey.mutate();
                }}
                disabled={removeKey.isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Remove
              </Button>
            </div>
            {s?.pgpPublicKey && (
              <details className="text-[12px] text-muted-foreground">
                <summary className="cursor-pointer select-none">Public key</summary>
                <Textarea
                  readOnly
                  value={s.pgpPublicKey}
                  rows={6}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1.5 resize-y font-mono text-[10px] leading-tight"
                />
              </details>
            )}
          </Field>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? "Generating…" : "Generate keypair"}
              </Button>
              <Button variant="outline" onClick={() => setShowImport((v) => !v)}>
                Import existing
              </Button>
            </div>
            {showImport && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <Textarea
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                  rows={5}
                  placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                  className="resize-y bg-background font-mono text-[10px] leading-tight"
                />
                <Input
                  type="password"
                  value={importPass}
                  onChange={(e) => setImportPass(e.target.value)}
                  placeholder="Passphrase (if the key is protected)"
                />
                <div className="flex justify-end">
                  <Button
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

        <div className="flex items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <GroupLabel>Auto-discover keys (WKD)</GroupLabel>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
              Fetch a recipient's key from their provider when encrypting, and verify signed mail
              from senders you don't have a key for. Outbound lookups reveal who you email to their
              provider.
            </p>
          </div>
          <Switch
            checked={s?.pgpAutoFetch ?? true}
            disabled={setAutoFetch.isPending || settingsLoading}
            onCheckedChange={(v) => setAutoFetch.mutate(v)}
            aria-label="Auto-discover keys via WKD"
          />
        </div>

        <div className="space-y-2 border-t pt-4">
          <GroupLabel>Recipient keys</GroupLabel>
          <p className="text-[12px] leading-snug text-muted-foreground">
            Public keys of people you email. Needed to encrypt to them; captured automatically when
            a signed message includes one or via WKD.
          </p>
          {contacts.length > 0 && (
            <ul className="divide-y overflow-hidden rounded-md border">
              {contacts.map((k) => {
                const expired = k.expiresAt != null && new Date(k.expiresAt).getTime() < Date.now();
                return (
                  <li key={k.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <span className="truncate">{k.email}</span>
                        <Badge variant={k.verified ? "success" : "outline"} className="shrink-0">
                          {k.verified ? "Verified" : "Unverified"}
                        </Badge>
                        {expired && (
                          <Badge variant="destructive" className="shrink-0">
                            Expired
                          </Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {shortFp(k.fingerprint)} · {k.source}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setVerified.mutate({ id: k.id, verified: !k.verified })}
                        disabled={setVerified.isPending}
                      >
                        {k.verified ? "Unverify" : "Mark verified"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (await confirmDelete(`recipient key for ${k.email}`))
                            removeContact.mutate(k.id);
                        }}
                        disabled={removeContact.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <Input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email (optional — taken from the key if blank)"
              className="bg-background"
            />
            <Textarea
              value={contactKey}
              onChange={(e) => setContactKey(e.target.value)}
              rows={4}
              placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
              className="resize-y bg-background font-mono text-[10px] leading-tight"
            />
            <div className="flex justify-end">
              <Button
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
    </Region>
  );
}

function shortFp(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 4)}…${fp.slice(-8)}`.toUpperCase() : fp.toUpperCase();
}

/**
 * Bulk-import exported mail (.eml/.mbox/.zip, incl. a Proton Mail export) into a
 * chosen mailbox. Extraction runs in the browser; each message is POSTed
 * individually so large archives never hit a Worker body/time limit. Mail is
 * deduped by Message-ID (re-running is safe) and marked read unless an export's
 * metadata says otherwise.
 */
export function MailboxImportSection({ mailboxes }: { mailboxes: ImportTarget[] }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);

  // Keep the selection valid if the mailbox list changes underneath us.
  const selectedId = mailboxes.some((m) => m.id === mailboxId)
    ? mailboxId
    : (mailboxes[0]?.id ?? "");

  // `webkitdirectory` has no JSX typing; set it on the DOM node directly. With it
  // the picker selects a whole folder, and the browser reads each message lazily
  // — so a large Proton export imports without zipping or buffering it all.
  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  async function start() {
    if (!files.length || running || !selectedId) return;
    setRunning(true);
    setProgress(null);
    try {
      const result = await runImport(selectedId, files, setProgress);
      const imported = result.done - result.duplicate - result.skipped - result.failed;
      const extra = [
        result.duplicate ? `${result.duplicate} duplicate` : "",
        result.skipped ? `${result.skipped} empty` : "",
        result.failed ? `${result.failed} failed` : "",
      ]
        .filter(Boolean)
        .join(", ");
      if (result.failed) {
        toast.warning(
          `Imported ${imported} message${imported === 1 ? "" : "s"}${extra ? ` (${extra})` : ""}. Import again to retry the failed ones — duplicates are skipped.`,
        );
      } else {
        toast.success(
          `Imported ${imported} message${imported === 1 ? "" : "s"}${extra ? ` (${extra})` : ""}`,
        );
      }
      qc.invalidateQueries({ queryKey: keys.threadsRoot(selectedId) });
      qc.invalidateQueries({ queryKey: keys.mailboxes() });
      qc.invalidateQueries({ queryKey: keys.folders() });
      // Keep the selection on failures so the user can re-run to retry just the
      // failed messages (re-import is deduped, so successes are skipped fast).
      if (!result.failed) {
        setFiles([]);
        if (inputRef.current) inputRef.current.value = "";
        if (folderRef.current) folderRef.current.value = "";
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  }

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Section
      title="Import mail"
      description="Upload exported messages — .eml, .mbox, or a .zip. For a large export (e.g. Proton Mail), select its folder instead of zipping it."
      footer={
        <Button
          variant="primary"
          disabled={!files.length || running || !selectedId}
          onClick={start}
        >
          {running
            ? "Importing…"
            : files.length
              ? `Import ${files.length} file${files.length === 1 ? "" : "s"}`
              : "Import"}
        </Button>
      }
      contentClassName="space-y-3"
    >
      <Field label="Import into">
        <Select
          items={mailboxes.map((m) => ({
            value: m.id,
            label: m.displayName ? `${m.displayName} (${m.address})` : m.address,
          }))}
          value={selectedId}
          disabled={running}
          onValueChange={(v) => setMailboxId(v as string)}
        >
          <SelectTrigger aria-label="Import into">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {mailboxes.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.displayName ? `${m.displayName} (${m.address})` : m.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <input
        ref={inputRef}
        type="file"
        aria-label="Choose files to import"
        accept=".eml,.mbox,.zip,.json,message/rfc822"
        multiple
        disabled={running}
        onChange={(e) => {
          setFiles(Array.from(e.target.files ?? []));
          if (folderRef.current) folderRef.current.value = "";
        }}
        className={cn(
          fieldClass,
          "cursor-pointer py-1.5 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-foreground",
        )}
      />
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span>or</span>
        <Button
          variant="secondary"
          size="sm"
          disabled={running}
          onClick={() => folderRef.current?.click()}
        >
          Select folder
        </Button>
        <input
          ref={folderRef}
          type="file"
          aria-label="Choose a folder to import"
          hidden
          disabled={running}
          onChange={(e) => {
            setFiles(Array.from(e.target.files ?? []));
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        {files.length > 0 && (
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} selected
          </span>
        )}
      </div>
      {running && progress && (
        <div className="grid gap-1.5">
          <Progress value={pct} />
          <span className="text-[12px] text-muted-foreground">
            {progress.done} / {progress.total} processed
            {progress.duplicate ? ` · ${progress.duplicate} duplicate` : ""}
            {progress.skipped ? ` · ${progress.skipped} empty` : ""}
            {progress.retried ? ` · ${progress.retried} retried` : ""}
            {progress.failed ? ` · ${progress.failed} failed` : ""}
          </span>
        </div>
      )}
    </Section>
  );
}
