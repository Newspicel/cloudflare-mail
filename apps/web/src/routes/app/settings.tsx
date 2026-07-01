import type { DateFormat, EmailTemplate, MailView, UserPrefs } from "@cfmail/shared";
import { has, Perm } from "@cfmail/shared/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MailboxImportSection, MailboxSettingsForm } from "@/components/mailbox-settings-form.tsx";
import { RulesSection } from "@/components/rules-settings.tsx";
import {
  CopyButton,
  Field,
  fieldClass,
  GroupLabel,
  Input,
  Row,
  Section,
  Segmented,
  Textarea,
} from "@/components/settings-ui.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ColorField } from "@/components/ui/color-field.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { api } from "@/lib/api.ts";
import { authClient } from "@/lib/auth-client.ts";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import { disablePush, enablePush, isPushEnabled, pushSupported } from "@/lib/push.ts";
import {
  type FolderRow,
  foldersQuery,
  type MailboxSummary,
  type MeUser,
  mailboxesQuery,
  meQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { TEMPLATE_TOKENS } from "@/lib/templates.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import { dateFormatExample, formatDateTime } from "@/lib/time.ts";

export const Route = createFileRoute("/app/settings")({
  component: SettingsPage,
});

const NAV = [
  ["profile", "Profile"],
  ["appearance", "Appearance"],
  ["reading", "Reading"],
  ["datetime", "Date & time"],
  ["compose", "Compose"],
  ["templates", "Templates"],
  ["security", "Security"],
  ["notifications", "Notifications"],
  ["folders", "Folders"],
  ["rules", "Rules"],
  ["mailboxes", "Mailboxes"],
] as const;

function SettingsPage() {
  const { data: meData } = useQuery(meQuery);
  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const editable = (mailboxesData?.mailboxes ?? []).filter(
    (m) => m.type !== "temp" && has(m.perms, Perm.MANAGE),
  );
  // Service mailboxes can't be imported into (no owner-facing inbox).
  const importable = editable.filter((m) => m.type !== "service");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl gap-8 px-4 py-6 sm:px-8 sm:py-8">
        <nav className="sticky top-8 hidden h-max w-36 shrink-0 flex-col gap-0.5 text-[13px] lg:flex">
          {NAV.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          <header>
            <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Profile, appearance, security, and per-mailbox preferences.
            </p>
          </header>

          <ProfileSection
            key={`${meData?.user?.name ?? ""}|${meData?.user?.image ?? ""}`}
            name={meData?.user?.name ?? ""}
            email={meData?.user?.email ?? ""}
            image={meData?.user?.image ?? ""}
            role={meData?.user?.role}
          />
          <AppearanceSection />
          <ReadingSection />
          <DateTimeSection />
          <ComposeSection />
          <TemplatesSection />
          <SecuritySection />
          <TwoFactorSection enabled={!!meData?.user?.twoFactorEnabled} />
          <NotificationsSection mailboxes={mailboxesData?.mailboxes ?? []} />
          <FoldersSection />
          <RulesSection mailboxes={editable} />

          <div id="mailboxes" className="scroll-mt-8 space-y-4">
            <div className="px-0.5">
              <h2 className="text-[14px] font-semibold tracking-tight">Mailboxes</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Identity, spam filtering, and encryption for each mailbox you manage.
              </p>
            </div>
            {editable.length === 0 ? (
              <div className="rounded-lg border bg-card px-5 py-8 text-center text-[13px] text-muted-foreground shadow-sm">
                No editable mailboxes yet.
              </div>
            ) : (
              <div className="space-y-4">
                {editable.map((m) => (
                  <MailboxSettingsForm
                    key={m.id}
                    mailboxId={m.id}
                    address={m.address}
                    type={m.type}
                  />
                ))}
              </div>
            )}
            {importable.length > 0 && <MailboxImportSection mailboxes={importable} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Profile ────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("") || "?"
  );
}

function ProfileSection({
  name,
  email,
  image,
  role,
}: {
  name: string;
  email: string;
  image: string;
  role?: string;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  // react-doctor-disable-next-line no-derived-useState -- editable draft seeded from the prop; re-seeded via the parent's key remount when the server value changes
  const [draftName, setDraftName] = useState(name);
  // react-doctor-disable-next-line no-derived-useState -- editable draft seeded from the prop; re-seeded via the parent's key remount when the server value changes
  const [draftImage, setDraftImage] = useState(image);
  const [uploading, setUploading] = useState(false);

  const dirty = draftName.trim() !== name || draftImage.trim() !== (image ?? "");

  async function onPickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image exceeds 5 MB");
      return;
    }
    setUploading(true);
    try {
      const { url } = await api<{ url: string }>("/api/avatar", {
        method: "POST",
        headers: { "content-type": file.type },
        body: await file.arrayBuffer(),
      });
      setDraftImage(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const nextName = draftName.trim();
      const nextImage = draftImage.trim();
      const res = await authClient.updateUser({ name: nextName, image: nextImage || undefined });
      if (res.error) throw new Error(res.error.message ?? "Failed to save");
      return { name: nextName, image: nextImage || null };
    },
    // Write into the cache directly — the session cookie cache can lag ~60s.
    onSuccess: (next) => {
      qc.setQueryData<{ user: MeUser | null }>(meQuery.queryKey, (old) =>
        old?.user ? { ...old, user: { ...old.user, ...next } } : old,
      );
      toast.success("Profile updated");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Section id="profile" title="Profile" description="Your name and avatar, shown across the app.">
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center gap-2">
          <Avatar className="size-14 text-base">
            {draftImage.trim() && <AvatarImage src={draftImage.trim()} alt={draftName} />}
            <AvatarFallback>{initials(draftName)}</AvatarFallback>
          </Avatar>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Upload avatar image"
            className="hidden"
            onChange={(e) => {
              void onPickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-col items-center gap-1 text-[12px]">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="font-medium text-primary hover:underline disabled:opacity-50"
            >
              {uploading ? "Uploading…" : draftImage.trim() ? "Change" : "Upload"}
            </button>
            {draftImage.trim() && (
              <button
                type="button"
                onClick={() => setDraftImage("")}
                disabled={uploading}
                className="text-muted-foreground hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <Field label="Name" htmlFor="profile-name">
            <Input
              id="profile-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={120}
            />
          </Field>
          <dl className="grid grid-cols-[72px_1fr] items-center gap-y-2 text-[13px]">
            <dt className="text-[12px] text-muted-foreground">Email</dt>
            <dd className="truncate">{email}</dd>
            <dt className="text-[12px] text-muted-foreground">Role</dt>
            <dd>
              <Badge variant="outline" className="uppercase tracking-wider">
                {role ?? "—"}
              </Badge>
            </dd>
          </dl>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!dirty || !draftName.trim() || save.isPending}
          >
            Save profile
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ─── Appearance ─────────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
] as const;

const DENSITY_OPTIONS = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
] as const;

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section
      id="appearance"
      title="Appearance"
      description="Theme is saved on this device; density syncs to your account."
    >
      <div className="divide-y">
        <Row label="Theme" hint="System follows your OS setting.">
          <Segmented<Theme> value={theme} options={THEME_OPTIONS} onChange={(v) => setTheme(v)} />
        </Row>
        <Row label="List density" hint="How tightly conversations are packed.">
          <Segmented
            value={prefs.density ?? "comfortable"}
            options={DENSITY_OPTIONS}
            onChange={(v) => setPrefs({ density: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

const VIEW_OPTIONS = [
  ["inbox", "Inbox"],
  ["all", "All mail"],
  ["marked", "Marked"],
] as const;

const MAP_OPTIONS = [
  ["auto", "Auto"],
  ["google", "Google"],
  ["apple", "Apple"],
] as const;

function ReadingSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section id="reading" title="Reading" description="How mail opens and is marked.">
      <div className="divide-y">
        <Row label="Default view" hint="Which view opens when you pick a mailbox.">
          <Segmented<MailView>
            value={(prefs.defaultView as MailView) ?? "inbox"}
            options={VIEW_OPTIONS}
            onChange={(v) => setPrefs({ defaultView: v })}
            disabled={saving}
          />
        </Row>
        <Row
          label="Mark read when opened"
          hint="Turn off to keep threads unread until you mark them."
        >
          <Switch
            checked={prefs.autoMarkRead !== false}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ autoMarkRead: checked })}
          />
        </Row>
        <Row
          label="AI summaries in list"
          hint="Show the one-line AI summary under each conversation (where the mailbox has AI enabled)."
        >
          <Switch
            checked={prefs.aiSummaries !== false}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ aiSummaries: checked })}
          />
        </Row>
        <Row label="Open addresses in" hint="Which maps service event locations open in.">
          <Segmented<NonNullable<UserPrefs["mapProvider"]>>
            value={prefs.mapProvider ?? "auto"}
            options={MAP_OPTIONS}
            onChange={(v) => setPrefs({ mapProvider: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}

// ─── Date & time ──────────────────────────────────────────────────────────

// Fixed instant for the settings preview so it's stable across renders.
const SAMPLE_DATE = new Date(2026, 5, 24, 14, 30);

// Explicit layouts, grouped numeric → named, each labelled by its own example.
const DATE_FORMAT_OPTIONS: DateFormat[] = [
  "dmy-dot",
  "dmy-dot-2",
  "dmy-slash",
  "dmy-slash-2",
  "mdy-slash",
  "mdy-slash-2",
  "iso",
  "d-mon-y",
  "d-month-y",
  "mon-d-y",
  "month-d-y",
];

const TIME_OPTIONS = [
  ["24h", "24-hour"],
  ["12h", "12-hour"],
] as const;

function DateTimeSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();
  const fmt = useDateTimeFmt();

  return (
    <Section
      id="datetime"
      title="Date & time"
      description={`How dates and times are shown. Preview: ${formatDateTime(SAMPLE_DATE, fmt)}`}
    >
      <div className="divide-y">
        <Row label="Date format" hint="Order, separator, and how the month is written.">
          <select
            className={fieldClass}
            value={prefs.dateFormat ?? "dmy-dot"}
            disabled={saving}
            onChange={(e) => setPrefs({ dateFormat: e.target.value as DateFormat })}
          >
            {DATE_FORMAT_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {dateFormatExample(id)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Clock" hint="12- or 24-hour time.">
          <Segmented<NonNullable<UserPrefs["timeFormat"]>>
            value={prefs.timeFormat ?? "24h"}
            options={TIME_OPTIONS}
            onChange={(v) => setPrefs({ timeFormat: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}

// ─── Compose ────────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
  ["text", "Plain"],
  ["markdown", "Markdown"],
  ["html", "Rich text"],
] as const;

function ComposeSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section id="compose" title="Compose" description="Defaults when writing a new message.">
      <div className="divide-y">
        <Row label="Open in a new window" hint="Pop new messages out instead of the in-app dock.">
          <Switch
            checked={!!prefs.composeInNewWindow}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ composeInNewWindow: checked })}
          />
        </Row>
        <Row label="Default editor" hint="Starting format for a new message.">
          <Segmented<NonNullable<UserPrefs["composeDefaultMode"]>>
            value={prefs.composeDefaultMode ?? "text"}
            options={MODE_OPTIONS}
            onChange={(v) => setPrefs({ composeDefaultMode: v })}
            disabled={saving}
          />
        </Row>
        <Row label="Send with ⌘/Ctrl + Enter" hint="Keyboard shortcut to send the open message.">
          <Switch
            checked={!!prefs.sendShortcut}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ sendShortcut: checked })}
          />
        </Row>
        <Row label="Reply all by default" hint="Reply includes everyone on the thread.">
          <Switch
            checked={!!prefs.replyAllDefault}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ replyAllDefault: checked })}
          />
        </Row>
      </div>
    </Section>
  );
}

