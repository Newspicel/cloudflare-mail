import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { appPassword, label, mailboxMember, message } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { mcpRoutes } from "../../src/api/mcp.ts";
import { hashAppPassword } from "../../src/app-passwords.ts";
import type { AppBindings, Env } from "../../src/env.ts";
import { applyMigrationsOnce, type DB, db, e, mountApp, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  MEMBER_ID,
  OWNER_ID,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const PASSWORD = "abcde-fghjk-mnpqr-stuvw";
const ADDRESS = "team@example.com";

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await issueAppPassword(db(), OWNER_ID);
});

// MCP authenticates with an app password rather than a session, so the suite
// mounts the routes with no session user and supplies credentials per request.
function app(): Hono<AppBindings> {
  return mountApp(mcpRoutes, null);
}

async function issueAppPassword(d: DB, userId: string, id = `apk-${userId}`): Promise<void> {
  await d.insert(appPassword).values({
    id,
    userId,
    mailboxId: MAILBOX_ID,
    name: "mcp",
    hash: await hashAppPassword(PASSWORD),
  });
}

function basic(username = ADDRESS, password = PASSWORD): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

// Fire one JSON-RPC message at the handler. `auth` defaults to valid owner
// credentials; pass null to omit the header entirely.
async function rpc(
  body: unknown,
  auth: string | null = basic(),
  env: Env = e as unknown as Env,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await app().request(
    "/",
    { method: "POST", body: JSON.stringify(body), headers },
    env as never,
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let seq = 0;
function call(name: string, args: Record<string, unknown> = {}, auth?: string | null, env?: Env) {
  return rpc(
    { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } },
    auth === undefined ? basic() : auth,
    env,
  );
}

// The EMAIL binding has no local simulation, so sends run against a fake (same
// approach as test/send.test.ts).
function emailOk(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => ({ messageId: "platform-mid" })) };
}
function envWith(email: { send: unknown }): Env {
  return { ...e, EMAIL: email as unknown as Env["EMAIL"] } as Env;
}

// tools/call wraps results as JSON text; unwrap to the object the tool returned.
function payload(json: any): any {
  return JSON.parse(json.result.content[0].text);
}

describe("MCP transport — auth", () => {
  it("refuses a request with no credentials", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null);
    expect(status).toBe(401);
    expect(json.error).toMatch(/app password/i);
  });

  it("refuses a wrong password", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      basic(ADDRESS, "wrong-wrong-wrong-xx"),
    );
    expect(status).toBe(401);
  });

  it("accepts the address:password pair as a bearer token", async () => {
    const { status, json } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      `Bearer ${ADDRESS}:${PASSWORD}`,
    );
    expect(status).toBe(200);
    expect(json.result).toEqual({});
  });

  it("stops working the moment the app password is deleted", async () => {
    expect((await call("get_mailbox")).status).toBe(200);
    await db()
      .delete(appPassword)
      .where(eq(appPassword.id, `apk-${OWNER_ID}`));
    const { status } = await call("get_mailbox");
    expect(status).toBe(401);
  });
});

describe("MCP transport — protocol", () => {
  it("initializes with the protocol version and names the mailbox", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.instructions).toContain(ADDRESS);
  });

  it("lists every tool with a JSON Schema and a read-only hint", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toContain("search_mail");
    expect(names).toContain("send_mail");
    const read = json.result.tools.find((t: any) => t.name === "read_thread");
    expect(read.inputSchema.properties.threadId).toBeDefined();
    expect(read.annotations.readOnlyHint).toBe(true);
    expect(
      json.result.tools.find((t: any) => t.name === "send_mail").annotations.readOnlyHint,
    ).toBe(false);
  });

  it("answers a notification with 202 and no body", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(json).toBeNull();
  });

  it("rejects an unknown method", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(json.error.code).toBe(-32601);
    expect(json.id).toBe(7);
  });

  it("answers a batch with one reply per request", async () => {
    const { json } = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(json).toHaveLength(2);
    expect(json.map((r: any) => r.id)).toEqual([1, 2]);
  });

  it("does not offer a stream or a session to delete", async () => {
    const get = await app().request(
      "/",
      { method: "GET", headers: { authorization: basic() } },
      e as never,
    );
    expect(get.status).toBe(405);
  });
});

