import type { CalendarEventDto, UserPrefs } from "@cfmail/shared/responses";
import { CalendarClock, CalendarX2, MapPin, Repeat, Users, Video } from "lucide-react";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import { type DateTimeFmt, formatClock, formatDateTime } from "@/lib/time.ts";

// Render a calendar invite's start/end window. All-day events show the date(s)
// only; timed events show the day plus a start–end time range.
function formatEventWhen(event: CalendarEventDto, fmt: DateTimeFmt): string | null {
  if (!event.start) return null;
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return null;
  const end = event.end ? new Date(event.end) : null;
  const endValid = end && !Number.isNaN(end.getTime());

  const day = start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (event.allDay) return day;

  const from = formatClock(start, fmt);
  if (!endValid) return `${day} · ${from}`;
  const sameDay = start.toDateString() === end.toDateString();
  const to = sameDay ? formatClock(end, fmt) : formatDateTime(end, fmt);
  return `${day} · ${from} – ${to}`;
}

// Build a maps deep link for an address. "auto" picks Apple Maps on Apple
// devices (where it opens the native app) and Google Maps everywhere else.
function mapsUrl(address: string, provider: UserPrefs["mapProvider"]): string {
  const q = encodeURIComponent(address);
  const apple =
    provider === "apple" ||
    (provider !== "google" &&
      typeof navigator !== "undefined" &&
      /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent));
  return apple
    ? `https://maps.apple.com/?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// Banner for a message carrying an iCalendar invite (Invitation.ics / event.ics).
// Display-only: we surface the event details; we don't RSVP or manage a calendar.
export function CalendarBanner({ event }: { event: CalendarEventDto }) {
  const fmt = useDateTimeFmt();
  const { prefs } = useUserPrefs();
  const when = formatEventWhen(event, fmt);
  const cancelled = event.method === "CANCEL";
  const isReply = event.method === "REPLY";
  const label = cancelled
    ? "Event cancelled"
    : isReply
      ? "Invitation response"
      : "Calendar invitation";
  const attendees = event.attendees.filter((a) => a.email || a.name);

  return (
    <div
      className={cn(
        "border-b px-4 py-3 text-[12px]",
        cancelled
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/5 text-foreground dark:bg-primary/10",
      )}
    >
      <div className="flex items-start gap-2.5">
        {cancelled ? (
          <CalendarX2 className="mt-0.5 size-4 shrink-0" />
        ) : (
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground">
              {label}
            </span>
          </div>
          <div className={cn("font-semibold text-[14px]", cancelled && "line-through")}>
            {event.summary || "(no title)"}
          </div>
          {when && (
            <div className="text-muted-foreground">
              {when}
              {event.rrule && (
                <span className="ml-1.5 inline-flex items-center gap-1">
                  <Repeat className="size-3" /> Repeats
                </span>
              )}
            </div>
          )}
          {event.location && (
            <a
              href={mapsUrl(event.location, prefs.mapProvider)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              title={`Open in ${prefs.mapProvider === "apple" ? "Apple Maps" : prefs.mapProvider === "google" ? "Google Maps" : "Maps"}`}
            >
              <MapPin className="size-3.5 shrink-0" />
              <span className="truncate">{event.location}</span>
            </a>
          )}
          {event.organizer && (event.organizer.name || event.organizer.email) && (
            <div className="text-muted-foreground">
              <span className="text-muted-foreground/70">Organizer:</span>{" "}
              {event.organizer.name ?? event.organizer.email}
            </div>
          )}
          {attendees.length > 0 && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="size-3.5 shrink-0" />
              <span className="truncate">
                {attendees.length} {attendees.length === 1 ? "guest" : "guests"}
              </span>
            </div>
          )}
          {!cancelled && event.meetingUrl && (
            <a
              href={event.meetingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Video className="size-3.5 shrink-0" />
              Join meeting
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
