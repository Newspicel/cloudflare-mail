import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Sheet = BaseDialog.Root;

const SHEET_SIDE = {
  left: "inset-y-0 left-0 w-72 max-w-[85vw] flex-col border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
  right:
    "inset-y-0 right-0 w-72 max-w-[85vw] flex-col border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
  bottom:
    "inset-x-0 bottom-0 flex-col rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)] data-ending-style:translate-y-full data-starting-style:translate-y-full",
} as const;

/** A panel that slides in from a screen edge. Built on Dialog for focus trapping. */
export function SheetContent({
  className,
  side = "left",
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & { side?: keyof typeof SHEET_SIDE }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup
        className={cn(
          "fixed z-50 flex bg-sidebar text-sidebar-foreground shadow-black/20 shadow-xl outline-none transition-transform duration-300 ease-out",
          SHEET_SIDE[side],
          className,
        )}
        {...props}
      />
    </BaseDialog.Portal>
  );
}
