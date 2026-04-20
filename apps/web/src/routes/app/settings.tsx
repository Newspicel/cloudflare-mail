import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const me = useQuery(meQuery);
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <section className="rounded-xl border bg-card p-6">
        <h2 className="mb-2 text-lg font-medium">Profile</h2>
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{me.data?.user?.name}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{me.data?.user?.email}</dd>
        </dl>
      </section>
    </div>
  );
}
