import { createFileRoute, Outlet } from "@tanstack/react-router";
import { threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId")({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(threadsQuery(params.mailboxId)),
  component: MailboxLayout,
});

function MailboxLayout() {
  return <Outlet />;
}
