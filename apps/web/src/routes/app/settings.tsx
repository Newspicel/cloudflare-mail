import { has, Perm } from "@cfmail/shared/permissions";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MailboxImportSection, MailboxSettingsForm } from "@/components/mailbox-settings-form.tsx";
import { RulesSection } from "@/components/rules-settings.tsx";
import { AppearanceSection } from "@/components/settings/appearance-section.tsx";
import { ComposeSection } from "@/components/settings/compose-section.tsx";
import { DateTimeSection } from "@/components/settings/datetime-section.tsx";
import { FoldersSection } from "@/components/settings/folders-section.tsx";
import { NotificationsSection } from "@/components/settings/notifications-section.tsx";
import { ProfileSection } from "@/components/settings/profile-section.tsx";
import { ReadingSection } from "@/components/settings/reading-section.tsx";
import { SecuritySection } from "@/components/settings/security-section.tsx";
import { TemplatesSection } from "@/components/settings/templates-section.tsx";
import { TwoFactorSection } from "@/components/settings/two-factor-section.tsx";
import { mailboxesQuery, meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/settings")({
  component: SettingsPage,
});

const NAV = [
  ["profile", "Profile"],
  ["appearance", "Appearance"],
  ["reading", "Reading"],
  ["datetime", "Date & time"],
  ["compose", "Compose"],
  ["templates", "Templates"],
  ["security", "Security"],
  ["notifications", "Notifications"],
  ["folders", "Folders"],
  ["rules", "Rules"],
  ["mailboxes", "Mailboxes"],
] as const;

function SettingsPage() {
  const { data: meData } = useQuery(meQuery);
  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const editable = (mailboxesData?.mailboxes ?? []).filter(
    (m) => m.type !== "temp" && has(m.perms, Perm.MANAGE),
  );
  // Service mailboxes can't be imported into (no owner-facing inbox).
  const importable = editable.filter((m) => m.type !== "service");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl gap-8 px-4 py-6 sm:px-8 sm:py-8">
        <nav className="sticky top-8 hidden h-max w-36 shrink-0 flex-col gap-0.5 text-[13px] lg:flex">
          {NAV.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          <header>
            <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Profile, appearance, security, and per-mailbox preferences.
            </p>
          </header>

          <ProfileSection
            key={`${meData?.user?.name ?? ""}|${meData?.user?.image ?? ""}`}
            name={meData?.user?.name ?? ""}
            email={meData?.user?.email ?? ""}
            image={meData?.user?.image ?? ""}
            role={meData?.user?.role}
          />
          <AppearanceSection />
          <ReadingSection />
          <DateTimeSection />
          <ComposeSection />
          <TemplatesSection />
          <SecuritySection />
          <TwoFactorSection enabled={!!meData?.user?.twoFactorEnabled} />
          <NotificationsSection mailboxes={mailboxesData?.mailboxes ?? []} />
          <FoldersSection />
          <RulesSection mailboxes={editable} />

          <div id="mailboxes" className="scroll-mt-8 space-y-4">
            <div className="px-0.5">
              <h2 className="text-[14px] font-semibold tracking-tight">Mailboxes</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Identity, spam filtering, and encryption for each mailbox you manage.
              </p>
            </div>
            {editable.length === 0 ? (
              <div className="rounded-lg border bg-card px-5 py-8 text-center text-[13px] text-muted-foreground shadow-sm">
                No editable mailboxes yet.
              </div>
            ) : (
              <div className="space-y-4">
                {editable.map((m) => (
                  <MailboxSettingsForm
                    key={m.id}
                    mailboxId={m.id}
                    address={m.address}
                    type={m.type}
                  />
                ))}
              </div>
            )}
            {importable.length > 0 && <MailboxImportSection mailboxes={importable} />}
          </div>
        </div>
      </div>
    </div>
  );
}
