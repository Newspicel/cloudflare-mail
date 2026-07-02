import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, FolderPlus, Inbox } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { foldersQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useFileThread, useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

interface Props {
  threadIds: string[];
  mailboxId: string;
  size?: "icon" | "icon-sm";
  tooltip?: string;
  // When viewing inside a folder, lets the user move the thread back out to the
  // mailbox ("remove from folder"). Only meaningful for a single thread.
  currentFolderId?: string;
  onMoved?: (folderName: string) => void;
}

export function MoveToFolderMenu({
  threadIds,
  mailboxId,
  size = "icon",
  tooltip,
  currentFolderId,
  onMoved,
}: Props) {
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
          currentFolderId={currentFolderId}
          onMoved={(n) => {
            setOpen(false);
            onMoved?.(n);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function MovePopover({ threadIds, mailboxId, currentFolderId, onMoved }: Props) {
  const qc = useQueryClient();
  const { data: foldersData } = useQuery(foldersQuery);
  const folders = foldersData?.folders ?? [];
  const file = useFileThread();
  const unfile = useUnfileThread();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  function move(folderId: string, folderName: string) {
    file.mutate({ folderId, threadIds, mailboxId }, { onSuccess: () => onMoved?.(folderName) });
  }

  function moveBack() {
    if (!currentFolderId || threadIds.length !== 1) return;
    unfile.mutate(
      { folderId: currentFolderId, threadId: threadIds[0]!, mailboxId },
      { onSuccess: () => onMoved?.("Mailbox") },
    );
  }

  const otherFolders = folders.filter((f) => f.id !== currentFolderId);

  const create = useMutation({
    mutationFn: () => unwrap(rpc.folders.$post({ json: { name: name.trim() } })),
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
        {currentFolderId && threadIds.length === 1 && (
          <li className={otherFolders.length > 0 ? "mb-1 border-b pb-1" : ""}>
            <button
              type="button"
              onClick={moveBack}
              disabled={unfile.isPending}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent disabled:opacity-50"
            >
              <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-left">Move back to mailbox</span>
            </button>
          </li>
        )}
        {otherFolders.map((f) => (
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
