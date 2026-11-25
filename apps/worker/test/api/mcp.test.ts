import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { label, mailboxMember, message, oauthClient, oauthConsent, user } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { mcpRoutes } from "../../src/api/mcp.ts";
import { createAuth, mcpResource } from "../../src/auth.ts";
import type { AppBindings, Env } from "../../src/env.ts";
import worker from "../../src/index.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  MEMBER_ID,
  OTHER_MAILBOX_ID,
  OWNER_ID,
  seedBase,
  seedThread,
} from "../support/seed.ts";

// Hono's app.request() targets http://localhost, a loopback origin the MCP
// plugin accepts as a resource; the token audience has to name the same URL.
const BASE = "http://localhost";
const ADDRESS = "team@example.com";
const OTHER_ADDRESS = "other@example.com";
const CLIENT_ID = "https://client.example/oauth/metadata.json";

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await db()
    .insert(oauthClient)
    .values({
      id: "client-1",
      clientId: CLIENT_ID,
      name: "Test client",
      redirectUris: JSON.stringify(["https://client.example/callback"]),
    });
  await grant(OWNER_ID);
});

async function grant(userId: string): Promise<void> {
  await db()
    .insert(oauthConsent)
    .values({
      id: `consent-${userId}`,
      clientId: CLIENT_ID,
      userId,
      scopes: JSON.stringify(["openid"]),
    });
}

// A real access token from the Worker's own auth instance: the same JWKS,
// issuer and audience binding requireMcpAuth checks in production.
async function mint(userId: string, claims: Record<string, unknown> = {}): Promise<string> {
  const auth = await createAuth({ env: e as unknown as Env, db: db(), baseURL: BASE });
  // The provider's token endpoint signs with the auth base URL as issuer; the
  // generic signJWT would default to the bare origin.
  const iss = (await auth.$context).baseURL;
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: userId,
        azp: CLIENT_ID,
        aud: mcpResource(BASE),
        iss,
        scope: "openid",
        ...claims,
      },
    },
  });
  return token;
}

const tokens = new Map<string, string>();
async function bearer(userId = OWNER_ID): Promise<string> {
  let t = tokens.get(userId);
  if (!t) {
    t = await mint(userId);
    tokens.set(userId, t);
  }
  return `Bearer ${t}`;
}

function app(): Hono<AppBindings> {
  return mountApp(mcpRoutes, null);
}

// Fire one JSON-RPC message at the handler. `auth` defaults to a valid owner
// token; pass null to omit the header entirely.
async function rpc(
  body: unknown,
  auth?: string | null,
  env: Env = e as unknown as Env,
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authz = auth === undefined ? await bearer() : auth;
  if (authz) headers.authorization = authz;
  const res = await app().request(
    "/",
    { method: "POST", body: JSON.stringify(body), headers },
    env as never,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

let seq = 0;
function call(name: string, args: Record<string, unknown> = {}, auth?: string | null, env?: Env) {
  return rpc(
    { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } },
    auth,
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
  beforeEach(() => tokens.clear());

  it("challenges a request with no token toward OAuth discovery", async () => {
    const { status, headers } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null);
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("refuses a token that isn't one of ours", async () => {
    const { status } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer not-a-jwt");
    expect(status).toBe(401);
  });

  it("refuses a token minted for another resource", async () => {
    const token = await mint(OWNER_ID, { aud: "http://localhost/api/other" });
    const { status } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, `Bearer ${token}`);
    expect(status).toBe(401);
  });

  it("no longer accepts an app password", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      `Basic ${btoa(`${ADDRESS}:abcde-fghjk-mnpqr-stuvw`)}`,
    );
    expect(status).toBe(401);
  });

  it("accepts a valid token", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(status).toBe(200);
    expect(json.result).toEqual({});
  });

  it("stops working the moment the user revokes the app", async () => {
    expect((await call("list_mailboxes")).status).toBe(200);
    await db().delete(oauthConsent).where(eq(oauthConsent.userId, OWNER_ID));
    const { status, headers } = await call("list_mailboxes");
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toMatch(/invalid_token/);
  });

  it("stops working for a banned user", async () => {
    expect((await call("list_mailboxes")).status).toBe(200);
    await db().update(user).set({ banned: true }).where(eq(user.id, OWNER_ID));
    expect((await call("list_mailboxes")).status).toBe(401);
  });

  it("ignores a consent another user gave the same client", async () => {
    const { status } = await call("list_mailboxes", {}, await bearer(MEMBER_ID));
    expect(status).toBe(401);
  });
});

