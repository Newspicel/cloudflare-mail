import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell.tsx";
import { mailboxesQuery, meQuery } from "@/lib/queries.ts";
import { connectStream } from "@/lib/sse.ts";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.user) throw redirect({ to: "/login" });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(mailboxesQuery),
  component: AppLayout,
});

function AppLayout() {
  const qc = useQueryClient();
  useEffect(() => connectStream(qc), [qc]);
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
