import type { MailView, UserPrefs } from "@cfmail/shared";
import { Row, Section, Segmented } from "@/components/settings-ui.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useUserPrefs } from "@/lib/prefs.ts";

const VIEW_OPTIONS = [
  ["inbox", "Inbox"],
  ["all", "All mail"],
  ["marked", "Marked"],
] as const;

const MAP_OPTIONS = [
  ["auto", "Auto"],
  ["google", "Google"],
  ["apple", "Apple"],
] as const;

export function ReadingSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section id="reading" title="Reading" description="How mail opens and is marked.">
      <div className="divide-y">
        <Row label="Default view" hint="Which view opens when you pick a mailbox.">
          <Segmented<MailView>
            value={(prefs.defaultView as MailView) ?? "inbox"}
            options={VIEW_OPTIONS}
            onChange={(v) => setPrefs({ defaultView: v })}
            disabled={saving}
          />
        </Row>
        <Row
          label="Mark read when opened"
          hint="Turn off to keep threads unread until you mark them."
        >
          <Switch
            checked={prefs.autoMarkRead !== false}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ autoMarkRead: checked })}
          />
        </Row>
        <Row
          label="AI summaries in list"
          hint="Show the one-line AI summary under each conversation (where the mailbox has AI enabled)."
        >
          <Switch
            checked={prefs.aiSummaries !== false}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ aiSummaries: checked })}
          />
        </Row>
        <Row label="Open addresses in" hint="Which maps service event locations open in.">
          <Segmented<NonNullable<UserPrefs["mapProvider"]>>
            value={prefs.mapProvider ?? "auto"}
            options={MAP_OPTIONS}
            onChange={(v) => setPrefs({ mapProvider: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}
