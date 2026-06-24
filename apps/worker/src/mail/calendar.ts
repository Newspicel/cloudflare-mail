import type { CalendarEventDto } from "@cfmail/shared/responses";
import type { ParsedEmail } from "./mime.ts";

// Surface a calendar invite (RFC 5545 iCalendar) from a received message so the
// UI can show an event banner. We parse the first VEVENT we find in any
// text/calendar part or *.ics attachment — enough for the common
// REQUEST/REPLY/CANCEL flows mail clients emit. This is display-only; we never
// mutate a calendar or reject mail on a parse failure.

const decoder = new TextDecoder();

export function extractCalendar(parsed: ParsedEmail): CalendarEventDto | null {
  for (const att of parsed.attachments ?? []) {
    const mime = (att.mimeType ?? "").toLowerCase();
    const name = (att.filename ?? "").toLowerCase();
    if (!mime.includes("calendar") && !name.endsWith(".ics")) continue;
    const text = toText(att.content);
    const event = text ? parseICalendar(text) : null;
    if (event) return event;
  }
  return null;
}

function toText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (content instanceof ArrayBuffer) return decoder.decode(content);
  if (ArrayBuffer.isView(content)) return decoder.decode(content as ArrayBufferView);
  return null;
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

// Unfold (RFC 5545 §3.1: continuation lines begin with a space or tab) then split
// each logical line into NAME;PARAM=v:VALUE. The first unescaped colon ends the
// name/params — values like ORGANIZER's `mailto:` keep their own colons.
function parseLines(ics: string): Line[] {
  const unfolded: string[] = [];
  for (const raw of ics.split(/\r\n|\r|\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += raw.slice(1);
    } else {
      unfolded.push(raw);
    }
  }

  const lines: Line[] = [];
  for (const logical of unfolded) {
    const colon = logical.indexOf(":");
    if (colon === -1) continue;
    const head = logical.slice(0, colon);
    const value = logical.slice(colon + 1);
    const [name = "", ...paramParts] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq === -1) continue;
      params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    lines.push({ name: name.toUpperCase(), params, value });
  }
  return lines;
}

// Unescape RFC 5545 TEXT values: \n / \N → newline, and \\ \, \; are literal.
function unescapeText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, ch) => (ch === "n" || ch === "N" ? "\n" : ch));
}

// iCalendar date-time → a string `new Date()` can parse. UTC keeps its `Z`,
// floating/zoned times stay local (we can't resolve TZID without a tz database),
// and a bare date (VALUE=DATE) becomes YYYY-MM-DD and flags the event all-day.
function parseDate(
  value: string,
  params: Record<string, string>,
): { iso: string; allDay: boolean } | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (params.VALUE === "DATE" || h === undefined) {
    return { iso: `${y}-${mo}-${d}`, allDay: true };
  }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}${z ?? ""}`, allDay: false };
}

// Hosts whose URLs we surface as a "Join meeting" action. Clients stash the
// join link in different places — Google in X-GOOGLE-CONFERENCE, others in
// LOCATION or DESCRIPTION — so we scan all of them for a known provider.
const MEETING_HOSTS = [
  /\bzoom\.us\b/i,
  /\bzoomgov\.com\b/i,
  /\bmeet\.google\.com\b/i,
  /\bteams\.microsoft\.com\b/i,
  /\bteams\.live\.com\b/i,
  /\bmeet\.jit\.si\b/i,
  /\bwebex\.com\b/i,
  /\bwhereby\.com\b/i,
  /\bgotomeeting\.com\b/i,
  /\bgotomeet\.me\b/i,
  /\bbluejeans\.com\b/i,
  /\bchime\.aws\b/i,
];

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

function findMeetingUrl(...texts: (string | null)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const raw of text.match(URL_RE) ?? []) {
      const url = raw.replace(/[)\].,;]+$/, "");
      if (MEETING_HOSTS.some((re) => re.test(url))) return url;
    }
  }
  return null;
}

function parsePerson(line: Line): {
  name: string | null;
  email: string | null;
  status: string | null;
} {
  const email = line.value.replace(/^mailto:/i, "").trim() || null;
  return {
    name: line.params.CN ?? null,
    email,
    status: line.params.PARTSTAT ?? null,
  };
}

export function parseICalendar(ics: string): CalendarEventDto | null {
  const lines = parseLines(ics);
  let method: string | null = null;
  let inEvent = false;
  let sawEvent = false;
  const event: CalendarEventDto = {
    method: null,
    summary: null,
    description: null,
    location: null,
    start: null,
    end: null,
    allDay: false,
    organizer: null,
    attendees: [],
    rrule: null,
    meetingUrl: null,
  };
  let conference: string | null = null;

  for (const line of lines) {
    if (line.name === "METHOD") {
      method = line.value.trim().toUpperCase();
      continue;
    }
    if (line.name === "BEGIN" && line.value === "VEVENT") {
      inEvent = true;
      sawEvent = true;
      continue;
    }
    if (line.name === "END" && line.value === "VEVENT") break;
    if (!inEvent) continue;

    switch (line.name) {
      case "SUMMARY":
        event.summary = unescapeText(line.value);
        break;
      case "DESCRIPTION":
        event.description = unescapeText(line.value);
        break;
      case "LOCATION":
        event.location = unescapeText(line.value);
        break;
      case "DTSTART": {
        const d = parseDate(line.value, line.params);
        if (d) {
          event.start = d.iso;
          event.allDay = d.allDay;
        }
        break;
      }
      case "DTEND": {
        const d = parseDate(line.value, line.params);
        if (d) event.end = d.iso;
        break;
      }
      case "ORGANIZER":
        event.organizer = parsePerson(line);
        break;
      case "ATTENDEE":
        event.attendees.push(parsePerson(line));
        break;
      case "RRULE":
        event.rrule = line.value;
        break;
      case "X-GOOGLE-CONFERENCE":
        conference = line.value.trim();
        break;
    }
  }

  if (!sawEvent || (!event.start && !event.summary)) return null;
  event.method = method;
  event.meetingUrl = findMeetingUrl(conference, event.location, event.description);
  return event;
}
