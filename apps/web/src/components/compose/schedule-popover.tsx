import { ChevronDown, Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Calendar } from "@/components/ui/calendar.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Separator } from "@/components/ui/separator.tsx";

// ── Scheduled-send time helpers ──────────────────────────────────────────────
// Stamp a "HH:mm" wall-clock time onto a calendar day, in the user's local zone.
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

// The next occurrence of `weekday` (0=Sun..6=Sat) at `hour`, always in the
// future — today counts only if `hour` hasn't passed yet.
function nextWeekday(weekday: number, hour: number): Date {
  const now = new Date();
  let delta = (weekday - now.getDay() + 7) % 7;
  if (delta === 0 && atHour(now, hour).getTime() <= now.getTime()) delta = 7;
  const d = new Date(now);
  d.setDate(d.getDate() + delta);
  return atHour(d, hour);
}

function schedulePresets(): { label: string; when: Date }[] {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    { label: "In 1 hour", when: new Date(now.getTime() + 60 * 60 * 1000) },
    { label: "In 3 hours", when: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    { label: "Tomorrow morning", when: atHour(tomorrow, 8) },
    { label: "Monday morning", when: nextWeekday(1, 8) },
  ];
}

function formatWhen(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  pending: boolean;
  onSchedule: (when: Date) => void;
}

// The "schedule send" split-button dropdown: presets plus a custom date + time.
export function SchedulePopover({ open, onOpenChange, disabled, pending, onSchedule }: Props) {
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [customTime, setCustomTime] = useState("09:00");
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="primary"
            size="icon"
            aria-label="Schedule send"
            disabled={disabled}
            className="w-7 border-primary-foreground/20 border-l"
          >
            <ChevronDown />
          </Button>
        }
      />
      <PopoverContent side="top" align="start" className="w-64 p-1.5">
        <div className="px-1.5 py-1 font-medium text-[11px] text-muted-foreground">
          Schedule send
        </div>
        {schedulePresets().map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onSchedule(p.when)}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
          >
            <span>{p.label}</span>
            <span className="text-[11px] text-muted-foreground">{formatWhen(p.when)}</span>
          </button>
        ))}
        <Separator className="my-1.5" />
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
          <InputGroup className="mt-1.5">
            <InputGroupAddon>
              <Clock />
            </InputGroupAddon>
            <InputGroupInput
              type="time"
              aria-label="Time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
            />
          </InputGroup>
          <Button
            variant="primary"
            size="sm"
            className="mt-2 w-full"
            disabled={!customDate || pending}
            onClick={() => customDate && onSchedule(combineDateTime(customDate, customTime))}
          >
            Schedule
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
