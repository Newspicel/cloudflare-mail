import type * as React from "react";
import { cn } from "@/lib/cn";

// Centered "nothing here yet" state — icon, title, and a short line of
// direction. An empty screen is an invitation to act, so pair it with copy that
// says what to do next.
export function Empty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-4 py-6 text-center",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyMedia({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mb-1 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-medium text-[13px] text-foreground", className)} {...props} />;
}

export function EmptyDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-balance text-[12px] text-muted-foreground", className)} {...props} />
  );
}
