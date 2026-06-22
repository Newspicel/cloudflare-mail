import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn.ts";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

const ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];
const CARD_KEYS = ["c1", "c2"];

export function ThreadListSkeleton() {
  return (
    <ul className="divide-y">
      {ROW_KEYS.map((k) => (
        <li key={k} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-10" />
          </div>
          <Skeleton className="h-2.5 w-48" />
        </li>
      ))}
    </ul>
  );
}

export function MessageSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {CARD_KEYS.map((k) => (
        <div key={k} className="rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-16" />
          </div>
          <Skeleton className="mb-2 h-2.5 w-full" />
          <Skeleton className="mb-2 h-2.5 w-5/6" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
