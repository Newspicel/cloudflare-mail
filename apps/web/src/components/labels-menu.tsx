import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { labelsQuery, messageLabelsQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { Button } from "./ui/button.tsx";
import { useConfirm } from "./ui/confirm.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

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

interface Props {
  mailboxId: string;
  messageId: string;
}

export function LabelsMenu({ mailboxId, messageId }: Props) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Labels">
            <Tag />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 p-2">
        <LabelsPopover mailboxId={mailboxId} messageId={messageId} />
      </PopoverContent>
    </Popover>
  );
}

function LabelsPopover({ mailboxId, messageId }: { mailboxId: string; messageId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const labelsQ = useQuery(labelsQuery(mailboxId));
  const appliedQ = useQuery(messageLabelsQuery([messageId]));
  const applied = new Set((appliedQ.data?.labels[messageId] ?? []).map((l) => l.id));

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: keys.labels(mailboxId) });
    qc.invalidateQueries({ queryKey: keys.messageLabelsRoot() });
    qc.invalidateQueries({ queryKey: keys.threadLabelsRoot() });
  };

  const toggle = useMutation({
    mutationFn: async (input: { labelId: string; on: boolean }) => {
      const path = `/api/labels/${input.labelId}/messages/${messageId}`;
      return input.on ? api(path, { method: "PUT", body: "{}" }) : api(path, { method: "DELETE" });
    },
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

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
      invalidate();
      toggle.mutate({ labelId: res.id, on: true });
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
          <div className="flex flex-wrap gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-5 w-5 rounded-full border",
                  color === c ? "ring-2 ring-ring ring-offset-1 ring-offset-card" : "",
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
          </div>
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
          return (
            <li key={l.id} className="flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={() => toggle.mutate({ labelId: l.id, on: !on })}
                className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-accent"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: l.color }}
                />
                <span className="flex-1 truncate text-left">{l.name}</span>
                {on && <Check className="h-3.5 w-3.5 text-primary" />}
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
        <span
          key={l.id}
          className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium text-[10px]"
          style={{ borderColor: l.color, color: l.color }}
        >
          <span className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: l.color }} />
          {l.name}
        </span>
      ))}
    </div>
  );
}
