import type { ReactNode } from "react";
import { ComposeDock } from "./compose-dock.tsx";
import { Sidebar } from "./sidebar.tsx";
import { TopBar } from "./top-bar.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden bg-muted/20">{children}</main>
      </div>
      <ComposeDock />
    </div>
  );
}
