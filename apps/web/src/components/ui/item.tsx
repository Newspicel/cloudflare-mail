import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/cn";

// A horizontal row primitive: optional leading media, a content column
// (title + description), and trailing actions. Used for attachment rows and the
// schedule / template pickers.
const itemVariants = cva("flex items-center gap-2.5 rounded-md text-[13px]", {
  variants: {
    variant: {
      default: "",
      outline: "border bg-card",
      muted: "bg-muted/40",
    },
    size: {
      default: "px-2.5 py-2",
      sm: "px-2 py-1.5",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Item({
  className,
  variant,
  size,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof itemVariants>) {
  return <div className={cn(itemVariants({ variant, size }), className)} {...props} />;
}

export function ItemMedia({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function ItemContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props} />;
}

export function ItemTitle({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("truncate font-medium text-foreground leading-tight", className)} {...props} />
  );
}

export function ItemDescription({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("truncate text-[11px] text-muted-foreground leading-tight", className)}
      {...props}
    />
  );
}

export function ItemActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 items-center gap-1", className)} {...props} />;
}