// ─── Templates ────────────────────────────────────────────────────────────────

function TemplatesSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();
  const [items, setItems] = useState<EmailTemplate[]>(prefs.templates ?? []);
  // Pending local edits guard the resync so server echoes don't clobber typing.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setItems(prefs.templates ?? []);
  }, [prefs.templates]);

  const commit = (next: EmailTemplate[]) => {
    dirty.current = false;
    void setPrefs({ templates: next });
  };
  const editField = (id: string, patch: Partial<EmailTemplate>) => {
    dirty.current = true;
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };
  const persist = () => {
    if (dirty.current) commit(items);
  };
  const add = () => {
    const next = [...items, { id: crypto.randomUUID(), name: "Untitled template", body: "" }];
    setItems(next);
    commit(next);
  };
  const remove = (id: string) => commit(items.filter((t) => t.id !== id));

  return (
    <Section
      id="templates"
      title="Templates"
      description="Reusable snippets you can drop into a message from the composer."
      action={
        <Button variant="outline" size="sm" onClick={add} disabled={saving}>
          <Plus className="size-3.5" /> Add template
        </Button>
      }
    >
      <p className="mb-4 text-[12px] leading-snug text-muted-foreground">
        Use placeholders in a template — they're filled in when you insert it:{" "}
        {TEMPLATE_TOKENS.map((t, i) => (
          <span key={t.token}>
            {i > 0 && ", "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{t.token}</code> ({t.label})
          </span>
        ))}
        .
      </p>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
          No templates yet.
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((t) => (
            <div key={t.id} className="rounded-md border bg-background/40 p-3">
              <div className="flex items-start gap-2">
                <Input
                  value={t.name}
                  placeholder="Template name"
                  onChange={(e) => editField(t.id, { name: e.target.value })}
                  onBlur={persist}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(t.id)}
                  disabled={saving}
                  className="hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete template"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Input
                value={t.subject ?? ""}
                placeholder="Subject (optional — fills only when empty)"
                onChange={(e) => editField(t.id, { subject: e.target.value })}
                onBlur={persist}
                className="mt-2"
              />
              <Textarea
                value={t.body}
                placeholder="Template body…"
                rows={5}
                onChange={(e) => editField(t.id, { body: e.target.value })}
                onBlur={persist}
                className="mt-2"
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── Security ───────────────────────────────────────────────────────────────

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

function SecuritySection() {
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

// ─── Folders ────────────────────────────────────────────────────────────────

function FoldersSection() {
  const qc = useQueryClient();
  const { data } = useQuery(foldersQuery);
  const { confirmDelete } = useConfirmHelpers();
  const folders = data?.folders ?? [];

  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      color?: string;
      position?: number;
    }) => api(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.folders() }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/folders/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.folders() }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Swap a folder's position with its neighbour to reorder.
  const move = (index: number, dir: -1 | 1) => {
    const a = folders[index];
    const b = folders[index + dir];
    if (!a || !b) return;
    update.mutate({ id: a.id, position: b.position });
    update.mutate({ id: b.id, position: a.position });
  };

  async function onDelete(f: FolderRow) {
    const ok = await confirmDelete(
      `folder "${f.name}"`,
      "The folder is removed; its conversations return to their mailboxes.",
    );
    if (ok) remove.mutate(f.id);
  }

  return (
    <Section
      id="folders"
      title="Folders"
      description="Rename, recolor, and reorder your custom folders."
    >
      {folders.length === 0 ? (
        <div className="text-[13px] text-muted-foreground">
          No folders yet. Create one from the sidebar.
        </div>
      ) : (
        <ul className="divide-y">
          {folders.map((f, i) => (
            <FolderRowEditor
              key={`${f.id}:${f.name}`}
              folder={f}
              isFirst={i === 0}
              isLast={i === folders.length - 1}
              busy={update.isPending || remove.isPending}
              onRename={(name) => name !== f.name && update.mutate({ id: f.id, name })}
              onRecolor={(color) => update.mutate({ id: f.id, color })}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              onDelete={() => onDelete(f)}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function FolderRowEditor({
  folder,
  isFirst,
  isLast,
  busy,
  onRename,
  onRecolor,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  folder: FolderRow;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  // react-doctor-disable-next-line no-derived-useState -- editable draft seeded from the prop; re-seeded via the parent's key remount when the folder name changes
  const [name, setName] = useState(folder.name);

  return (
    <li className="flex items-center gap-2 py-2">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              disabled={busy}
              aria-label={`Color for ${folder.name}`}
              className="size-7 shrink-0 cursor-pointer rounded border disabled:opacity-50"
              style={{ backgroundColor: folder.color }}
            />
          }
        />
        <PopoverContent align="start" className="w-56 p-2">
          <ColorField color={folder.color} onChange={onRecolor} />
        </PopoverContent>
      </Popover>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && onRename(name.trim())}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        maxLength={64}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move up"
          disabled={isFirst || busy}
          onClick={onMoveUp}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move down"
          disabled={isLast || busy}
          onClick={onMoveDown}
        >
          <ArrowDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${folder.name}`}
          disabled={busy}
          onClick={onDelete}
          className="hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

// ─── Two-factor (unchanged) ─────────────────────────────────────────────────

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

// ─── Notifications (unchanged) ──────────────────────────────────────────────

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

  const { data: configsData } = useQuery({
    queryKey: ["push-mailboxes"],
    queryFn: () => api<{ configs: NotifyConfig[] }>("/api/push/mailboxes"),
  });
  const configById = new Map((configsData?.configs ?? []).map((c) => [c.mailboxId, c]));

  const saveConfig = useMutation({
    mutationFn: ({ id, cfg }: { id: string; cfg: NotifyTiers }) =>
      api(`/api/push/mailboxes/${id}`, { method: "PUT", body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["push-mailboxes"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Service mailboxes are send-only — they never receive mail to notify on.
  const receivable = mailboxes.filter((m) => m.type !== "service");

  return (
    <Section
      id="notifications"
      title="Notifications"
      description="Get a push notification when new mail arrives. Enable this device, then choose how each mailbox notifies you — AI tags every email's priority so important mail can stand out."
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
        <Button variant="primary" onClick={toggleDevice} disabled={!supported || busy}>
          {deviceOn ? "Disable" : "Enable"}
        </Button>
      </div>

      {receivable.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <GroupLabel className="mb-1.5">Per mailbox</GroupLabel>
          <ul className="divide-y">
            {receivable.map((m) => {
              const cfg = configById.get(m.id);
              const on = !!cfg;
              return (
                <li key={m.id} className="py-2.5 text-[13px]">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate">{m.displayName ?? m.address}</span>
                    <Switch
                      checked={on}
                      disabled={saveConfig.isPending}
                      onCheckedChange={(checked) =>
                        saveConfig.mutate({
                          id: m.id,
                          cfg: checked ? DEFAULT_TIERS : OFF_TIERS,
                        })
                      }
                    />
                  </div>
                  {on && (
                    <div className="mt-2 grid gap-2 pl-0.5 sm:grid-cols-3">
                      {NOTIFY_TIERS.map((tier) => (
                        <div key={tier.key} className="flex flex-col gap-1">
                          <span className="text-[12px] text-muted-foreground">{tier.label}</span>
                          <Select
                            items={LEVEL_OPTS}
                            value={cfg[tier.key]}
                            onValueChange={(v) =>
                              saveConfig.mutate({
                                id: m.id,
                                cfg: { ...stripId(cfg), [tier.key]: v as NotifyLevel },
                              })
                            }
                          >
                            <SelectTrigger aria-label={`${tier.label} notification`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {LEVEL_OPTS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

type NotifyLevel = "none" | "normal" | "important";
type NotifyTiers = { high: NotifyLevel; normal: NotifyLevel; low: NotifyLevel };
type NotifyConfig = NotifyTiers & { mailboxId: string };

const DEFAULT_TIERS: NotifyTiers = { high: "important", normal: "normal", low: "normal" };
const OFF_TIERS: NotifyTiers = { high: "none", normal: "none", low: "none" };

const NOTIFY_TIERS = [
  { key: "high", label: "Important email" },
  { key: "normal", label: "Normal email" },
  { key: "low", label: "Low-priority email" },
] as const;

const LEVEL_OPTS = [
  { value: "none", label: "None" },
  { value: "normal", label: "Normal" },
  { value: "important", label: "Important" },
];

function stripId(c: NotifyConfig): NotifyTiers {
  return { high: c.high, normal: c.normal, low: c.low };
}
