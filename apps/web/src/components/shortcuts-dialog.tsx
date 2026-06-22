import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["j"], label: "Next conversation" },
  { keys: ["k"], label: "Previous conversation" },
  { keys: ["c"], label: "Compose" },
  { keys: ["r"], label: "Reply" },
  { keys: ["f"], label: "Forward" },
  { keys: ["e"], label: "Archive" },
  { keys: ["#"], label: "Move to Trash" },
  { keys: ["s"], label: "Star / unstar" },
  { keys: ["u"], label: "Mark unread" },
  { keys: ["/"], label: "Search" },
  { keys: ["?"], label: "Show this help" },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="-mx-1 divide-y">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 px-1 py-2">
              <span className="text-[13px]">{s.label}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex min-w-[1.5rem] justify-center rounded border bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
