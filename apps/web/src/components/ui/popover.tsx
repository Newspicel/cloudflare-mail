import { Popover as BasePopover } from "@base-ui/react/popover";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

export function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof BasePopover.Popup> &
  Pick<React.ComponentProps<typeof BasePopover.Positioner>, "side" | "align" | "sideOffset">) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <BasePopover.Popup
          className={cn(
            "max-h-[var(--available-height)] min-w-[12rem] origin-[var(--transform-origin)] overflow-y-auto rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-black/10 shadow-lg outline-none transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
