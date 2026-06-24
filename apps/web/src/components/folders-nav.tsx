import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Folder, FolderPlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type FolderRow, foldersQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { Button } from "./ui/button.tsx";
import { ColorField, DEFAULT_COLOR } from "./ui/color-field.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { Input } from "./ui/input.tsx";
import { UnreadBadge } from "./ui.tsx";

export function FoldersNav({ onClose }: { onClose?: () => void }) {
  const { data } = useQuery(foldersQuery);
  const folders = data?.folders ?? [];
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirmDelete } = useConfirmHelpers();
  const params = useParams({ strict: false });
  const activeId = (params as { folderId?: string }).folderId;

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), color }),
      }),
    onSuccess: () => {
      setCreating(false);
      setName("");
      setColor(DEFAULT_COLOR);
      qc.invalidateQueries({ queryKey: keys.folders() });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/folders/${id}`, { method: "DELETE" }),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: keys.folders() });
      if (activeId === id) nav({ to: "/app" });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to delete"),
  });

  async function onDelete(f: FolderRow) {
    const ok = await confirmDelete(
      `folder "${f.name}"`,
      "The folder is removed; its conversations return to their mailboxes.",
    );
    if (ok) remove.mutate(f.id);
  }

  return (
    <section>
      <h3 className="mb-1 flex items-center justify-between gap-1.5 px-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
        <span className="flex items-center gap-1.5">
          <Folder className="h-3 w-3" /> Folders
        </span>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          aria-label="New folder"
          title="New folder"
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </h3>

      {creating && (
        <form
          className="mb-2 space-y-2 rounded-md border bg-card p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            ref={(el) => el?.focus()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Folder name"
            maxLength={64}
            className="h-7 text-[13px]"
          />
          <ColorField color={color} onChange={setColor} />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <ul className="flex flex-col gap-0.5">
        {folders.map((f) => (
          <li key={f.id} className="group/row relative">
            <Link
              to="/app/folder/$folderId"
              params={{ folderId: f.id }}
              onClick={() => onClose?.()}
              data-active-nav={activeId === f.id || undefined}
              className={cn(
                "relative z-10 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors",
                activeId === f.id
                  ? "font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60",
              )}
            >
              <span
                className={cn("flex min-w-0 items-center gap-2", f.unread > 0 && "font-medium")}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: f.color }}
                />
                <span className="truncate">{f.name}</span>
              </span>
              <span className="ml-2 flex shrink-0 items-center gap-1 group-hover/row:invisible">
                <UnreadBadge count={f.unread} />
              </span>
            </Link>
            <button
              type="button"
              aria-label={`Delete ${f.name}`}
              title="Delete folder"
              disabled={remove.isPending}
              onClick={() => onDelete(f)}
              className="absolute inset-y-0 right-1 my-auto hidden h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover/row:flex"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