describe("MCP tools — reading", () => {
  it("describes the connected mailbox", async () => {
    const { json } = await call("get_mailbox");
    const out = payload(json);
    expect(out.address).toBe(ADDRESS);
    expect(out.canWrite).toBe(true);
  });

  it("lists threads in the inbox view and hides trashed ones", async () => {
    await seedThread(db(), MAILBOX_ID, { subjectNorm: "live one" });
    await seedThread(db(), MAILBOX_ID, { subjectNorm: "binned", trashed: true });

    const inbox = payload((await call("list_threads")).json);
    expect(inbox.threads.map((t: any) => t.subject)).toEqual(["live one"]);

    const trash = payload((await call("list_threads", { view: "trash" })).json);
    expect(trash.threads.map((t: any) => t.subject)).toEqual(["binned"]);
  });

  it("reads a thread with its messages and bodies", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({ bodyText: "the full body text" })
      .where(eq(message.id, messageId));

    const out = payload((await call("read_thread", { threadId })).json);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].body).toBe("the full body text");
    expect(out.messages[0].from).toBe("Sender <sender@elsewhere.test>");
    expect(out.messages[0].unread).toBe(true);
  });

  it("truncates a long body and says so", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({ bodyText: "x".repeat(9000) })
      .where(eq(message.id, messageId));

    const out = payload((await call("read_thread", { threadId })).json);
    expect(out.messages[0].body).toHaveLength(4000);
    expect(out.messages[0].bodyTruncated).toBe(true);
  });

  it("searches the mailbox by text", async () => {
    const { messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({ subject: "Quarterly invoice", bodyText: "please find the invoice attached" })
      .where(eq(message.id, messageId));

    const out = payload((await call("search_mail", { query: "invoice" })).json);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].subject).toBe("Quarterly invoice");
  });

  it("never reaches a thread in another mailbox", async () => {
    const { threadId } = await seedThread(db(), "mailbox-2");
    const { json } = await call("read_thread", { threadId });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/not_found/);
  });
});

describe("MCP tools — writing", () => {
  it("marks a thread read and clears its unread count", async () => {
    const { threadId } = await seedThread(db(), MAILBOX_ID, { unreadCount: 1 });
    const out = payload((await call("update_thread", { threadId, read: true })).json);
    expect(out.unreadCount).toBe(0);

    const rows = await db().select().from(message).where(eq(message.threadId, threadId));
    expect(rows[0]!.flags & Flag.SEEN).toBe(Flag.SEEN);
  });

  it("trashing a thread clears its spam flag", async () => {
    const { threadId } = await seedThread(db(), MAILBOX_ID, { spam: true });
    const out = payload((await call("update_thread", { threadId, trashed: true })).json);
    expect(out.trashed).toBe(true);
    expect(out.spam).toBe(false);
  });

  it("stars a message", async () => {
    const { messageId } = await seedThread(db());
    const out = payload((await call("star_message", { messageId, starred: true })).json);
    expect(out.starred).toBe(true);

    const rows = await db().select().from(message).where(eq(message.id, messageId));
    expect(rows[0]!.flags & Flag.STARRED).toBe(Flag.STARRED);
  });

  it("attaches an existing label across the thread", async () => {
    const { threadId } = await seedThread(db());
    await db().insert(label).values({ id: "lbl-1", mailboxId: MAILBOX_ID, name: "Work" });

    const out = payload(
      (await call("set_thread_label", { threadId, labelName: "Work", attached: true })).json,
    );
    expect(out.attached).toBe(true);

    const listed = payload((await call("list_threads")).json);
    expect(listed.threads[0].labels).toEqual(["Work"]);
  });

  it("reports a missing label as a tool error, not a crash", async () => {
    const { threadId } = await seedThread(db());
    const { json } = await call("set_thread_label", {
      threadId,
      labelName: "Nope",
      attached: true,
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/no label named/);
  });
});

describe("MCP tools — RBAC", () => {
  beforeEach(async () => {
    await issueAppPassword(db(), MEMBER_ID, `apk-${MEMBER_ID}`);
  });

  it("lets a READ-only member read but not write", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    const { threadId } = await seedThread(db());
    const auth = `Bearer member@example.com:${PASSWORD}`;

    const read = await call("read_thread", { threadId }, auth);
    expect(read.json.result.isError).toBeUndefined();

    const write = await call("update_thread", { threadId, read: true }, auth);
    expect(write.json.result.isError).toBe(true);
    expect(write.json.result.content[0].text).toMatch(/forbidden/);
  });

  it("refuses a member with no membership at all", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      `Bearer member@example.com:${PASSWORD}`,
    );
    expect(status).toBe(401);
  });

  it("stops writes as soon as the membership is downgraded", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE, MAILBOX_ID, MEMBER_ID);
    const { threadId } = await seedThread(db());
    const auth = `Bearer member@example.com:${PASSWORD}`;

    const before = await call("update_thread", { threadId, read: true }, auth);
    expect(before.json.result.isError).toBeUndefined();

    await db()
      .update(mailboxMember)
      .set({ perms: Perm.READ })
      .where(eq(mailboxMember.userId, MEMBER_ID));

    const after = await call("update_thread", { threadId, read: false }, auth);
    expect(after.json.result.isError).toBe(true);
  });
});

