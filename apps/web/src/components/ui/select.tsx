import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger>) {
  return (
    <BaseSelect.Trigger
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-card px-2.5 text-[13px] text-foreground shadow-sm outline-none transition-colors hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-[placeholder]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="text-muted-foreground">
        <ChevronsUpDown className="size-3.5" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup>) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        alignItemWithTrigger={false}
        side="bottom"
        sideOffset={6}
        className="z-50"
      >
        <BaseSelect.Popup
          className={cn(
            "max-h-[var(--available-height)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-black/10 shadow-lg outline-none transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none transition-colors data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemIndicator className="absolute left-2 flex items-center text-primary">
        <Check className="size-3.5" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}
