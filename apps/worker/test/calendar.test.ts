import { describe, expect, it } from "vitest";
import { parseICalendar } from "../src/mail/calendar.ts";

// CRLF line endings + folded lines, as real invites are emitted.
function ics(lines: string[]): string {
  return lines.join("\r\n");
}

describe("parseICalendar", () => {
  it("parses a REQUEST invite with organizer, attendees, and location", () => {
    const event = parseICalendar(
      ics([
        "BEGIN:VCALENDAR",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:abc-123",
        "SUMMARY:Quarterly planning",
        "DTSTART:20260624T130000Z",
        "DTEND:20260624T140000Z",
        "LOCATION:Room 4\\, Building A",
        "DESCRIPTION:Bring notes",
        "ORGANIZER;CN=Alice Boss:mailto:alice@example.com",
        "ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
        "ATTENDEE:mailto:carol@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
    );
    expect(event).not.toBeNull();
    expect(event?.method).toBe("REQUEST");
    expect(event?.summary).toBe("Quarterly planning");
    expect(event?.location).toBe("Room 4, Building A");
    expect(event?.start).toBe("2026-06-24T13:00:00Z");
    expect(event?.end).toBe("2026-06-24T14:00:00Z");
    expect(event?.allDay).toBe(false);
    expect(event?.organizer).toEqual({
      name: "Alice Boss",
      email: "alice@example.com",
      status: null,
    });
    expect(event?.attendees).toHaveLength(2);
    expect(event?.attendees[0]).toEqual({
      name: "Bob",
      email: "bob@example.com",
      status: "NEEDS-ACTION",
    });
  });

  it("treats VALUE=DATE as an all-day event", () => {
    const event = parseICalendar(
      ics([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Holiday",
        "DTSTART;VALUE=DATE:20261225",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
    );
    expect(event?.allDay).toBe(true);
    expect(event?.start).toBe("2026-12-25");
  });

  it("unfolds continuation lines and decodes escaped text", () => {
    const event = parseICalendar(
      ics([
        "BEGIN:VEVENT",
        "SUMMARY:A very long title that the",
        "  client folded across lines",
        "DESCRIPTION:line one\\nline two",
        "DTSTART:20260101T090000Z",
        "END:VEVENT",
      ]),
    );
    expect(event?.summary).toBe("A very long title that the client folded across lines");
    expect(event?.description).toBe("line one\nline two");
  });

  it("captures METHOD:CANCEL and RRULE", () => {
    const event = parseICalendar(
      ics([
        "BEGIN:VCALENDAR",
        "METHOD:CANCEL",
        "BEGIN:VEVENT",
        "SUMMARY:Standup",
        "DTSTART:20260101T090000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
    );
    expect(event?.method).toBe("CANCEL");
    expect(event?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("returns null when there is no VEVENT", () => {
    expect(parseICalendar("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeNull();
    expect(parseICalendar("not a calendar")).toBeNull();
  });
});
