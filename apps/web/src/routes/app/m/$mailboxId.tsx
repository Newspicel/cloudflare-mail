import { createFileRoute, Outlet } from "@tanstack/react-router";
import { draftsQuery, type MailView, parseMailView, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId")({
  validateSearch: (search: Record<string, unknown>): { view: MailView } => ({
    view: parseMailView(search.view),
  }),
  loaderDeps: ({ search: { view } }) => ({ view }),
  loader: ({ params, context, deps }) =>
    deps.view === "drafts"
      ? context.queryClient.ensureInfiniteQueryData(draftsQuery(params.mailboxId))
      : context.queryClient.ensureInfiniteQueryData(threadsQuery(params.mailboxId, deps.view)),
  component: MailboxLayout,
});

function MailboxLayout() {
  return <Outlet />;
}
