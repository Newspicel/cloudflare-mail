import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Kbd } from "./ui/kbd.tsx";

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["j"], label: "Next conversation" },
  { keys: ["k"], label: "Previous conversation" },
  { keys: ["c"], label: "Compose" },
  { keys: ["r"], label: "Reply" },
  { keys: ["f"], label: "Forward" },
  { keys: ["!"], label: "Mark as spam" },
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
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
