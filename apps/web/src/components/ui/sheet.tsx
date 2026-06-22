import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Sheet = BaseDialog.Root;
export const SheetTrigger = BaseDialog.Trigger;
export const SheetClose = BaseDialog.Close;

/** A panel that slides in from a screen edge. Built on Dialog for focus trapping. */
export function SheetContent({
  className,
  side = "left",
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & { side?: "left" | "right" }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup
        className={cn(
          "fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-black/20 shadow-xl outline-none transition-transform duration-300 ease-out",
          side === "left"
            ? "left-0 border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
            : "right-0 border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
          className,
        )}
        {...props}
      />
    </BaseDialog.Portal>
  );
}
