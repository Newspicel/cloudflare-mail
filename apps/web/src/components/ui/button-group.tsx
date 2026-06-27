import type * as React from "react";
import { cn } from "@/lib/cn";

// Joins adjacent buttons/inputs into one seam — collapsing the touching corners
// and overlapping the 1px borders so the group reads as a single control (e.g.
// the split Send / Schedule button).
export function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      role="group"
      data-orientation={orientation}
      className={cn(
        "flex w-fit items-stretch [&>*]:focus-visible:z-10",
        orientation === "horizontal"
          ? "flex-row [&>*:not(:first-child)]:-ml-px [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none"
          : "flex-col [&>*:not(:first-child)]:-mt-px [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none",
        className,
      )}
      {...props}
    />
  );
}
