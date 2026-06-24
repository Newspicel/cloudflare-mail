import type * as React from "react";
import { cn } from "@/lib/cn";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[1.5rem] items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
