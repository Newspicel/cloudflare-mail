import type { UserPrefs } from "@cfmail/shared";
import { toast } from "sonner";
import { Row, Section, Segmented } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useUserPrefs } from "@/lib/prefs.ts";

const MODE_OPTIONS = [
  ["text", "Plain"],
  ["markdown", "Markdown"],
  ["html", "Rich text"],
] as const;

// Ask the browser to route system `mailto:` links here. Chrome/Firefox answer
// with their own confirmation prompt; Safari has no API for it (the row hides).
// Links clicked *inside* cfmail never need this — they're intercepted in-app.
function registerMailtoHandler() {
  try {
    navigator.registerProtocolHandler("mailto", `${location.origin}/compose?mailto=%s`);
    toast.success("Confirm the prompt to send mailto: links to cfmail");
  } catch {
    toast.error("Your browser wouldn't register cfmail as the mail handler");
  }
}

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
        {"registerProtocolHandler" in navigator && (
          <Row
            label="Handle mailto: links"
            hint="Open mailto: links from other apps and sites in cfmail."
          >
            <Button variant="outline" size="sm" onClick={registerMailtoHandler}>
              Set as default
            </Button>
          </Row>
        )}
      </div>
    </Section>
  );
}
