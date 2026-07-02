import { Row, Section, Segmented } from "@/components/settings-ui.tsx";
import { useUserPrefs } from "@/lib/prefs.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";

const THEME_OPTIONS = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
] as const;

const DENSITY_OPTIONS = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
] as const;

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { prefs, setPrefs, saving } = useUserPrefs();

  return (
    <Section
      id="appearance"
      title="Appearance"
      description="Theme is saved on this device; density syncs to your account."
    >
      <div className="divide-y">
        <Row label="Theme" hint="System follows your OS setting.">
          <Segmented<Theme> value={theme} options={THEME_OPTIONS} onChange={(v) => setTheme(v)} />
        </Row>
        <Row label="List density" hint="How tightly conversations are packed.">
          <Segmented
            value={prefs.density ?? "comfortable"}
            options={DENSITY_OPTIONS}
            onChange={(v) => setPrefs({ density: v })}
            disabled={saving}
          />
        </Row>
      </div>
    </Section>
  );
}
