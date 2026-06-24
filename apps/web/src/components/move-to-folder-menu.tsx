import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, FolderPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { foldersQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useFileThread } from "@/lib/use-folder-mutations.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

interface Props {
  threadIds: string[];
  mailboxId: string;
  size?: "icon" | "icon-sm";
  tooltip?: string;
  onMoved?: (folderName: string) => void;
}

export function MoveToFolderMenu({ threadIds, mailboxId, size = "icon", tooltip, onMoved }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = (
    <PopoverTrigger
      render={
        <Button variant="ghost" size={size} aria-label="Move to folder">
          <FolderInput />
        </Button>
      }
    />
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {tooltip ? <Tooltip label={tooltip}>{trigger}</Tooltip> : trigger}
      <PopoverContent align="end" className="w-64 p-2">
        <MovePopover
          threadIds={threadIds}
          mailboxId={mailboxId}
          onMoved={(n) => {
            setOpen(false);
            onMoved?.(n);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function MovePopover({ threadIds, mailboxId, onMoved }: Props) {
  const qc = useQueryClient();
  const foldersQ = useQuery(foldersQuery);
  const folders = foldersQ.data?.folders ?? [];
  const file = useFileThread();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  function move(folderId: string, folderName: string) {
    file.mutate({ folderId, threadIds, mailboxId }, { onSuccess: () => onMoved?.(folderName) });
  }

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: keys.folders() });
      move(res.id, name.trim());
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <div className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
          Move to folder
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCreating((v) => !v)}
          aria-label="New folder"
        >
          <FolderPlus />
        </Button>
      </div>

      {creating && (
        <form
          className="mb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            ref={(el) => el?.focus()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New folder name"
            maxLength={64}
            disabled={create.isPending}
          />
        </form>
      )}

      <ul className="max-h-64 overflow-y-auto">
        {folders.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => move(f.id, f.name)}
              disabled={file.isPending}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent disabled:opacity-50"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: f.color }}
              />
              <span className="flex-1 truncate text-left">{f.name}</span>
            </button>
          </li>
        ))}
        {folders.length === 0 && !creating && (
          <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No folders yet — create one.
          </li>
        )}
      </ul>
    </>
  );
}
