import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ColorField } from "@/components/ui/color-field.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { type FolderRow, foldersQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";

export function FoldersSection() {
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
    }) => unwrap(rpc.folders[":id"].$patch({ param: { id }, json: body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.folders() }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(rpc.folders[":id"].$delete({ param: { id } })),
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
