import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CopyButton, GroupLabel, Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import { connectedAppsQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { formatDateTime } from "@/lib/time.ts";

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function ConnectedAppsSection() {
  const qc = useQueryClient();
  const fmt = useDateTimeFmt();
  const { confirmDelete } = useConfirmHelpers();
  const { data } = useQuery(connectedAppsQuery);
  const apps = data?.apps ?? [];

  const revoke = useMutation({
    mutationFn: (clientId: string) =>
      unwrap(rpc["connected-apps"].revoke.$post({ json: { clientId } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.connectedApps() });
      toast.success("Access revoked");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  async function onRevoke(clientId: string, name: string) {
    const ok = await confirmDelete(
      `access for "${name}"`,
      "It loses access to your mail on its next request and has to ask again.",
    );
    if (ok) revoke.mutate(clientId);
  }

  return (
    <Section
      id="apps"
      title="Connected apps"
      description="AI assistants and other MCP clients you've let read and send mail on your behalf. A connected app sees every mailbox you can, with the same permissions you have."
    >
      <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
        <GroupLabel className="mb-2">MCP server</GroupLabel>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono">{data?.mcpUrl ?? "…"}</code>
          {data?.mcpUrl && <CopyButton value={data.mcpUrl} label="Copy" />}
        </div>
        <div className="mt-2 text-muted-foreground">
          Add this URL to your client. It will open a sign-in page here and ask you to approve it.
        </div>
      </div>

      <div className="mt-4 border-t pt-4">
        <GroupLabel className="mb-1.5">Apps with access</GroupLabel>
        {apps.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">No apps connected.</div>
        ) : (
          <ul className="divide-y">
            {apps.map((a) => (
              <li key={a.clientId} className="flex items-center gap-3 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {hostOf(a.uri) ? `${hostOf(a.uri)} · ` : ""}
                    approved {formatDateTime(new Date(a.grantedAt), fmt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${a.name}`}
                  disabled={revoke.isPending}
                  onClick={() => onRevoke(a.clientId, a.name)}
                  className="hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
