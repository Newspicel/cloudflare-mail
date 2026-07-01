import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const TooltipProvider = BaseTooltip.Provider;

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Popup> &
  Pick<React.ComponentProps<typeof BaseTooltip.Positioner>, "side" | "sideOffset">) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <BaseTooltip.Popup
          className={cn(
            "rounded-md bg-foreground px-2 py-1 font-medium text-[11px] text-background shadow-md transition duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}

/** Convenience wrapper: a trigger with a text tooltip. */
export function Tooltip({
  label,
  children,
  side,
}: {
  label: string;
  children: React.ReactNode;
  side?: React.ComponentProps<typeof BaseTooltip.Positioner>["side"];
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children as React.ReactElement} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </BaseTooltip.Root>
  );
}