describe("MCP transport — protocol", () => {
  it("initializes with the protocol version and points at list_mailboxes", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.instructions).toContain("list_mailboxes");
  });

  it("lists every tool with a JSON Schema and a read-only hint", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_mailboxes");
    expect(names).toContain("search_mail");
    expect(names).toContain("send_mail");
    const read = json.result.tools.find((t: any) => t.name === "read_thread");
    expect(read.inputSchema.properties.threadId).toBeDefined();
    expect(read.annotations.readOnlyHint).toBe(true);
    const send = json.result.tools.find((t: any) => t.name === "send_mail");
    expect(send.annotations.readOnlyHint).toBe(false);
    expect(send.inputSchema.required).toContain("mailbox");
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
      { method: "GET", headers: { authorization: await bearer() } },
      e as never,
    );
    expect(get.status).toBe(405);
  });
});

describe("MCP tools — reading", () => {
  it("lists every mailbox the user can reach", async () => {
    const out = payload((await call("list_mailboxes")).json);
    expect(out.mailboxes.map((m: any) => m.address)).toEqual([OTHER_ADDRESS, ADDRESS]);
    expect(out.mailboxes.every((m: any) => m.canWrite)).toBe(true);
  });

  it("lists threads across mailboxes, tagged with their mailbox", async () => {
    await seedThread(db(), MAILBOX_ID, { subject: "Team one", subjectNorm: "team one" });
    await seedThread(db(), OTHER_MAILBOX_ID, { subject: "Other one", subjectNorm: "other one" });

    const all = payload((await call("list_threads")).json);
    expect(all.threads.map((t: any) => [t.mailbox, t.subject]).toSorted()).toEqual([
      [OTHER_ADDRESS, "Other one"],
      [ADDRESS, "Team one"],
    ]);

    const one = payload((await call("list_threads", { mailbox: ADDRESS })).json);
    expect(one.threads.map((t: any) => t.subject)).toEqual(["Team one"]);
  });

  it("lists threads in the inbox view and hides trashed ones", async () => {
    await seedThread(db(), MAILBOX_ID, { subject: "Live one", subjectNorm: "live one" });
    await seedThread(db(), MAILBOX_ID, { subject: "Binned", subjectNorm: "binned", trashed: true });

    const inbox = payload((await call("list_threads")).json);
    expect(inbox.threads.map((t: any) => t.subject)).toEqual(["Live one"]);

    const trash = payload((await call("list_threads", { view: "trash" })).json);
    expect(trash.threads.map((t: any) => t.subject)).toEqual(["Binned"]);
  });

  it("names an unknown mailbox instead of returning nothing", async () => {
    const { json } = await call("list_threads", { mailbox: "nobody@example.com" });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/not_found/);
  });

  it("reads a thread in any of the user's mailboxes", async () => {
    const { threadId, messageId } = await seedThread(db(), OTHER_MAILBOX_ID);
    await db()
      .update(message)
      .set({ bodyText: "the full body text" })
      .where(eq(message.id, messageId));

    const out = payload((await call("read_thread", { threadId })).json);
    expect(out.mailbox).toBe(OTHER_ADDRESS);
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

  it("searches every mailbox by text, or just one", async () => {
    const a = await seedThread(db(), MAILBOX_ID);
    const b = await seedThread(db(), OTHER_MAILBOX_ID);
    for (const id of [a.messageId, b.messageId]) {
      // oxlint-disable-next-line no-await-in-loop
      await db()
        .update(message)
        .set({ subject: "Quarterly invoice", bodyText: "please find the invoice attached" })
        .where(eq(message.id, id));
    }

    const all = payload((await call("search_mail", { query: "invoice" })).json);
    expect(all.results.map((r: any) => r.mailbox).toSorted()).toEqual([OTHER_ADDRESS, ADDRESS]);

    const one = payload((await call("search_mail", { query: "invoice", mailbox: ADDRESS })).json);
    expect(one.results).toHaveLength(1);
    expect(one.results[0].mailbox).toBe(ADDRESS);
  });

  it("never reaches a thread in a mailbox the user can't see", async () => {
    const { threadId } = await seedThread(db(), OTHER_MAILBOX_ID);
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    await grant(MEMBER_ID);
    const { json } = await call("read_thread", { threadId }, await bearer(MEMBER_ID));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/not_found/);
  });

  it("lists the labels of one mailbox", async () => {
    await db().insert(label).values({ id: "lbl-1", mailboxId: MAILBOX_ID, name: "Work" });
    const out = payload((await call("list_labels", { mailbox: ADDRESS })).json);
    expect(out.labels.map((l: any) => l.name)).toEqual(["Work"]);
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

    const listed = payload((await call("list_threads", { mailbox: ADDRESS })).json);
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
  beforeEach(() => grant(MEMBER_ID));

  it("lets a READ-only member read but not write", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    const { threadId } = await seedThread(db());
    const auth = await bearer(MEMBER_ID);

    const read = await call("read_thread", { threadId }, auth);
    expect(read.json.result.isError).toBeUndefined();

    const write = await call("update_thread", { threadId, read: true }, auth);
    expect(write.json.result.isError).toBe(true);
    expect(write.json.result.content[0].text).toMatch(/forbidden/);
  });

  it("shows a member only the mailboxes shared with them", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    const out = payload((await call("list_mailboxes", {}, await bearer(MEMBER_ID))).json);
    expect(out.mailboxes).toEqual([expect.objectContaining({ address: ADDRESS, canWrite: false })]);
  });

  it("a user with no mailboxes sees none, and can't name one", async () => {
    const auth = await bearer(MEMBER_ID);
    expect(payload((await call("list_mailboxes", {}, auth)).json).mailboxes).toEqual([]);
    const { json } = await call("list_labels", { mailbox: ADDRESS }, auth);
    expect(json.result.content[0].text).toMatch(/not_found/);
  });

  it("stops writes as soon as the membership is downgraded", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE, MAILBOX_ID, MEMBER_ID);
    const { threadId } = await seedThread(db());
    const auth = await bearer(MEMBER_ID);

    const before = await call("update_thread", { threadId, read: true }, auth);
    expect(before.json.result.isError).toBeUndefined();

    await db()
      .update(mailboxMember)
      .set({ perms: Perm.READ })
      .where(and(eq(mailboxMember.userId, MEMBER_ID), eq(mailboxMember.mailboxId, MAILBOX_ID)));

    const after = await call("update_thread", { threadId, read: false }, auth);
    expect(after.json.result.isError).toBe(true);
  });
});

