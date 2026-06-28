import type { ServiceMode } from "@cfmail/db/enums";
import { mailbox } from "@cfmail/db/schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { svcRoutes } from "../../src/api/svc.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { DOMAIN_ID, seedBase, seedThread } from "../support/seed.ts";

// SHA-256 hex, computed exactly the way svc.ts hashes the bearer key.
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SVC_MAILBOX_ID = "mailbox-svc";
const SVC_KEY = "secret-service-key-123";

// Insert a service mailbox unlocked by `key`.
async function seedServiceMailbox(opts: {
  id?: string;
  key: string;
  mode?: ServiceMode;
  localPart?: string;
  type?: "service" | "group";
}): Promise<string> {
  const id = opts.id ?? SVC_MAILBOX_ID;
  await db()
    .insert(mailbox)
    .values({
      id,
      domainId: DOMAIN_ID,
      localPart: opts.localPart ?? "svc",
      type: opts.type ?? "service",
      ownerUserId: "user-owner",
      serviceKeyHash: await sha256Hex(opts.key),
      serviceMode: opts.mode ?? "duplex",
    });
  return id;
}

const app = () => mountApp(svcRoutes, null);

// svc.ts reads a custom Authorization header, which the support `request()`
// helper can't set — build the Request directly.
async function svcRequest(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? SVC_KEY}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return await app().request(path, { method: opts.method ?? "GET", headers, body }, e);
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("svc auth", () => {
  it("401s when the Authorization header is missing", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/info", { token: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing bearer key" });
  });

  it("401s on a malformed (non-Bearer) header", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await app().request("/info", { headers: { Authorization: "Basic abc" } }, e);
    expect(res.status).toBe(401);
  });

  it("401s when the bearer key matches no mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/info", { token: "wrong-key" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid key" });
  });

  it("401s when the key matches a non-service mailbox", async () => {
    // Same key hash, but the row is a group mailbox — auth requires type=service.
    await seedServiceMailbox({ key: SVC_KEY, type: "group", localPart: "grp" });
    const res = await svcRequest("/info");
    expect(res.status).toBe(401);
  });
});

describe("svc /info", () => {
  it("returns the address and mode for a valid key", async () => {
    await seedServiceMailbox({ key: SVC_KEY, mode: "duplex", localPart: "bot" });
    const res = await svcRequest("/info");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ address: "bot@example.com", mode: "duplex" });
  });

  it("reports mode=send for a send-only mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY, mode: "send", localPart: "bot" });
    const res = await svcRequest("/info");
    expect(await res.json()).toMatchObject({ mode: "send" });
  });
});

describe("svc /messages", () => {
  it("lists the mailbox's messages newest-first", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const a = await seedThread(db(), SVC_MAILBOX_ID);
    const b = await seedThread(db(), SVC_MAILBOX_ID);

    const res = await svcRequest("/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string }[]; nextCursor: string | null };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(a.messageId);
    expect(ids).toContain(b.messageId);
    expect(body.nextCursor).toBe(body.messages[0]?.id);
  });

  it("isolates messages to the key's mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    await seedThread(db(), SVC_MAILBOX_ID);
    const other = await seedThread(db(), "mailbox-1");

    const res = await svcRequest("/messages");
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).not.toContain(other.messageId);
  });

  it("400s on an unknown cursor", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/messages?after=does-not-exist");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown cursor" });
  });

  it("400s on a cursor that belongs to another mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const other = await seedThread(db(), "mailbox-1");
    const res = await svcRequest(`/messages?after=${other.messageId}`);
    expect(res.status).toBe(400);
  });

  it("paginates forward from a cursor (oldest-first, exclusive)", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const a = await seedThread(db(), SVC_MAILBOX_ID);
    const b = await seedThread(db(), SVC_MAILBOX_ID);

    const res = await svcRequest(`/messages?after=${a.messageId}`);
    const body = (await res.json()) as { messages: { id: string }[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).not.toContain(a.messageId);
    expect(ids).toContain(b.messageId);
  });
});

describe("svc /messages/:id", () => {
  it("returns a single message (no raw body) for the key's mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const { messageId } = await seedThread(db(), SVC_MAILBOX_ID);

    const res = await svcRequest(`/messages/${messageId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; text?: string; attachments: unknown[] };
    expect(body.id).toBe(messageId);
    expect(body.text).toBeUndefined();
    expect(body.attachments).toEqual([]);
  });

  it("404s for a missing message", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/messages/nope");
    expect(res.status).toBe(404);
  });

  it("404s for a message in another mailbox", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const other = await seedThread(db(), "mailbox-1");
    const res = await svcRequest(`/messages/${other.messageId}`);
    expect(res.status).toBe(404);
  });
});

describe("svc /send", () => {
  it("400s on an invalid body (empty recipients) before dispatch", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/send", { method: "POST", body: { to: [], subject: "hi" } });
    expect(res.status).toBe(400);
  });

  it("400s when `to` is omitted entirely", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/send", { method: "POST", body: { subject: "hi" } });
    expect(res.status).toBe(400);
  });

  it("still requires a valid key", async () => {
    await seedServiceMailbox({ key: SVC_KEY });
    const res = await svcRequest("/send", {
      method: "POST",
      token: "bad",
      body: { to: [{ email: "x@y.test" }] },
    });
    expect(res.status).toBe(401);
  });
});
