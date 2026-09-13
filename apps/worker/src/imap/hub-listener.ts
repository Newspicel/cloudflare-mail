// Subscribes an IMAP session to the user's UserHub SSE stream so IDLE (and the
// next NOOP) can surface changes made elsewhere — a delivery, the web app
// marking a thread read, another IMAP client moving mail. Events are latched:
// one that arrives while nobody is waiting still wakes the next `wait()`.
/* eslint-disable no-await-in-loop -- one SSE stream, read frame by frame */

import type { HubEvent } from "@cfmail/shared/events";
import type { Env } from "../env.ts";

export class HubListener {
  private dirty = false;
  private expired = false;
  private waiter: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;

  constructor(
    private readonly env: Env,
    private readonly userId: string,
    private readonly mailboxId: string,
  ) {}

  start(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      try {
        const stub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(this.userId));
        const res = await stub.fetch("https://hub/subscribe");
        if (!res.body) throw new Error("no hub body");
        this.reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep = buf.indexOf("\n\n");
          while (sep !== -1) {
            this.onFrame(buf.slice(0, sep));
            buf = buf.slice(sep + 2);
            sep = buf.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!this.closed) console.error("imap hub listener failed", err);
      }
      if (this.closed) return;
      // Reconnect after a short pause; the hub is best-effort (invariant 8).
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private onFrame(frame: string): void {
    const data = frame
      .split("\n")
      .find((l) => l.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!data) return;
    let evt: HubEvent;
    try {
      evt = JSON.parse(data) as HubEvent;
    } catch {
      return;
    }
    if (evt.type === "ping" || !("mailboxId" in evt) || evt.mailboxId !== this.mailboxId) return;
    if (evt.type === "mailbox_expired") this.expired = true;
    this.dirty = true;
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  // True once the mailbox itself went away (temp mailbox expiry).
  get mailboxGone(): boolean {
    return this.expired;
  }

  // Resolves when a relevant event has arrived since the last `take()`.
  wait(): Promise<void> {
    if (this.dirty) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  // Consume the latch; returns whether anything had arrived.
  take(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
    this.waiter = null;
    void this.reader?.cancel().catch(() => undefined);
  }
}
