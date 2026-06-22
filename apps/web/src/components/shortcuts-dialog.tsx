import { X } from "lucide-react";

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
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        className="relative w-full max-w-sm rounded-md border bg-card text-card-foreground shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="divide-y">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 px-4 py-2">
              <span className="text-[13px]">{s.label}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex min-w-[1.5rem] justify-center rounded border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
