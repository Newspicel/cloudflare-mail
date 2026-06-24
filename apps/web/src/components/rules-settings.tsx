import type {
  RuleAction,
  RuleActionType,
  RuleCondition,
  RuleConditionMode,
  RuleField,
  RuleOp,
} from "@cfmail/shared";
import { RULE_ACTION_TYPES, RULE_CONDITION_MODES, RULE_FIELDS, RULE_OPS } from "@cfmail/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import {
  foldersQuery,
  labelsQuery,
  type MailboxSummary,
  type RuleRow,
  rulesQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { Section } from "./settings-ui.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Switch } from "./ui/switch.tsx";
import { Textarea } from "./ui/textarea.tsx";

const FIELD_LABELS: Record<RuleField, string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  body: "Body",
  deliveredTo: "To address",
};

const OP_LABELS: Record<RuleOp, string> = {
  contains: "contains",
  equals: "equals",
  startsWith: "starts with",
  endsWith: "ends with",
  wildcard: "matches (wildcard)",
  regex: "matches (regex)",
};

const ACTION_LABELS: Record<RuleActionType, string> = {
  applyLabel: "Apply label",
  moveFolder: "Move to folder",
  markRead: "Mark as read",
  markSpam: "Mark as spam",
  forward: "Forward to address",
  autoReply: "Auto-reply",
  hardBlock: "Block (reject)",
  stopProcessing: "Stop processing rules",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Section ────────────────────────────────────────────────────────────────

export function RulesSection({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  const selected = mailboxes.find((m) => m.id === mailboxId) ?? mailboxes[0];

  return (
    <Section
      id="rules"
      title="Rules"
      description="Automatically label, file, mark, or block incoming mail. Rules run top to bottom."
      action={
        mailboxes.length > 1 ? (
          <div className="w-48">
            <Select value={mailboxId} onValueChange={(v) => setMailboxId(v as string)}>
              <SelectTrigger aria-label="Mailbox">
                <SelectValue>
                  {(value) => {
                    const m = mailboxes.find((mb) => mb.id === value);
                    return m?.displayName ?? m?.address ?? "";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {mailboxes.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName ?? m.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : undefined
      }
    >
      {mailboxes.length === 0 ? (
        <div className="text-[13px] text-muted-foreground">No editable mailboxes yet.</div>
      ) : selected ? (
        <RulesList mailbox={selected} mailboxes={mailboxes} />
      ) : null}
    </Section>
  );
}

function RulesList({
  mailbox,
  mailboxes,
}: {
  mailbox: MailboxSummary;
  mailboxes: MailboxSummary[];
}) {
  const qc = useQueryClient();
  const { confirmDelete } = useConfirmHelpers();
  const mailboxId = mailbox.id;
  const { data } = useQuery(rulesQuery(mailboxId));
  const rules = data?.rules ?? [];
  const [editing, setEditing] = useState<RuleRow | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = (id: string) => qc.invalidateQueries({ queryKey: keys.rules(id) });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/api/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidate(mailboxId),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(mailboxId),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const clone = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      api<{ id: string; strippedLabels: string[] }>(`/api/rules/${id}/clone`, {
        method: "POST",
        body: JSON.stringify({ mailboxId: targetId }),
      }),
    onSuccess: (res, vars) => {
      invalidate(vars.targetId);
      if (res.strippedLabels.length) {
        toast.warning(
          `Cloned without labels not in the target mailbox: ${res.strippedLabels.join(", ")}`,
        );
      } else {
        toast.success("Rule cloned");
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Swap a rule's priority with its neighbour to reorder.
  const move = (index: number, dir: -1 | 1) => {
    const a = rules[index];
    const b = rules[index + dir];
    if (!a || !b) return;
    update.mutate({ id: a.id, priority: b.priority });
    update.mutate({ id: b.id, priority: a.priority });
  };

  async function onDelete(r: RuleRow) {
    if (await confirmDelete(`rule "${r.name}"`, "It stops running on new mail immediately.")) {
      remove.mutate(r.id);
    }
  }

  return (
    <>
      {rules.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-5 py-8 text-center">
          <p className="text-[13px] text-muted-foreground">
            No rules yet. Add one to automate incoming mail.
          </p>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> Add rule
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-muted-foreground">
              {rules.length} rule{rules.length === 1 ? "" : "s"}
            </span>
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> Add rule
            </Button>
          </div>
          <ul className="divide-y overflow-hidden rounded-md border">
            {rules.map((r, i) => (
              <li
                key={r.id}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
              >
                <Switch
                  checked={r.enabled}
                  disabled={update.isPending}
                  onCheckedChange={(checked) => update.mutate({ id: r.id, enabled: checked })}
                  aria-label={`Enable ${r.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div
                    className={
                      r.enabled
                        ? "truncate text-[13px] font-medium"
                        : "truncate text-[13px] font-medium text-muted-foreground"
                    }
                  >
                    {r.name}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">{summarize(r)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move up"
                    disabled={i === 0 || update.isPending}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move down"
                    disabled={i === rules.length - 1 || update.isPending}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${r.name}`}
                    onClick={() => setEditing(r)}
                  >
                    <Pencil />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Clone ${r.name}`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
                    >
                      <Copy />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Clone to…</DropdownMenuLabel>
                      <DropdownMenuItem
                        onClick={() => clone.mutate({ id: r.id, targetId: mailboxId })}
                      >
                        This mailbox (duplicate)
                      </DropdownMenuItem>
                      {mailboxes.filter((m) => m.id !== mailboxId).length > 0 && (
                        <DropdownMenuSeparator />
                      )}
                      {mailboxes
                        .filter((m) => m.id !== mailboxId)
                        .map((m) => (
                          <DropdownMenuItem
                            key={m.id}
                            onClick={() => clone.mutate({ id: r.id, targetId: m.id })}
                          >
                            {m.displayName ?? m.address}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => onDelete(r)}
                    className="hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(creating || editing) && (
        <RuleEditor
          mailboxId={mailboxId}
          rule={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => invalidate(mailboxId)}
        />
      )}
    </>
  );
}

function summarize(r: RuleRow): string {
  const conds = r.conditions.length;
  const condText = `${conds} condition${conds === 1 ? "" : "s"} (${r.conditionMode})`;
  const acts = r.actions.map((a) => ACTION_LABELS[a.type]).join(", ");
  return `${condText} → ${acts || "no actions"}`;
}

// ─── Editor ─────────────────────────────────────────────────────────────────

// Drafts carry a stable `rowId` purely for React list keys (rows are reorderable
// by add/remove); it's stripped before the rule is saved.
const uid = () => crypto.randomUUID();
type CondDraft = RuleCondition & { rowId: string };
type ActionDraft = {
  rowId: string;
  type: RuleActionType;
  labelId?: string;
  folderId?: string;
  to?: string;
  subject?: string;
  body?: string;
};

function RuleEditor({
  mailboxId,
  rule,
  onClose,
  onSaved,
}: {
  mailboxId: string;
  rule: RuleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const labelsQ = useQuery(labelsQuery(mailboxId));
  const foldersQ = useQuery(foldersQuery);
  const labels = labelsQ.data?.labels ?? [];
  const folders = foldersQ.data?.folders ?? [];

  const [name, setName] = useState(rule?.name ?? "");
  const [mode, setMode] = useState<RuleConditionMode>(rule?.conditionMode ?? "all");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [conditions, setConditions] = useState<CondDraft[]>(
    rule?.conditions.length
      ? rule.conditions.map((c) => ({ ...c, rowId: uid() }))
      : [{ rowId: uid(), field: "from", op: "contains", value: "" }],
  );
  const [actions, setActions] = useState<ActionDraft[]>(
    rule?.actions.length
      ? rule.actions.map((a) => ({
          rowId: uid(),
          type: a.type,
          labelId: a.type === "applyLabel" ? a.labelId : undefined,
          folderId: a.type === "moveFolder" ? a.folderId : undefined,
          to: a.type === "forward" ? a.to : undefined,
          subject: a.type === "autoReply" ? a.subject : undefined,
          body: a.type === "autoReply" ? a.body : undefined,
        }))
      : [{ rowId: uid(), type: "applyLabel" }],
  );

  const valid =
    name.trim().length > 0 &&
    conditions.length > 0 &&
    conditions.every((c) => c.value.trim().length > 0) &&
    actions.length > 0 &&
    actions.every(
      (a) =>
        (a.type !== "applyLabel" || !!a.labelId) &&
        (a.type !== "moveFolder" || !!a.folderId) &&
        (a.type !== "forward" || EMAIL_RE.test((a.to ?? "").trim())) &&
        (a.type !== "autoReply" || (a.body ?? "").trim().length > 0),
    );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        conditionMode: mode,
        conditions: conditions.map((c) => ({
          field: c.field,
          op: c.op,
          value: c.value.trim(),
        })),
        actions: actions.map((a): RuleAction => {
          if (a.type === "applyLabel") return { type: "applyLabel", labelId: a.labelId! };
          if (a.type === "moveFolder") return { type: "moveFolder", folderId: a.folderId! };
          if (a.type === "forward") return { type: "forward", to: a.to!.trim() };
          if (a.type === "autoReply") {
            const subject = a.subject?.trim();
            return { type: "autoReply", body: a.body!.trim(), ...(subject ? { subject } : {}) };
          }
          return { type: a.type };
        }),
        enabled,
      };
      return rule
        ? api(`/api/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api("/api/rules", { method: "POST", body: JSON.stringify({ mailboxId, ...body }) });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(rule ? "Rule updated" : "Rule created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const setCondition = (i: number, patch: Partial<RuleCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCondition = () =>
    setConditions((cs) => [...cs, { rowId: uid(), field: "from", op: "contains", value: "" }]);
  const addAction = () => setActions((as) => [...as, { rowId: uid(), type: "markRead" }]);
  const setAction = (i: number, patch: Partial<ActionDraft>) =>
    setActions((as) => as.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <div>
            <span className="mb-1 block text-[12px] font-medium text-foreground">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="e.g. Newsletters"
              aria-label="Rule name"
            />
          </div>

          {/* Conditions */}
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-foreground">
              Match
              <Select value={mode} onValueChange={(v) => setMode(v as RuleConditionMode)}>
                <SelectTrigger className="h-7 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_CONDITION_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m === "all" ? "all of" : "any of"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div key={c.rowId} className="flex items-center gap-1.5">
                  <Select
                    value={c.field}
                    onValueChange={(v) => setCondition(i, { field: v as RuleField })}
                  >
                    <SelectTrigger className="h-8 w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RULE_FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {FIELD_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={c.op} onValueChange={(v) => setCondition(i, { op: v as RuleOp })}>
                    <SelectTrigger className="h-8 w-36 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RULE_OPS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {OP_LABELS[o]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                    placeholder="value"
                    maxLength={512}
                    className="min-w-0 flex-1"
                  />
                  <button
                    type="button"
                    aria-label="Remove condition"
                    disabled={conditions.length === 1}
                    onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}
                    className="rounded p-1.5 text-muted-foreground transition hover:bg-muted disabled:opacity-30"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addCondition}
              className="mt-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
            >
              <Plus className="size-3" /> Add condition
            </button>
          </div>

          {/* Actions */}
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-foreground">Then</div>
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div key={a.rowId} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={a.type}
                      onValueChange={(v) => setAction(i, { type: v as RuleActionType })}
                    >
                      <SelectTrigger className="h-8 w-44 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_ACTION_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {ACTION_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {a.type === "applyLabel" && (
                      <Select
                        value={a.labelId ?? ""}
                        onValueChange={(v) => setAction(i, { labelId: v as string })}
                      >
                        <SelectTrigger className="h-8 min-w-0 flex-1">
                          <SelectValue placeholder={labels.length ? "Pick a label" : "No labels"} />
                        </SelectTrigger>
                        <SelectContent>
                          {labels.map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {a.type === "moveFolder" && (
                      <Select
                        value={a.folderId ?? ""}
                        onValueChange={(v) => setAction(i, { folderId: v as string })}
                      >
                        <SelectTrigger className="h-8 min-w-0 flex-1">
                          <SelectValue
                            placeholder={folders.length ? "Pick a folder" : "No folders"}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {folders.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {a.type === "forward" && (
                      <Input
                        type="email"
                        value={a.to ?? ""}
                        onChange={(e) => setAction(i, { to: e.target.value })}
                        placeholder="forward@example.com"
                        aria-label="Forward to address"
                        className="h-8 min-w-0 flex-1"
                      />
                    )}
                    {a.type === "autoReply" && (
                      <Input
                        value={a.subject ?? ""}
                        onChange={(e) => setAction(i, { subject: e.target.value })}
                        maxLength={255}
                        placeholder="Subject (optional)"
                        aria-label="Auto-reply subject"
                        className="h-8 min-w-0 flex-1"
                      />
                    )}
                    <button
                      type="button"
                      aria-label="Remove action"
                      disabled={actions.length === 1}
                      onClick={() => setActions((as) => as.filter((_, idx) => idx !== i))}
                      className="ml-auto rounded p-1.5 text-muted-foreground transition hover:bg-muted disabled:opacity-30"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  {a.type === "autoReply" && (
                    <Textarea
                      value={a.body ?? ""}
                      onChange={(e) => setAction(i, { body: e.target.value })}
                      maxLength={5000}
                      rows={3}
                      placeholder="Auto-reply message…"
                      aria-label="Auto-reply message"
                      className="ml-[11.75rem] min-h-16"
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addAction}
              className="mt-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
            >
              <Plus className="size-3" /> Add action
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 text-[13px]">
            <span className="font-medium">Enabled</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!valid || save.isPending}
          >
            {rule ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