describe("MCP tools — sending", () => {
  it("sends a new message from the connected mailbox", async () => {
    const email = emailOk();
    const { json } = await call(
      "send_mail",
      { to: [{ address: "recipient@elsewhere.test" }], subject: "Greetings", text: "hello there" },
      undefined,
      envWith(email),
    );

    const out = payload(json);
    expect(email.send).toHaveBeenCalledTimes(1);
    const row = await db().query.message.findFirst({ where: eq(message.id, out.messageId) });
    expect(row).toMatchObject({ direction: "out", subject: "Greetings", fromAddr: ADDRESS });
  });

  it("replies to the sender, keeping subject and threading headers", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({
        messageIdHdr: "<orig@elsewhere.test>",
        toAddrs: [{ address: ADDRESS }, { address: "other@elsewhere.test" }],
        ccAddrs: [{ address: "cc@elsewhere.test" }],
      })
      .where(eq(message.id, messageId));

    const email = emailOk();
    const { json } = await call(
      "reply_to_thread",
      { threadId, text: "thanks!" },
      undefined,
      envWith(email),
    );

    const out = payload(json);
    const row = await db().query.message.findFirst({ where: eq(message.id, out.messageId) });
    expect(row).toMatchObject({
      direction: "out",
      subject: "Re: Hello",
      inReplyTo: "<orig@elsewhere.test>",
    });
    expect(row!.references).toEqual(["<orig@elsewhere.test>"]);
    // Plain reply goes to the sender only.
    expect(row!.toAddrs).toEqual([{ name: "Sender", address: "sender@elsewhere.test" }]);
    expect(row!.ccAddrs).toBeNull();
  });

  it("reply-all copies the other recipients but never the mailbox itself", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({
        messageIdHdr: "<orig@elsewhere.test>",
        toAddrs: [{ address: ADDRESS }, { address: "other@elsewhere.test" }],
        ccAddrs: [{ address: "cc@elsewhere.test" }],
      })
      .where(eq(message.id, messageId));

    const { json } = await call(
      "reply_to_thread",
      { threadId, text: "thanks all", replyAll: true },
      undefined,
      envWith(emailOk()),
    );

    const row = await db().query.message.findFirst({
      where: eq(message.id, payload(json).messageId),
    });
    expect(row!.toAddrs).toEqual([{ name: "Sender", address: "sender@elsewhere.test" }]);
    expect(row!.ccAddrs!.map((a) => a.address)).toEqual([
      "other@elsewhere.test",
      "cc@elsewhere.test",
    ]);
  });

  it("does not double up an existing Re: prefix", async () => {
    const { threadId, messageId } = await seedThread(db());
    await db()
      .update(message)
      .set({ subject: "Re: Hello", messageIdHdr: "<orig@elsewhere.test>" })
      .where(eq(message.id, messageId));

    const { json } = await call(
      "reply_to_thread",
      { threadId, text: "again" },
      undefined,
      envWith(emailOk()),
    );
    const row = await db().query.message.findFirst({
      where: eq(message.id, payload(json).messageId),
    });
    expect(row!.subject).toBe("Re: Hello");
  });

  it("refuses to send from a READ-only connection", async () => {
    await issueAppPassword(db(), MEMBER_ID, `apk-${MEMBER_ID}`);
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    const email = emailOk();

    const { json } = await call(
      "send_mail",
      { to: [{ address: "recipient@elsewhere.test" }], text: "hi" },
      `Bearer member@example.com:${PASSWORD}`,
      envWith(email),
    );

    expect(json.result.isError).toBe(true);
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe("MCP tools — argument validation", () => {
  it("rejects an unknown tool", async () => {
    const { json } = await call("delete_everything");
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toMatch(/unknown tool/);
  });

  it("rejects bad arguments with the failing field", async () => {
    const { json } = await call("read_thread", {});
    expect(json.error.code).toBe(-32602);
    expect(json.error.data.issues[0].path).toBe("threadId");
  });

  it("requires at least one field on update_thread", async () => {
    const { threadId } = await seedThread(db());
    const { json } = await call("update_thread", { threadId });
    expect(json.error.code).toBe(-32602);
  });

  it("rejects a send with no recipients", async () => {
    const { json } = await call("send_mail", { text: "hi", to: [] });
    expect(json.error.code).toBe(-32602);
  });
});

// Everything above mounts `mcpRoutes` directly, which says nothing about the
// route being wired up. These drive the composed router, so a missing or
// misspelled mount fails here rather than in someone's MCP client.
describe("MCP mounting", () => {
  async function viaApi(headers: Record<string, string>): Promise<Response> {
    const ctx = createExecutionContext();
    const req = new Request("https://mail.test/api/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "content-type": "application/json", ...headers },
    });
    const res = await buildApi().fetch(req, e as never, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("serves /api/mcp on an app password with no session cookie", async () => {
    const res = await viaApi({ authorization: basic() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("answers its own 401 without a credential", async () => {
    const res = await viaApi({});
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toMatch(/app password/i);
  });
});
