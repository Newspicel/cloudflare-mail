import type { DateFormat, UserPrefs } from "@cfmail/shared";
import { fieldClass, Row, Section, Segmented } from "@/components/settings-ui.tsx";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import { dateFormatExample, formatDateTime } from "@/lib/time.ts";

// Fixed instant for the settings preview so it's stable across renders.
const SAMPLE_DATE = new Date(2026, 5, 24, 14, 30);

// Explicit layouts, grouped numeric → named, each labelled by its own example.
const DATE_FORMAT_OPTIONS: DateFormat[] = [
  "dmy-dot",
  "dmy-dot-2",
  "dmy-slash",
  "dmy-slash-2",
  "mdy-slash",
  "mdy-slash-2",
  "iso",
  "d-mon-y",
  "d-month-y",
  "mon-d-y",
  "month-d-y",
];

const TIME_OPTIONS = [
  ["24h", "24-hour"],
  ["12h", "12-hour"],
] as const;

export function DateTimeSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();
  const fmt = useDateTimeFmt();

  return (
    <Section
      id="datetime"
      title="Date & time"
      description={`How dates and times are shown. Preview: ${formatDateTime(SAMPLE_DATE, fmt)}`}
    >
      <div className="divide-y">
        <Row label="Date format" hint="Order, separator, and how the month is written.">
          <select
            className={fieldClass}
            value={prefs.dateFormat ?? "dmy-dot"}
            disabled={saving}
            onChange={(e) => setPrefs({ dateFormat: e.target.value as DateFormat })}
          >
            {DATE_FORMAT_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {dateFormatExample(id)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Clock" hint="12- or 24-hour time.">
          <Segmented<NonNullable<UserPrefs["timeFormat"]>>
            value={prefs.timeFormat ?? "24h"}
            options={TIME_OPTIONS}
            onChange={(v) => setPrefs({ timeFormat: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}
