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
    <div className="flex h-full items-center justify-center p-12 text-center">
      <div className="max-w-md rounded-md border bg-card px-8 py-10">
        <h2 className="mb-1.5 text-[16px] font-semibold tracking-tight text-foreground">
          No mailboxes yet
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Create a domain and mailbox from the admin page to start sending and receiving.
        </p>
      </div>
    </div>
  );
}
