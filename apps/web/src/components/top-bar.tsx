import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Search, Settings } from "lucide-react";
import { authClient } from "@/lib/auth-client.ts";
import { meQuery } from "@/lib/queries.ts";

export function TopBar() {
  const { data } = useQuery(meQuery);
  const nav = useNavigate();
  const initial =
    data?.user?.name?.[0]?.toUpperCase() ?? data?.user?.email?.[0]?.toUpperCase() ?? "?";

  async function signOut() {
    await authClient.signOut();
    nav({ to: "/login" });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold">
          ✉
        </div>
        <span className="text-[15px] font-semibold tracking-tight">cfmail</span>
      </div>

      <div className="mx-auto w-full max-w-2xl">
        <label className="flex items-center gap-2 rounded-full border bg-muted/60 px-4 py-2 text-sm text-muted-foreground focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/30">
          <Search className="h-4 w-4" />
          <input
            placeholder="Search mail"
            className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <button
        type="button"
        className="rounded-full p-2 text-muted-foreground hover:bg-muted"
        onClick={() => nav({ to: "/app/settings" })}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="rounded-full p-2 text-muted-foreground hover:bg-muted"
        onClick={signOut}
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
      <div
        className="grid h-8 w-8 place-items-center rounded-full bg-accent text-sm font-medium text-accent-foreground"
        title={data?.user?.email}
      >
        {initial}
      </div>
    </header>
  );
}
