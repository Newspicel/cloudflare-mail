import {
  ArchiveRestore,
  CheckSquare,
  type LucideIcon,
  Mail,
  MailOpen,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { MailView, ThreadRow } from "@/lib/queries.ts";
import { Sheet, SheetContent } from "./ui/sheet.tsx";

interface Action {
  icon: LucideIcon;
  label: string;
  run: () => void;
  /** Render in the destructive colour. */
  danger?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadRow;
  view: MailView;
  onToggleRead: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onSpam: (spam: boolean) => void;
  onSelect: () => void;
}

// Long-press action sheet for a single thread on touch devices — mirrors the
// desktop hover/bulk actions, and "Select" hands off to multi-select mode.
export function ThreadActionSheet({
  open,
  onOpenChange,
  thread,
  view,
  onToggleRead,
  onTrash,
  onRestore,
  onDelete,
  onSpam,
  onSelect,
}: Props) {
  const unread = thread.unreadCount > 0;
  const close = () => onOpenChange(false);
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  const actions: Action[] = [
    { icon: CheckSquare, label: "Select", run: act(onSelect) },
    {
      icon: unread ? MailOpen : Mail,
      label: unread ? "Mark as read" : "Mark as unread",
      run: act(onToggleRead),
    },
  ];
  if (view === "trash") {
    if (thread.trashed) {
      actions.push({ icon: ArchiveRestore, label: "Restore", run: act(onRestore) });
      actions.push({
        icon: Trash2,
        label: "Delete permanently",
        run: act(onDelete),
        danger: true,
      });
    }
  } else {
    actions.push({
      icon: ShieldAlert,
      label: view === "spam" ? "Not spam" : "Mark as spam",
      run: act(() => onSpam(view !== "spam")),
    });
    actions.push({ icon: Trash2, label: "Trash", run: act(onTrash), danger: true });
  }

  const title = thread.subjectNorm || "(no subject)";
  const from = thread.participants[0];
  const sender = from?.name ?? from?.address ?? "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-1 p-2 pt-1.5">
        <div className="mx-auto mb-1 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" />
        <div className="min-w-0 px-3 py-1.5">
          <p className="truncate font-medium text-[13px]">{title}</p>
          {sender && <p className="truncate text-[12px] text-muted-foreground">{sender}</p>}
        </div>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.run}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] active:bg-muted ${
              a.danger ? "text-destructive" : ""
            }`}
          >
            <a.icon className="h-[18px] w-[18px] shrink-0" />
            {a.label}
          </button>
        ))}
      </SheetContent>
    </Sheet>
  );
}
