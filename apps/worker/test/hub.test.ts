import { afterEach, describe, expect, it } from "vitest";
import { broadcastToUsers } from "../src/hub.ts";
import { e } from "./support/app.ts";

// Read an SSE stream until `needle` appears (or time out), returning everything
// accumulated so far — lets tests assert both presence and absence of events.
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (!acc.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const result = await Promise.race([reader.read(), timed]);
    if (result === null) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    if (result.done) throw new Error(`stream ended before ${needle}; got: ${acc}`);
    acc += decoder.decode(result.value, { stream: true });
  }
  return acc;
}

async function subscribe(userId: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const stub = e.USER_HUB.get(e.USER_HUB.idFromName(userId));
  const res = await stub.fetch("https://hub/subscribe");
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  if (!res.body) throw new Error("subscribe returned no body");
  return res.body.getReader();
}

describe("UserHub fan-out", () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const track = (r: ReadableStreamDefaultReader<Uint8Array>) => {
    readers.push(r);
    return r;
  };

  afterEach(async () => {
    const toClose = readers.splice(0, readers.length);
    await Promise.all(toClose.map((r) => r.cancel().catch(() => undefined)));
  });

  it("delivers a broadcast to every stream of the targeted user", async () => {
    const a1 = track(await subscribe("hub-user-a"));
    const a2 = track(await subscribe("hub-user-a"));

    await broadcastToUsers(e, ["hub-user-a"], { type: "mailbox_expired", mailboxId: "mb-a" });

    for (const reader of [a1, a2]) {
      // eslint-disable-next-line no-await-in-loop -- assertions are sequential by design
      const got = await readUntil(reader, "event: mailbox_expired");
      expect(got).toContain(`"mailboxId":"mb-a"`);
    }
  });

  it("does not leak events across users", async () => {
    const a = track(await subscribe("hub-user-a"));
    const b = track(await subscribe("hub-user-b"));

    // Send A's event first, then B's. B's stream is ordered, so once B's own
    // event arrives, A's (sent earlier) would already have shown up if it were
    // ever going to.
    await broadcastToUsers(e, ["hub-user-a"], { type: "mailbox_expired", mailboxId: "mb-a" });
    await broadcastToUsers(e, ["hub-user-b"], { type: "mailbox_expired", mailboxId: "mb-b" });

    const gotB = await readUntil(b, `"mailboxId":"mb-b"`);
    expect(gotB).not.toContain(`"mailboxId":"mb-a"`);

    const gotA = await readUntil(a, `"mailboxId":"mb-a"`);
    expect(gotA).not.toContain(`"mailboxId":"mb-b"`);
  });

  it("fans out one event to multiple users at once", async () => {
    const a = track(await subscribe("hub-user-a"));
    const b = track(await subscribe("hub-user-b"));

    await broadcastToUsers(e, ["hub-user-a", "hub-user-b"], {
      type: "thread_read",
      mailboxId: "mb-1",
      threadId: "t-1",
      read: true,
    });

    expect(await readUntil(a, "event: thread_read")).toContain(`"threadId":"t-1"`);
    expect(await readUntil(b, "event: thread_read")).toContain(`"threadId":"t-1"`);
  });

  it("is best-effort: broadcasting to a user with no subscribers resolves", async () => {
    await expect(
      broadcastToUsers(e, ["hub-user-nobody"], { type: "mailbox_expired", mailboxId: "mb-x" }),
    ).resolves.toBeUndefined();
  });
});
