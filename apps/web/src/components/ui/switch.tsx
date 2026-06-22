import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type * as React from "react";
import { cn } from "@/lib/cn";

export function Switch({ className, ...props }: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-inner outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-[1.125rem]" />
    </BaseSwitch.Root>
  );
}
