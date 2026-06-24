import { createFileRoute, Outlet } from "@tanstack/react-router";
import { folderThreadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/folder/$folderId")({
  loader: ({ params, context }) =>
    context.queryClient.ensureInfiniteQueryData(folderThreadsQuery(params.folderId)),
  component: FolderLayout,
});

function FolderLayout() {
  return <Outlet />;
}
