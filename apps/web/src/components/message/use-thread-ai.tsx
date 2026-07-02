import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, MessageSquareReply, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { openCompose } from "@/components/compose-dock.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import type { MessageRow, ThreadRow } from "@/lib/queries.ts";
import { mailboxesQuery } from "@/lib/queries.ts";

// AI helpers for an open thread: a one-tap thread summary and smart-reply
// suggestions for the latest inbound message. The triggers live in the thread
// top bar (always visible) while results render just below it. Mutations reset
// on thread change since MessageView stays mounted across threads. Both calls
// are best-effort and degrade to a toast.
export type ThreadAi = ReturnType<typeof useThreadAi>;

export function useThreadAi(thread: ThreadRow, messages: MessageRow[]) {
  const { data: mbData } = useQuery(mailboxesQuery);
  const aiOn = mbData?.mailboxes.find((m) => m.id === thread.mailboxId)?.aiFeatures ?? false;
  const lastInbound = [...messages].toReversed().find((m) => m.direction === "in");

  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- AI summary is a read-only POST; its result is consumed via mutation state, not cached data
  const summarize = useMutation({
    mutationFn: () => unwrap(rpc.threads[":id"].summary.$post({ param: { id: thread.id } })),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't summarize"),
  });
  // eslint-disable-next-line react-doctor/query-mutation-missing-invalidation -- AI smart-reply is a read-only POST; its result is consumed via mutation state, not cached data
  const smartReply = useMutation({
    mutationFn: () =>
      unwrap(rpc.messages[":id"]["smart-reply"].$post({ param: { id: lastInbound!.id } })),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't draft replies"),
  });

  const reset = summarize.reset;
  const resetReply = smartReply.reset;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on thread switch
  useEffect(() => {
    // eslint-disable-next-line react-doctor/no-pass-data-to-parent -- clears local mutation state on thread switch (view stays mounted across threads); no data flows to a parent
    reset();
    // eslint-disable-next-line react-doctor/no-pass-data-to-parent -- clears local mutation state on thread switch (view stays mounted across threads); no data flows to a parent
    resetReply();
  }, [thread.id, reset, resetReply]);

  return { aiOn, lastInbound, summarize, smartReply };
}

export function ThreadAiActions({ ai }: { ai: ThreadAi }) {
  const { lastInbound, summarize, smartReply } = ai;
  return (
    <>
      <IconButton
        icon={summarize.isPending ? Loader2 : Sparkles}
        onClick={() => summarize.mutate()}
        disabled={summarize.isPending}
        label={summarize.isPending ? "Summarizing…" : "Summarize thread"}
        className={summarize.isPending ? "[&_svg]:animate-spin" : undefined}
      />
      {lastInbound && (
        <IconButton
          icon={smartReply.isPending ? Loader2 : MessageSquareReply}
          onClick={() => smartReply.mutate()}
          disabled={smartReply.isPending}
          label={smartReply.isPending ? "Drafting…" : "Suggest replies"}
          className={smartReply.isPending ? "[&_svg]:animate-spin" : undefined}
        />
      )}
    </>
  );
}

export function ThreadAiResults({ ai }: { ai: ThreadAi }) {
  const { lastInbound, summarize, smartReply } = ai;
  if (!summarize.isSuccess && !smartReply.isSuccess) return null;

  const bullets = summarize.data?.bullets ?? [];
  const suggestions = smartReply.data?.suggestions ?? [];

  return (
    <div className="shrink-0 space-y-2 border-b bg-muted/30 px-3 py-2.5 text-[13px] sm:px-4">
      {summarize.isSuccess && (
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {bullets.length ? (
              bullets.map((b) => <li key={b}>{b}</li>)
            ) : (
              <li className="list-none">No summary available.</li>
            )}
          </ul>
        </div>
      )}
      {smartReply.isSuccess && lastInbound && (
        <div className="flex flex-col gap-1.5">
          {suggestions.length ? (
            suggestions.map((sug) => (
              <button
                key={sug}
                type="button"
                className="rounded-md border bg-card px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => openCompose({ replyToMessage: lastInbound, initialBody: sug })}
              >
                {sug}
              </button>
            ))
          ) : (
            <span className="text-muted-foreground">No suggestions available.</span>
          )}
        </div>
      )}
    </div>
  );
}
