import { message, rateLimitCounter } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesRoutes } from "../../src/api/messages.ts";
import { getOrCreateAuthSecret } from "../../src/config.ts";
import type { AppBindings, Env } from "../../src/env.ts";
import { MAX_IMAGE_BYTES, proxyRemoteContent } from "../../src/mail/img-proxy.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(messagesRoutes, owner);
const asMember = () => mountApp(messagesRoutes, member);
const asOutsider = () => mountApp(messagesRoutes, outsider);
const asAnon = () => mountApp(messagesRoutes, null);

// Like `request`, but with an env override — used to swap in a fake EMAIL
// binding (the send path) without touching the shared harness.
function requestWithEnv(
  app: Hono<AppBindings>,
  method: string,
  path: string,
  body: unknown,
  env: Env,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return Promise.resolve(app.request(path, init, env));
}

function envWithEmail(send: (...args: unknown[]) => Promise<unknown>): Env {
  return { ...e, EMAIL: { send } as unknown as Env["EMAIL"] } as Env;
}

const SEND_BODY = {
  mailboxId: MAILBOX_ID,
  to: [{ address: "recipient@elsewhere.test" }],
  subject: "Hi",
  text: "hello",
};

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  // R2 has no per-test reset — clear this mailbox's sent blobs so rollback
  // assertions don't see leftovers from earlier tests.
  const listed = await e.BLOBS.list({ prefix: `raw/${MAILBOX_ID}/` });
  await Promise.all(listed.objects.map((o) => e.BLOBS.delete(o.key)));
});

describe("POST /send — authorization", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(401);
  });

  it("403s a non-member", async () => {
    const res = await request(asOutsider(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(403);
  });

  it("403s a viewer (READ-only member)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(403);
  });
});

describe("POST /send — delivery", () => {
  it("201s and persists the message on success", async () => {
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => ({ messageId: "platform-mid" })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { messageId: string; threadId: string };
    const row = await db().query.message.findFirst({ where: eq(message.id, body.messageId) });
    expect(row).toMatchObject({ direction: "out", threadId: body.threadId });
    expect(await e.BLOBS.head(row!.rawR2Key!)).not.toBeNull();
  });

  it("5xxs and rolls back the persisted record when EMAIL.send fails", async () => {
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => Promise.reject(new Error("smtp down"))),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("send failed");
    // No orphan Sent entry or thread survives the failure.
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await db().query.thread.findMany()).toHaveLength(0);
    const blobs = await e.BLOBS.list({ prefix: `raw/${MAILBOX_ID}/sent/` });
    expect(blobs.objects).toHaveLength(0);
  });

  it("lists the attachments on the Sent copy and serves their bytes", async () => {
    const key = `draft/${OWNER_ID}/${crypto.randomUUID()}-shot.png`;
    await e.BLOBS.put(key, "png-bytes", { httpMetadata: { contentType: "image/png" } });
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      {
        ...SEND_BODY,
        attachments: [{ r2Key: key, filename: "shot.png", contentType: "image/png" }],
      },
      envWithEmail(async () => ({ messageId: "platform-mid" })),
    );
    expect(res.status).toBe(201);
    const { messageId } = (await res.json()) as { messageId: string };

    const body = (await (await request(asOwner(), "GET", `/${messageId}/body`)).json()) as {
      attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      filename: "shot.png",
      contentType: "image/png",
      sizeBytes: 9,
    });

    const raw = await request(
      asOwner(),
      "GET",
      `/${messageId}/attachments/${body.attachments[0]!.id}/raw`,
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("png-bytes");
  });

  it("429s once the per-user send window is exhausted", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: `send:${OWNER_ID}`, count: 60, windowStart: Date.now() });
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => ({ messageId: "x" })),
    );
    expect(res.status).toBe(429);
    expect(await db().query.message.findMany()).toHaveLength(0);
  });
});

