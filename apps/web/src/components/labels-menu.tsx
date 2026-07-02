import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Minus, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import {
  labelsQuery,
  type MessageLabel,
  messageLabelsQuery,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { Button } from "./ui/button.tsx";
import { ColorField, DEFAULT_COLOR } from "./ui/color-field.tsx";
import { useConfirm } from "./ui/confirm.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";
import { LabelChip } from "./ui.tsx";

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
  const { data: appliedData } = useQuery(messageLabelsQuery([messageId]));
  const byMessage: Record<string, MessageLabel[]> = appliedData?.labels ?? {};
  const applied = new Set((byMessage[messageId] ?? []).map((l) => l.id));

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess refreshes label caches via invalidateLabels()
  const toggle = useMutation({
    mutationFn: (input: { labelId: string; on: boolean }) => {
      const target = rpc.labels[":id"].messages[":messageId"];
      const param = { id: input.labelId, messageId };
      return input.on ? unwrap(target.$put({ param })) : unwrap(target.$delete({ param }));
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
  const { data: appliedData } = useQuery(threadLabelsQuery(threadIds));
  const byThread: Record<string, MessageLabel[]> = appliedData?.labels ?? {};

  // A label is fully "applied" only when it rides on every selected thread;
  // present on some-but-not-all shows an indeterminate dash.
  const counts = new Map<string, number>();
  for (const tid of threadIds)
    for (const l of byThread[tid] ?? []) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
  const applied = new Set([...counts].flatMap(([id, n]) => (n === threadIds.length ? [id] : [])));
  const partial = new Set([...counts].flatMap(([id, n]) => (n < threadIds.length ? [id] : [])));

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess refreshes label caches via invalidateLabels()
  const toggle = useMutation({
    mutationFn: (input: { labelId: string; on: boolean }) =>
      Promise.all(
        threadIds.map((tid) => {
          const target = rpc.labels[":id"].threads[":threadId"];
          const param = { id: input.labelId, threadId: tid };
          return input.on ? unwrap(target.$put({ param })) : unwrap(target.$delete({ param }));
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
  const { data: labelsData } = useQuery(labelsQuery(mailboxId));

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const invalidate = () => invalidateLabels(qc, mailboxId);

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess refreshes label caches via invalidate()
  const create = useMutation({
    mutationFn: () => unwrap(rpc.labels.$post({ json: { mailboxId, name: name.trim(), color } })),
    onSuccess: (res) => {
      setCreating(false);
      setName("");
      setColor(DEFAULT_COLOR);
      invalidate();
      onToggle(res.id, true);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- onSuccess refreshes label caches via invalidate()
  const remove = useMutation({
    mutationFn: (labelId: string) => unwrap(rpc.labels[":id"].$delete({ param: { id: labelId } })),
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
          <ColorField color={color} onChange={setColor} />
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
        {(labelsData?.labels ?? []).map((l) => {
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
        {labelsData && labelsData.labels.length === 0 && !creating && (
          <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No labels yet.
          </li>
        )}
      </ul>
    </>
  );
}

export function LabelChips({ messageId, className }: { messageId: string; className?: string }) {
  const { data } = useQuery(messageLabelsQuery([messageId]));
  const byMessage: Record<string, MessageLabel[]> = data?.labels ?? {};
  const labels = byMessage[messageId] ?? [];
  if (labels.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {labels.map((l) => (
        <LabelChip key={l.id} name={l.name} color={l.color} />
      ))}
    </div>
  );
}
