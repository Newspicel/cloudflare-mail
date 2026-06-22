import type * as React from "react";
import { cn } from "@/lib/cn";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "select-none text-xs font-medium text-muted-foreground peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
