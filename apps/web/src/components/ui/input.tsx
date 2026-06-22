import type * as React from "react";
import { cn } from "@/lib/cn";

export const inputClass =
  "flex h-8 w-full rounded-md border bg-card px-2.5 text-[13px] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50";

export function Input({
  className,
  type,
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input ref={ref} type={type ?? "text"} className={cn(inputClass, className)} {...props} />;
}
