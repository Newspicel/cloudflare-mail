import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MailOpen } from "lucide-react";
import { FolderThreadList } from "@/components/folder-thread-list.tsx";
import { EmptyState } from "@/components/ui.tsx";
import { foldersQuery } from "@/lib/queries.ts";
import { useFolderFeed } from "@/lib/use-feeds.ts";

export const Route = createFileRoute("/app/folder/$folderId/")({
  component: FolderIndex,
});

function FolderIndex() {
  const { folderId } = Route.useParams();
  const feed = useFolderFeed(folderId);
  const folders = useQuery(foldersQuery);
  const folder = folders.data?.folders.find((f) => f.id === folderId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-full shrink-0 border-r md:w-[360px]">
          <FolderThreadList
            folder={folder}
            folderId={folderId}
            threads={feed.items}
            loading={feed.loading}
            hasMore={feed.hasMore}
            loadingMore={feed.loadingMore}
            loadMore={feed.loadMore}
          />
        </aside>
        <section className="hidden flex-1 items-center justify-center bg-background text-center text-[13px] text-muted-foreground md:flex">
          <EmptyState
            icon={MailOpen}
            title="No conversation selected"
            hint="Pick a thread from the list to read or reply."
          />
        </section>
      </div>
    </div>
  );
}
