import { Clock } from "lucide-react";
import { useState } from "react";
import { useCreateReminder } from "@/lib/reminders.ts";
import { Button } from "./ui/button.tsx";
import { Calendar } from "./ui/calendar.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

function combineDateTime(day: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const out = new Date(day);
  out.setHours(h ?? 0, m ?? 0, 0, 0);
  return out;
}

function atHour(d: Date, hour: number): Date {
  const out = new Date(d);
  out.setHours(hour, 0, 0, 0);
  return out;
}

export function remindPresets(): { label: string; when: Date }[] {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  return [
    { label: "In 3 hours", when: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    { label: "This evening", when: atHour(now, 18) },
    { label: "Tomorrow morning", when: atHour(tomorrow, 8) },
    { label: "Next week", when: atHour(nextWeek, 8) },
  ].filter((p) => p.when.getTime() > now.getTime());
}

export function formatWhen(d: Date): string {
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

interface Props {
  threadId: string;
  mailboxId: string;
  messageId?: string;
}

// Bell/clock action that opens a popover to set a reminder on a thread: quick
// presets plus a custom date+time, mirroring the compose-dock scheduler.
export function ReminderMenu({ threadId, mailboxId, messageId }: Props) {
  const [open, setOpen] = useState(false);
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [customTime, setCustomTime] = useState("09:00");
  const create = useCreateReminder();

  function setAt(when: Date) {
    create.mutate(
      { threadId, mailboxId, messageId, remindAt: when.getTime() },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label="Remind me">
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="Remind me">
              <Clock />
            </Button>
          }
        />
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="px-1.5 py-1 font-medium text-[11px] text-muted-foreground">Remind me</div>
        {remindPresets().map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setAt(p.when)}
            disabled={create.isPending}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent disabled:opacity-50"
          >
            <span>{p.label}</span>
            <span className="text-[11px] text-muted-foreground">{formatWhen(p.when)}</span>
          </button>
        ))}
        <div className="my-1 h-px bg-border" />
        <div className="px-0.5 pt-0.5 pb-1">
          <span className="mb-1 block px-1 text-[11px] text-muted-foreground">
            Custom date &amp; time
          </span>
          <Calendar
            mode="single"
            selected={customDate}
            onSelect={setCustomDate}
            disabled={{ before: new Date() }}
            className="p-0"
          />
          <div className="mt-1 flex items-center gap-2 px-1">
            <Clock className="size-3.5 text-muted-foreground" />
            <input
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              className="flex-1 rounded-md border bg-card px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            className="mt-2 w-full"
            disabled={!customDate || create.isPending}
            onClick={() => customDate && setAt(combineDateTime(customDate, customTime))}
          >
            Set reminder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
