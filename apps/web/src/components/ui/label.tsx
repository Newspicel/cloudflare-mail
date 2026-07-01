import type * as React from "react";
import { cn } from "@/lib/cn";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // eslint-disable-next-line react-doctor/label-has-associated-control -- generic label primitive; consumers pass htmlFor or nest the control via ...props
    <label
      className={cn(
        "select-none text-xs font-medium text-muted-foreground peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
