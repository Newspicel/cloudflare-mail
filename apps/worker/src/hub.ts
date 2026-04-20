import { DurableObject } from "cloudflare:workers";
import type { HubEvent } from "@cfmail/shared/events";
import type { Env } from "./env.ts";

const PING_INTERVAL_MS = 25_000;

export class UserHub extends DurableObject<Env> {
  private subscribers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      return this.subscribe();
    }
    if (url.pathname === "/broadcast" && req.method === "POST") {
      const evt = (await req.json()) as HubEvent;
      this.broadcast(evt);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  private subscribe(): Response {
    const id = crypto.randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.subscribers.set(id, controller);
        controller.enqueue(encoder.encode(`: connected\n\n`));
        this.ensurePingTimer();
      },
      cancel: () => {
        this.subscribers.delete(id);
        this.maybeStopPingTimer();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  broadcast(evt: HubEvent): void {
    const encoder = new TextEncoder();
    const payload = encoder.encode(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    for (const [id, ctrl] of this.subscribers) {
      try {
        ctrl.enqueue(payload);
      } catch {
        this.subscribers.delete(id);
      }
    }
    this.maybeStopPingTimer();
  }

  private ensurePingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.broadcast({ type: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private maybeStopPingTimer(): void {
    if (this.subscribers.size === 0 && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export async function broadcastToUsers(env: Env, userIds: string[], evt: HubEvent): Promise<void> {
  await Promise.all(
    userIds.map((uid) => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(uid));
      return stub.fetch("https://hub/broadcast", {
        method: "POST",
        body: JSON.stringify(evt),
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
