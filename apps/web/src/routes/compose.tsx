import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComposeForm, type ComposeState } from "@/components/compose-dock.tsx";
import { parseMailto } from "@/lib/mailto.ts";
import { draftQuery, meQuery } from "@/lib/queries.ts";

interface ComposeSearch {
  // Rehydrate from a server-persisted draft (how the pop-out carries its state).
  draft?: string;
  // Or start a blank message pre-addressed to someone.
  to?: string;
  // A full `mailto:` URL — what the OS hands the installed PWA through the
  // manifest's protocol handler, and how the pop-out carries seeded fields.
  mailto?: string;
}

// Standalone, full-window composer — opened in a real OS window by the dock's
// "open in new window" button. Auth is the shared session cookie, so loading
// this URL directly just works (or bounces to /login).
export const Route = createFileRoute("/compose")({
  validateSearch: (search: Record<string, unknown>): ComposeSearch => ({
    draft: typeof search.draft === "string" ? search.draft : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
    mailto: typeof search.mailto === "string" ? search.mailto : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.user) throw redirect({ to: "/login" });
  },
  loaderDeps: ({ search }) => ({ draft: search.draft }),
  loader: ({ context, deps }) =>
    deps.draft ? context.queryClient.ensureQueryData(draftQuery(deps.draft)) : null,
  component: ComposeWindow,
});

function ComposeWindow() {
  const { draft: draftId, to, mailto } = Route.useSearch();
  const { data } = useQuery({ ...draftQuery(draftId ?? ""), enabled: Boolean(draftId) });

  useEffect(() => {
    document.title = "New message";
  }, []);

  const seed = mailto ? parseMailto(mailto) : null;
  const state: ComposeState = {
    open: true,
    replyToMessage: null,
    forwardMessage: null,
    draft: data?.draft ?? null,
    initialTo: seed?.to ?? (to ? [to] : undefined),
    initialCc: seed?.cc,
    initialBcc: seed?.bcc,
    initialSubject: seed?.subject,
    initialBody: seed?.body,
  };

  return <ComposeForm key={data?.draft?.id ?? "new"} variant="window" state={state} />;
}
