import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useMailtoLinks } from "@/lib/use-mailto-links.ts";
import { AppShortcuts } from "./app-shortcuts.tsx";
import { ComposeDock } from "./compose-dock.tsx";
import { Sidebar } from "./sidebar.tsx";
import { TopBar } from "./top-bar.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useMailtoLinks();

  // Close the mobile drawer on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on every path change
  useEffect(() => setNavOpen(false), [location.pathname]); // react-doctor-disable-line no-mutable-in-deps

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <TopBar onMenuClick={() => setNavOpen((v) => !v)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar mobileOpen={navOpen} onClose={() => setNavOpen(false)} />
        <main className="min-w-0 flex-1 overflow-hidden bg-background">{children}</main>
      </div>
      <ComposeDock />
      <AppShortcuts />
    </div>
  );
}
