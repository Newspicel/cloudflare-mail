import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    throw redirect({ to: me.user ? "/app" : "/login" });
  },
});
