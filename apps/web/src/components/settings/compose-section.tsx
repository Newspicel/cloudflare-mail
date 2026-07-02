import type { UserPrefs } from "@cfmail/shared";
import { Row, Section, Segmented } from "@/components/settings-ui.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useUserPrefs } from "@/lib/prefs.ts";

const MODE_OPTIONS = [
  ["text", "Plain"],
  ["markdown", "Markdown"],
  ["html", "Rich text"],
] as const;

export function ComposeSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section id="compose" title="Compose" description="Defaults when writing a new message.">
      <div className="divide-y">
        <Row label="Open in a new window" hint="Pop new messages out instead of the in-app dock.">
          <Switch
            checked={!!prefs.composeInNewWindow}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ composeInNewWindow: checked })}
          />
        </Row>
        <Row label="Default editor" hint="Starting format for a new message.">
          <Segmented<NonNullable<UserPrefs["composeDefaultMode"]>>
            value={prefs.composeDefaultMode ?? "text"}
            options={MODE_OPTIONS}
            onChange={(v) => setPrefs({ composeDefaultMode: v })}
            disabled={saving}
          />
        </Row>
        <Row label="Send with ⌘/Ctrl + Enter" hint="Keyboard shortcut to send the open message.">
          <Switch
            checked={!!prefs.sendShortcut}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ sendShortcut: checked })}
          />
        </Row>
        <Row label="Reply all by default" hint="Reply includes everyone on the thread.">
          <Switch
            checked={!!prefs.replyAllDefault}
            disabled={saving}
            onCheckedChange={(checked) => setPrefs({ replyAllDefault: checked })}
          />
        </Row>
      </div>
    </Section>
  );
}
