import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type * as React from "react";
import { cn } from "@/lib/cn";

/** Single-select segmented control with roving-focus / radio-group a11y. */
export function ToggleGroup<T extends string>({
  value,
  onValueChange,
  disabled,
  className,
  children,
}: {
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseToggleGroup
      value={[value]}
      onValueChange={(next) => {
        // Segmented controls always keep one item selected — ignore deselection.
        if (next[0]) onValueChange(next[0] as T);
      }}
      disabled={disabled}
      className={cn(
        "inline-flex items-center rounded-md border bg-background p-0.5 shadow-sm",
        className,
      )}
    >
      {children}
    </BaseToggleGroup>
  );
}

const activeStyles = {
  primary: "data-pressed:bg-primary data-pressed:text-primary-foreground data-pressed:shadow-sm",
  accent: "data-pressed:bg-accent data-pressed:text-foreground",
} as const;

export function ToggleItem({
  value,
  variant = "primary",
  className,
  children,
}: {
  value: string;
  variant?: keyof typeof activeStyles;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Toggle
      value={value}
      className={cn(
        "flex items-center gap-1 rounded px-2.5 py-1 font-medium text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-50 [&_svg]:size-3.5",
        activeStyles[variant],
        className,
      )}
    >
      {children}
    </Toggle>
  );
}
