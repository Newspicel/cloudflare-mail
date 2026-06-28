import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { labelsRoutes } from "../../src/api/labels.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(labelsRoutes, owner);
const asMember = () => mountApp(labelsRoutes, member);
const asOutsider = () => mountApp(labelsRoutes, outsider);

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("labels", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(mountApp(labelsRoutes, null), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(401);
  });

  it("requires mailboxId on list", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(400);
  });

  it("creates, lists, and orders labels by name", async () => {
    const app = asOwner();
    const a = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Zeta" });
    const b = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Alpha" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const res = await request(app, "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { labels: { name: string; color: string }[] };
    expect(body.labels.map((l) => l.name)).toEqual(["Alpha", "Zeta"]);
    expect(body.labels[0]?.color).toBe("#64748b");
  });

  it("rejects a duplicate name with 409", async () => {
    const app = asOwner();
    await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Dup" });
    const res = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Dup" });
    expect(res.status).toBe(409);
  });

  it("rejects invalid bodies via the validator", async () => {
    const res = await request(asOwner(), "POST", "/", { mailboxId: MAILBOX_ID });
    expect(res.status).toBe(400);
  });

  it("forbids a member without WRITE from creating", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", "/", { mailboxId: MAILBOX_ID, name: "x" });
    expect(res.status).toBe(403);
  });

  it("lets a member with WRITE create", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const res = await request(asMember(), "POST", "/", { mailboxId: MAILBOX_ID, name: "ok" });
    expect(res.status).toBe(201);
  });

  it("hides labels from an outsider on list (403)", async () => {
    const res = await request(asOutsider(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("patches a label name and color", async () => {
    const app = asOwner();
    const created = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Old" });
    const { id } = (await created.json()) as { id: string };
    const res = await request(app, "PATCH", `/${id}`, { name: " New ", color: "#ff0000" });
    expect(res.status).toBe(200);

    const list = await request(app, "GET", `/?mailboxId=${MAILBOX_ID}`);
    const body = (await list.json()) as { labels: { name: string; color: string }[] };
    expect(body.labels[0]).toMatchObject({ name: "New", color: "#ff0000" });
  });

  it("404s patching a missing label", async () => {
    const res = await request(asOwner(), "PATCH", "/nope", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("deletes a label", async () => {
    const app = asOwner();
    const created = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Bye" });
    const { id } = (await created.json()) as { id: string };
    const res = await request(app, "DELETE", `/${id}`);
    expect(res.status).toBe(204);

    const list = await request(app, "GET", `/?mailboxId=${MAILBOX_ID}`);
    const body = (await list.json()) as { labels: unknown[] };
    expect(body.labels).toHaveLength(0);
  });

  it("applies and removes a label on a message", async () => {
    const app = asOwner();
    const { messageId } = await seedThread(db());
    const created = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Tag" });
    const { id } = (await created.json()) as { id: string };

    const put = await request(app, "PUT", `/${id}/messages/${messageId}`);
    expect(put.status).toBe(200);

    const byMsg = await request(app, "GET", `/by-messages?id=${messageId}`);
    const body = (await byMsg.json()) as { labels: Record<string, { id: string }[]> };
    expect(body.labels[messageId]?.[0]?.id).toBe(id);

    const del = await request(app, "DELETE", `/${id}/messages/${messageId}`);
    expect(del.status).toBe(204);
    const after = await request(app, "GET", `/by-messages?id=${messageId}`);
    const afterBody = (await after.json()) as { labels: Record<string, unknown> };
    expect(afterBody.labels[messageId]).toBeUndefined();
  });

  it("400s applying a label whose mailbox differs from the message", async () => {
    const app = asOwner();
    const { messageId } = await seedThread(db(), OTHER_MAILBOX_ID);
    const created = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "X" });
    const { id } = (await created.json()) as { id: string };
    const res = await request(app, "PUT", `/${id}/messages/${messageId}`);
    expect(res.status).toBe(400);
  });

  it("by-messages filters out mailboxes the caller can't read", async () => {
    const app = asMember();
    await grantMember(db(), Perm.READ);
    const { messageId, threadId } = await seedThread(db());
    // Label + assignment created by owner so it exists in DB.
    const ownerApp = asOwner();
    const created = await request(ownerApp, "POST", "/", { mailboxId: MAILBOX_ID, name: "Seen" });
    const { id } = (await created.json()) as { id: string };
    await request(ownerApp, "PUT", `/${id}/threads/${threadId}`);

    // Member with READ sees it.
    const ok = await request(app, "GET", `/by-messages?id=${messageId}`);
    const okBody = (await ok.json()) as { labels: Record<string, unknown[]> };
    expect(okBody.labels[messageId]).toHaveLength(1);

    // Outsider gets an empty map (access filtered, not 403 — it's a bulk lookup).
    const blocked = await request(asOutsider(), "GET", `/by-messages?id=${messageId}`);
    const blockedBody = (await blocked.json()) as { labels: Record<string, unknown> };
    expect(blockedBody.labels[messageId]).toBeUndefined();
  });

  it("by-threads dedupes a label riding multiple messages", async () => {
    const app = asOwner();
    const { threadId } = await seedThread(db());
    const created = await request(app, "POST", "/", { mailboxId: MAILBOX_ID, name: "Multi" });
    const { id } = (await created.json()) as { id: string };
    await request(app, "PUT", `/${id}/threads/${threadId}`);

    const res = await request(app, "GET", `/by-threads?id=${threadId}`);
    const body = (await res.json()) as { labels: Record<string, unknown[]> };
    expect(body.labels[threadId]).toHaveLength(1);
  });

  it("returns empty maps for the bulk endpoints with no ids", async () => {
    const app = asOwner();
    const m = await request(app, "GET", "/by-messages");
    const t = await request(app, "GET", "/by-threads");
    expect(await m.json()).toEqual({ labels: {} });
    expect(await t.json()).toEqual({ labels: {} });
  });
});