describe("MCP tools — sending", () => {
  it("sends a new message from the named mailbox", async () => {
    const email = emailOk();
    const { json } = await call(
      "send_mail",
      {
        mailbox: OTHER_ADDRESS,
        to: [{ address: "recipient@elsewhere.test" }],
        subject: "Greetings",
        text: "hello there",
      },
      undefined,
      envWith(email),
    );

    const out = payload(json);
    expect(email.send).toHaveBeenCalledTimes(1);
    const row = await db().query.message.findFirst({ where: eq(message.id, out.messageId) });
    expect(row).toMatchObject({
      direction: "out",
      subject: "Greetings",
      fromAddr: OTHER_ADDRESS,
      mailboxId: OTHER_MAILBOX_ID,
    });
  });

  it("replies from the thread's own mailbox, keeping subject and threading headers", async () => {
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
      fromAddr: ADDRESS,
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

  it("refuses to send from a mailbox shared READ-only", async () => {
    await grant(MEMBER_ID);
    await grantMember(db(), Perm.READ, MAILBOX_ID, MEMBER_ID);
    const email = emailOk();

    const { json } = await call(
      "send_mail",
      { mailbox: ADDRESS, to: [{ address: "recipient@elsewhere.test" }], text: "hi" },
      await bearer(MEMBER_ID),
      envWith(email),
    );

    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/forbidden/);
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

  it("requires a mailbox to send from", async () => {
    const { json } = await call("send_mail", { text: "hi", to: [{ address: "x@y.test" }] });
    expect(json.error.code).toBe(-32602);
    expect(json.error.data.issues[0].path).toBe("mailbox");
  });
});

// Everything above mounts `mcpRoutes` directly, which says nothing about the
// route being wired up. These drive the composed router, so a missing or
// misspelled mount fails here rather than in someone's MCP client.
describe("MCP mounting", () => {
  async function viaApi(path: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await buildApi().fetch(new Request(`${BASE}${path}`, init), e as never, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const toolsList = (headers: Record<string, string>) =>
    viaApi("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "content-type": "application/json", ...headers },
    });

  it("serves /api/mcp on a bearer token with no session cookie", async () => {
    const res = await toolsList({ authorization: await bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("answers its own 401 without a credential", async () => {
    const res = await toolsList({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("publishes protected-resource metadata naming this server's issuer", async () => {
    const res = await viaApi("/.well-known/oauth-protected-resource/api/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource).toBe(mcpResource(BASE));
    expect(body.authorization_servers).toHaveLength(1);
  });

  it("routes discovery through the Worker entry, not to the SPA", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`),
      e as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(((await res.json()) as any).resource).toBe(mcpResource(BASE));
  });

  it("publishes authorization-server metadata with CIMD support", async () => {
    const prm = (await (
      await viaApi("/.well-known/oauth-protected-resource/api/mcp")
    ).json()) as any;
    const issuerPath = new URL(prm.authorization_servers[0]).pathname.replace(/\/$/, "");
    const res = await viaApi(`/.well-known/oauth-authorization-server${issuerPath}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.authorization_endpoint).toContain("/oauth2/authorize");
    expect(body.client_id_metadata_document_supported).toBe(true);
  });
});
