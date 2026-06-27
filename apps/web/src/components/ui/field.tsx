import type * as React from "react";
import { cn } from "@/lib/cn";

// Vertical stack of labeled rows sharing hairline dividers — the compose
// recipient block (From / To / Cc / Subject) is one FieldGroup.
export function FieldGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col", className)} {...props} />;
}

// One labeled row. `horizontal` parks the label in a fixed gutter beside the
// control; `vertical` stacks it above. The bottom hairline lets rows abut
// cleanly inside a FieldGroup.
export function Field({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      data-orientation={orientation}
      className={cn(
        "gap-2 border-b py-1.5",
        orientation === "horizontal" ? "flex items-start" : "flex flex-col",
        className,
      )}
      {...props}
    />
  );
}

// Shared with components that render their own label element (AddressField uses
// a <span> so the row's click target stays the input) — keeps every gutter the
// same width so labels line up across the block.
export const fieldLabelClass =
  "w-14 shrink-0 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground leading-5";

export function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn(fieldLabelClass, className)} {...props} />;
}

export function FieldContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}
