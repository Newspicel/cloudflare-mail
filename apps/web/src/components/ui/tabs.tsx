import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Tabs = BaseTabs.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn(
        "relative inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "z-1 flex h-7 select-none items-center justify-center gap-1.5 rounded-md px-3 font-medium text-[13px] outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 data-selected:text-foreground [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsIndicator({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.Indicator>) {
  return (
    <BaseTabs.Indicator
      className={cn(
        "absolute top-0.5 left-0 h-[calc(100%-0.25rem)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] rounded-md bg-card shadow-black/5 shadow-sm transition-[translate,width] duration-200",
        className,
      )}
      {...props}
    />
  );
}
