import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FolderInput, Inbox, type LucideIcon, Tag } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { api } from "@/lib/api.ts";
import { foldersQuery, labelsQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { useCreateReminder } from "@/lib/reminders.ts";
import { useFileThread, useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { useFinePointer } from "@/lib/use-pointer.ts";
import { formatWhen, remindPresets } from "./reminder-menu.tsx";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";

export interface RowAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

interface Props {
  /** Submenus (labels / folder / reminder) rendered above the flat actions. */
  leading?: ReactNode;
  actions: RowAction[];
  children: ReactNode;
}

// Right-click action menu for a single thread row — mirrors the desktop hover
// cluster. Gated to fine pointers so it never competes with the touch
// long-press action sheet.
export function RowContextMenu({ leading, actions, children }: Props) {
  const fine = useFinePointer();
  if (!fine || (actions.length === 0 && !leading)) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {leading}
        {leading && actions.length > 0 && <ContextMenuSeparator />}
        {actions.map((a) => (
          <Fragment key={a.label}>
            {a.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem variant={a.variant} onClick={a.onClick}>
              <a.icon />
              {a.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />;
}

// Toggle the thread's labels in place. `applied` comes from the row's already
// loaded labels, so no extra fetch — the toggle invalidates the list query and
// the checkmarks reconcile on the next render.
export function LabelsSubmenu({
  mailboxId,
  threadId,
  applied,
}: {
  mailboxId: string;
  threadId: string;
  applied: Set<string>;
}) {
  const qc = useQueryClient();
  const { data: labelsData } = useQuery(labelsQuery(mailboxId));
  const labels = labelsData?.labels ?? [];

  const toggle = useMutation({
    mutationFn: (input: { labelId: string; on: boolean }) => {
      const path = `/api/labels/${input.labelId}/threads/${threadId}`;
      return input.on ? api(path, { method: "PUT", body: "{}" }) : api(path, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.messageLabelsRoot() });
      qc.invalidateQueries({ queryKey: keys.threadLabelsRoot() });
    },
  });

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Tag /> Labels
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-44">
        {labels.length === 0 ? (
          <ContextMenuItem disabled>No labels yet</ContextMenuItem>
        ) : (
          labels.map((l) => (
            <ContextMenuCheckboxItem
              key={l.id}
              checked={applied.has(l.id)}
              onCheckedChange={(on) => toggle.mutate({ labelId: l.id, on })}
            >
              <ColorDot color={l.color} />
              {l.name}
            </ContextMenuCheckboxItem>
          ))
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

// Move the thread into a folder, or back out to the mailbox when viewing one.
export function FolderSubmenu({
  mailboxId,
  threadId,
  currentFolderId,
}: {
  mailboxId: string;
  threadId: string;
  currentFolderId?: string;
}) {
  const { data: foldersData } = useQuery(foldersQuery);
  const folders = foldersData?.folders ?? [];
  const file = useFileThread();
  const unfile = useUnfileThread();
  const others = folders.filter((f) => f.id !== currentFolderId);

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInput /> Move to folder
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-44">
        {currentFolderId && (
          <>
            <ContextMenuItem
              onClick={() => unfile.mutate({ folderId: currentFolderId, threadId, mailboxId })}
            >
              <Inbox /> Move back to mailbox
            </ContextMenuItem>
            {others.length > 0 && <ContextMenuSeparator />}
          </>
        )}
        {others.map((f) => (
          <ContextMenuItem
            key={f.id}
            onClick={() => file.mutate({ folderId: f.id, threadIds: [threadId], mailboxId })}
          >
            <ColorDot color={f.color} />
            {f.name}
          </ContextMenuItem>
        ))}
        {others.length === 0 && !currentFolderId && (
          <ContextMenuItem disabled>No folders yet</ContextMenuItem>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

// Quick reminder presets (custom date+time lives in the full ReminderMenu).
export function ReminderSubmenu({ mailboxId, threadId }: { mailboxId: string; threadId: string }) {
  const create = useCreateReminder();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Clock /> Remind me
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-48">
        {remindPresets().map((p) => (
          <ContextMenuItem
            key={p.label}
            onClick={() => create.mutate({ threadId, mailboxId, remindAt: p.when.getTime() })}
          >
            {p.label}
            <ContextMenuShortcut>{formatWhen(p.when)}</ContextMenuShortcut>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
