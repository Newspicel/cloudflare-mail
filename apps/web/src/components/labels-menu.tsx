import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { labelsQuery, messageLabelsQuery } from "@/lib/queries.ts";

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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        aria-label="Labels"
        title="Labels"
      >
        <Tag className="h-4 w-4" />
      </button>
      {open && (
        <LabelsPopover mailboxId={mailboxId} messageId={messageId} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function LabelsPopover({
  mailboxId,
  messageId,
  onClose,
}: {
  mailboxId: string;
  messageId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const labelsQ = useQuery(labelsQuery(mailboxId));
  const appliedQ = useQuery(messageLabelsQuery([messageId]));
  const applied = new Set((appliedQ.data?.labels[messageId] ?? []).map((l) => l.id));

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["labels", mailboxId] });
    qc.invalidateQueries({ queryKey: ["message-labels"] });
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

  return (
    <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-md">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Labels
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="New label"
          title="New label"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {creating && (
        <div className="mb-2 space-y-2 rounded-md border bg-background p-2">
          <input
            ref={(el) => el?.focus()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label name"
            className="w-full rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
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
                  color === c ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : "",
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
              className="flex-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
            >
              Cancel
            </button>
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
                className="flex flex-1 items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-muted"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: l.color }}
                />
                <span className="flex-1 truncate text-left">{l.name}</span>
                {on && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete label "${l.name}"?`)) remove.mutate(l.id);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Delete label ${l.name}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          );
        })}
        {labelsQ.data && labelsQ.data.labels.length === 0 && !creating && (
          <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No labels yet.
          </li>
        )}
      </ul>

      <div className="mt-1 flex justify-end border-t pt-1.5">
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>
    </div>
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
          className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium"
          style={{ borderColor: l.color, color: l.color }}
        >
          <span className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: l.color }} />
          {l.name}
        </span>
      ))}
    </div>
  );
}
