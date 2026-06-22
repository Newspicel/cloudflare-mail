import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
export const DialogPortal = BaseDialog.Portal;

export function DialogBackdrop({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Backdrop>) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & { showClose?: boolean }) {
  return (
    <BaseDialog.Portal>
      <DialogBackdrop />
      <BaseDialog.Popup
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-black/15 shadow-xl outline-none transition duration-200 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <BaseDialog.Close
            className="absolute top-3.5 right-3.5 rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
            aria-label="Close"
          >
            <X className="size-4" />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 pr-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      className={cn("font-semibold text-[15px] tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      className={cn("text-[13px] text-muted-foreground", className)}
      {...props}
    />
  );
}