describe("GET /:id/body — server-side sanitization", () => {
  const RAW_HTML =
    `<div><script>alert(1)</script>` +
    `<p onclick="steal()">Hi <b>there</b></p>` +
    `<a href="javascript:alert(2)">bad</a>` +
    `<a href="https://ok.test/a">ok</a></div>`;

  async function seedHtmlMessage(): Promise<string> {
    const { messageId } = await seedThread(db());
    const rawKey = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
    const eml = [
      "MIME-Version: 1.0",
      "From: sender@elsewhere.test",
      "To: team@example.com",
      "Subject: Hello",
      "Content-Type: text/html; charset=utf-8",
      "",
      RAW_HTML,
    ].join("\r\n");
    await e.BLOBS.put(rawKey, eml);
    await db().update(message).set({ rawR2Key: rawKey }).where(eq(message.id, messageId));
    return messageId;
  }

  it("strips script/event-handler/javascript: vectors but keeps benign markup", async () => {
    const id = await seedHtmlMessage();
    const res = await request(asOwner(), "GET", `/${id}/body`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string | null };
    expect(body.html).toBeTruthy();
    const html = body.html!;
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Hi <b>there</b>");
    expect(html).toContain("https://ok.test/a");
  });

  it("lets a READ member fetch the body", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedHtmlMessage();
    const res = await request(asMember(), "GET", `/${id}/body`);
    expect(res.status).toBe(200);
  });

  it("403s a non-member and 404s a missing message", async () => {
    const id = await seedHtmlMessage();
    expect((await request(asOutsider(), "GET", `/${id}/body`)).status).toBe(403);
    expect((await request(asOwner(), "GET", "/missing/body")).status).toBe(404);
  });
});

describe("message mutations — viewer role semantics", () => {
  it("a READ member can mark seen/starred but cannot trash or delete", async () => {
    await grantMember(db(), Perm.READ);
    const { messageId } = await seedThread(db());

    const seen = await request(asMember(), "PATCH", `/${messageId}`, { seen: true });
    expect(seen.status).toBe(200);
    const { flags } = (await seen.json()) as { flags: number };
    expect(flags & Flag.SEEN).toBe(Flag.SEEN);

    expect((await request(asMember(), "PATCH", `/${messageId}`, { trash: true })).status).toBe(403);
    expect((await request(asMember(), "DELETE", `/${messageId}`)).status).toBe(403);
  });

  it("403s a non-member on any message mutation", async () => {
    const { messageId } = await seedThread(db());
    expect((await request(asOutsider(), "PATCH", `/${messageId}`, { seen: true })).status).toBe(
      403,
    );
    expect((await request(asOutsider(), "DELETE", `/${messageId}`)).status).toBe(403);
  });
});

// Sign a proxy URL the same way the body rewriter does, so /proxy-image
// accepts it.
async function signedProxyPath(url: string): Promise<string> {
  const secret = await getOrCreateAuthSecret(db());
  const html = await proxyRemoteContent(`<img src="${url}">`, secret);
  const query = html.match(/proxy-image\?([^"\s]+)/)?.[1];
  if (!query) throw new Error("no proxy url produced");
  return `/proxy-image?${query.replace(/&amp;/g, "&")}`;
}

function stream(totalBytes: number, chunkSize = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= totalBytes) return ctrl.close();
      const n = Math.min(chunkSize, totalBytes - sent);
      ctrl.enqueue(new Uint8Array(n));
      sent += n;
    },
  });
}

// safeRedirectFetch only reads status/ok/body/headers, so a duck-typed
// upstream keeps header control exact (a real Response may rewrite
// content-length).
function stubUpstream(headers: Record<string, string>, body: ReadableStream<Uint8Array>): void {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    body,
    headers: new Headers(headers),
  }));
}

describe("GET /proxy-image — size limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("413s when the declared content-length exceeds the cap", async () => {
    const path = await signedProxyPath("https://images.example/big.png");
    stubUpstream(
      { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
      stream(16),
    );
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(413);
  });

  it("enforces the streaming cap when no content-length is declared", async () => {
    const path = await signedProxyPath("https://images.example/chunked.png");
    stubUpstream({ "content-type": "image/png" }, stream(MAX_IMAGE_BYTES + 1024));
    const res = await request(asOwner(), "GET", path);
    // The cap trips mid-stream: headers are already committed, so the failure
    // surfaces as an errored body rather than a status code.
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("streams a small image through untouched", async () => {
    const path = await signedProxyPath("https://images.example/ok.png");
    stubUpstream({ "content-type": "image/png", "content-length": "16" }, stream(16, 16));
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(16);
  });

  it("429s once the per-user proxy window is exhausted", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: `proxy-image:${OWNER_ID}`, count: 300, windowStart: Date.now() });
    const path = await signedProxyPath("https://images.example/limited.png");
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(429);
  });
});
