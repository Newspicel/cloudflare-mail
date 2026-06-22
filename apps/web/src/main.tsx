import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { Toaster } from "./components/ui/toaster.tsx";
import "./styles/globals.css";
import { initTheme } from "./lib/theme.ts";
import { routeTree } from "./routeTree.gen.ts";

initTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("no #root");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
