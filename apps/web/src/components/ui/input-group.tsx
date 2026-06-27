import type * as React from "react";
import { cn } from "@/lib/cn";

// A bordered control that wraps a borderless input together with inline addons
// (icons, fixed prefix/suffix text, small buttons) so they share one focus
// ring — e.g. the "local+tag@domain" sub-address builder or the time picker.
export function InputGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex h-8 w-full items-center rounded-md border bg-card text-[13px] text-foreground shadow-sm outline-none transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupInput({
  className,
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "min-w-0 flex-1 bg-transparent px-2.5 outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

// Non-interactive cluster pinned to one edge of the group. `align` keeps it
// snug against the matching border.
export function InputGroupAddon({
  className,
  align = "start",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" }) {
  return (
    <div
      className={cn(
        "flex shrink-0 select-none items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5",
        align === "start" ? "pl-2.5" : "pr-2.5",
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupText({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-muted-foreground", className)} {...props} />;
}
