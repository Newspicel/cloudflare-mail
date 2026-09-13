import { createFileRoute, Outlet } from "@tanstack/react-router";
import { draftsQuery, parseMailListSearch, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId")({
  validateSearch: parseMailListSearch,
  loaderDeps: ({ search: { view, unread } }) => ({ view, unread }),
  loader: ({ params, context, deps }) =>
    deps.view === "drafts"
      ? context.queryClient.ensureInfiniteQueryData(draftsQuery(params.mailboxId))
      : context.queryClient.ensureInfiniteQueryData(
          threadsQuery(params.mailboxId, deps.view, deps.unread),
        ),
  component: MailboxLayout,
});

function MailboxLayout() {
  return <Outlet />;
}
