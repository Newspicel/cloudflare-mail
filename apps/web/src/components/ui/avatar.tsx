import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import type * as React from "react";
import { cn } from "@/lib/cn";

export function Avatar({ className, ...props }: React.ComponentProps<typeof BaseAvatar.Root>) {
  return (
    <BaseAvatar.Root
      className={cn(
        "relative flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarImage({ className, ...props }: React.ComponentProps<typeof BaseAvatar.Image>) {
  return <BaseAvatar.Image className={cn("size-full object-cover", className)} {...props} />;
}

export function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof BaseAvatar.Fallback>) {
  return <BaseAvatar.Fallback className={cn("uppercase", className)} {...props} />;
}
