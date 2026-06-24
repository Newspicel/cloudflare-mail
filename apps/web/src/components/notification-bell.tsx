import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, Clock, X } from "lucide-react";
import { useState } from "react";
import {
  type Reminder,
  remindersQuery,
  useDeleteReminder,
  useUpdateReminder,
} from "@/lib/reminders.ts";
import { useNow } from "@/lib/time.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";
import { UnreadBadge } from "./ui.tsx";

// Relative label for a reminder time: "in 3h", "in 2d", or "5m ago" once due.
function relative(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  const unit =
    m < 60 ? `${m || 1}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const now = useNow(30_000);
  const { data } = useQuery(remindersQuery);
  const update = useUpdateReminder();
  const del = useDeleteReminder();

  const reminders = data?.reminders ?? [];
  const due = reminders.filter((r) => r.status === "fired");
  const upcoming = reminders.filter((r) => r.status === "pending");

  function openThread(r: Reminder) {
    setOpen(false);
    if (r.status === "fired") update.mutate({ id: r.id, status: "done" });
    nav({
      to: "/app/m/$mailboxId/t/$threadId",
      params: { mailboxId: r.mailboxId, threadId: r.threadId },
      search: { view: "inbox" },
    });
  }

  function row(r: Reminder, fired: boolean) {
    return (
      <li key={r.id} className="group flex items-center gap-1">
        <button
          type="button"
          onClick={() => openThread(r)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
        >
          <span className="truncate text-[13px]">{r.subject || "(no subject)"}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="size-3" />
            {relative(r.remindAt, now)}
            {r.kind === "follow_up" && <span>· no reply</span>}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 opacity-0 group-hover:opacity-100"
          aria-label={fired ? "Dismiss" : "Cancel reminder"}
          onClick={() => (fired ? update.mutate({ id: r.id, status: "done" }) : del.mutate(r.id))}
        >
          {fired ? <Check /> : <X />}
        </Button>
      </li>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label="Reminders">
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="relative shrink-0"
              aria-label="Reminders"
            >
              <Bell />
              {due.length > 0 && (
                <UnreadBadge count={due.length} className="-top-0.5 -right-0.5 absolute" />
              )}
            </Button>
          }
        />
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-2">
        {reminders.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">
            No reminders yet.
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            {due.length > 0 && (
              <>
                <div className="px-2 pb-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
                  Due
                </div>
                <ul className="mb-1">{due.map((r) => row(r, true))}</ul>
              </>
            )}
            {upcoming.length > 0 && (
              <>
                <div className="px-2 pb-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
                  Upcoming
                </div>
                <ul>{upcoming.map((r) => row(r, false))}</ul>
              </>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
