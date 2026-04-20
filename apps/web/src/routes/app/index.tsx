import { createFileRoute, Navigate } from "@tanstack/react-router";
import { mailboxesQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/")({
  component: AppIndex,
});

function AppIndex() {
  const { queryClient } = Route.useRouteContext();
  const mailboxes = queryClient.getQueryData(mailboxesQuery.queryKey);
  const first = mailboxes?.mailboxes[0];
  if (first) return <Navigate to="/app/m/$mailboxId" params={{ mailboxId: first.id }} />;
  return (
    <div className="flex h-full items-center justify-center p-12 text-center text-muted-foreground">
      <div className="max-w-md">
        <h2 className="mb-2 text-xl font-semibold text-foreground">No mailboxes yet</h2>
        <p className="text-sm">
          Create a domain and mailbox from the admin page to start sending and receiving.
        </p>
      </div>
    </div>
  );
}
