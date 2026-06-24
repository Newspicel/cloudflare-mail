import { Progress as BaseProgress } from "@base-ui/react/progress";
import type * as React from "react";
import { cn } from "@/lib/cn";

export function Progress({
  className,
  ...props
}: React.ComponentProps<typeof BaseProgress.Root>) {
  return (
    <BaseProgress.Root className={cn("w-full", className)} {...props}>
      <BaseProgress.Track className="h-1.5 overflow-hidden rounded-full bg-muted">
        <BaseProgress.Indicator className="h-full rounded-full bg-primary transition-[width]" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
