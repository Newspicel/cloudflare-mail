import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn";

export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof BaseCheckbox.Root>) {
  return (
    <BaseCheckbox.Root
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-card shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
        {props.indeterminate ? <Minus className="size-3" /> : <Check className="size-3" />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
