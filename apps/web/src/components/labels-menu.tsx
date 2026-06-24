import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Minus, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { labelsQuery, messageLabelsQuery, threadLabelsQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { Button } from "./ui/button.tsx";
import { ColorPicker } from "./ui/color-picker.tsx";
import { useConfirm } from "./ui/confirm.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";
import { LabelChip } from "./ui.tsx";

const DEFAULT_COLOR = "#64748b";

const PRESET_COLORS = [
  "#64748b",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#6366f1",
  "#ec4899",
];

function invalidateLabels(qc: QueryClient, mailboxId: string) {
  qc.invalidateQueries({ queryKey: keys.labels(mailboxId) });
  qc.invalidateQueries({ queryKey: keys.messageLabelsRoot() });
  qc.invalidateQueries({ queryKey: keys.threadLabelsRoot() });
}

// Apply labels to the most recent message in a thread (single-message view).
export function LabelsMenu({
  mailboxId,
  messageId,
  tooltip,
}: {
  mailboxId: string;
  messageId: string;
  tooltip?: string;
}) {
  const qc = useQueryClient();
  const appliedQ = useQuery(messageLabelsQuery([messageId]));
  const applied = new Set((appliedQ.data?.labels[messageId] ?? []).map((l) => l.id));

  const toggle = useMutation({
    mutationFn: (input: { labelId: string; on: boolean }) => {
      const path = `/api/labels/${input.labelId}/messages/${messageId}`;
      return input.on ? api(path, { method: "PUT", body: "{}" }) : api(path, { method: "DELETE" });
    },
    onSuccess: () => invalidateLabels(qc, mailboxId),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <LabelsMenuShell
      mailboxId={mailboxId}
      applied={applied}
      busy={toggle.isPending}
      tooltip={tooltip}
      onToggle={(labelId, on) => toggle.mutate({ labelId, on })}
    />
  );
}

// Apply labels across every message of one or more selected threads (bulk bar).
export function BulkLabelsMenu({
  mailboxId,
  threadIds,
  size,
}: {
  mailboxId: string;
  threadIds: string[];
  size?: "icon" | "icon-sm";
}) {
  const qc = useQueryClient();
  const appliedQ = useQuery(threadLabelsQuery(threadIds));
  const byThread = appliedQ.data?.labels ?? {};

  // A label is fully "applied" only when it rides on every selected thread;
  // present on some-but-not-all shows an indeterminate dash.
  const counts = new Map<string, number>();
  for (const tid of threadIds)
    for (const l of byThread[tid] ?? []) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
  const applied = new Set([...counts].filter(([, n]) => n === threadIds.length).map(([id]) => id));
  const partial = new Set([...counts].filter(([, n]) => n < threadIds.length).map(([id]) => id));

  const toggle = useMutation({
    mutationFn: (input: { labelId: string; on: boolean }) =>
      Promise.all(
        threadIds.map((tid) => {
          const path = `/api/labels/${input.labelId}/threads/${tid}`;
          return input.on
            ? api(path, { method: "PUT", body: "{}" })
            : api(path, { method: "DELETE" });
        }),
      ),
    onSuccess: () => invalidateLabels(qc, mailboxId),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <LabelsMenuShell
      mailboxId={mailboxId}
      applied={applied}
      partial={partial}
      busy={toggle.isPending}
      size={size}
      onToggle={(labelId, on) => toggle.mutate({ labelId, on })}
    />
  );
}

interface ShellProps {
  mailboxId: string;
  applied: Set<string>;
  partial?: Set<string>;
  busy?: boolean;
  size?: "icon" | "icon-sm";
  tooltip?: string;
  onToggle: (labelId: string, on: boolean) => void;
}

function LabelsMenuShell({ size = "icon", tooltip, ...rest }: ShellProps) {
  const trigger = (
    <PopoverTrigger
      render={
        <Button variant="ghost" size={size} aria-label="Labels">
          <Tag />
        </Button>
      }
    />
  );
  return (
    <Popover>
      {tooltip ? <Tooltip label={tooltip}>{trigger}</Tooltip> : trigger}
      <PopoverContent align="end" className="w-72 p-2">
        <LabelsPopover {...rest} />
      </PopoverContent>
    </Popover>
  );
}

function LabelsPopover({ mailboxId, applied, partial, busy, onToggle }: ShellProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const labelsQ = useQuery(labelsQuery(mailboxId));

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [customColor, setCustomColor] = useState(false);

  const invalidate = () => invalidateLabels(qc, mailboxId);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/labels", {
        method: "POST",
        body: JSON.stringify({ mailboxId, name: name.trim(), color }),
      }),
    onSuccess: (res) => {
      setCreating(false);
      setName("");
      setColor(DEFAULT_COLOR);
      setCustomColor(false);
      invalidate();
      onToggle(res.id, true);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: (labelId: string) => api(`/api/labels/${labelId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  async function onDelete(labelId: string, labelName: string) {
    const ok = await confirm({
      title: `Delete label "${labelName}"?`,
      description: "It will be removed from all messages it's applied to.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) remove.mutate(labelId);
  }

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <div className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
          Labels
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCreating((v) => !v)}
          aria-label="New label"
        >
          <Plus />
        </Button>
      </div>

      {creating && (
        <div className="mb-2 space-y-2 rounded-md border bg-card p-2">
          <Input
            ref={(el) => el?.focus()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label name"
            maxLength={64}
          />
          <div className="flex flex-wrap items-center gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setColor(c);
                  setCustomColor(false);
                }}
                className={cn(
                  "h-5 w-5 rounded-full border",
                  !customColor && color === c
                    ? "ring-2 ring-ring ring-offset-1 ring-offset-card"
                    : "",
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <button
              type="button"
              onClick={() => setCustomColor((v) => !v)}
              className={cn(
                "h-5 w-5 rounded-full border",
                customColor ? "ring-2 ring-ring ring-offset-1 ring-offset-card" : "",
              )}
              style={{
                background: customColor
                  ? color
                  : "conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #06b6d4, #6366f1, #ec4899, #ef4444)",
              }}
              aria-label="Custom color"
              title="Custom color"
            />
          </div>

          {customColor && <ColorPicker value={color} onChange={setColor} />}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ul className="max-h-64 overflow-y-auto">
        {(labelsQ.data?.labels ?? []).map((l) => {
          const on = applied.has(l.id);
          const some = partial?.has(l.id);
          return (
            <li key={l.id} className="flex items-center justify-between gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggle(l.id, !on)}
                className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-accent disabled:opacity-50"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: l.color }}
                />
                <span className="flex-1 truncate text-left">{l.name}</span>
                {on ? (
                  <Check className="h-3.5 w-3.5 text-primary" />
                ) : some ? (
                  <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                ) : null}
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onDelete(l.id, l.name)}
                className="hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Delete label ${l.name}`}
              >
                <Trash2 />
              </Button>
            </li>
          );
        })}
        {labelsQ.data && labelsQ.data.labels.length === 0 && !creating && (
          <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No labels yet.
          </li>
        )}
      </ul>
    </>
  );
}

export function LabelChips({ messageId, className }: { messageId: string; className?: string }) {
  const q = useQuery(messageLabelsQuery([messageId]));
  const labels = q.data?.labels[messageId] ?? [];
  if (labels.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {labels.map((l) => (
        <LabelChip key={l.id} name={l.name} color={l.color} />
      ))}
    </div>
  );
}
