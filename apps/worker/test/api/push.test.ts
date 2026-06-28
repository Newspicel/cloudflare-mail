import { mailboxNotify, pushSubscription } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pushRoutes } from "../../src/api/push.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { grantMember, MAILBOX_ID, member, outsider, owner, seedBase } from "../support/seed.ts";

const asOwner = () => mountApp(pushRoutes, owner);

const sub = (endpoint = "https://push.example.com/abc") => ({
  endpoint,
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
});

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("push", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(pushRoutes, null), "GET", "/key");
    expect(res.status).toBe(401);
  });

  it("returns a VAPID public key", async () => {
    const res = await request(asOwner(), "GET", "/key");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(body.publicKey.length).toBeGreaterThan(0);
  });

  it("subscribes a device and upserts on the same endpoint", async () => {
    const ok = await request(asOwner(), "POST", "/subscribe", sub());
    expect(ok.status).toBe(200);
    const again = await request(asOwner(), "POST", "/subscribe", sub());
    expect(again.status).toBe(200);

    const rows = await db()
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, owner.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a non-https / private endpoint", async () => {
    const res = await request(asOwner(), "POST", "/subscribe", sub("http://localhost/x"));
    expect(res.status).toBe(400);
  });

  it("unsubscribes only the caller's matching endpoint", async () => {
    await request(asOwner(), "POST", "/subscribe", sub());
    const res = await request(asOwner(), "POST", "/unsubscribe", {
      endpoint: "https://push.example.com/abc",
    });
    expect(res.status).toBe(204);
    const rows = await db().select().from(pushSubscription);
    expect(rows).toHaveLength(0);
  });

  it("stores per-mailbox notify config and reads it back", async () => {
    const put = await request(asOwner(), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "important",
      normal: "normal",
      low: "none",
    });
    expect(put.status).toBe(200);

    const list = await request(asOwner(), "GET", "/mailboxes");
    const body = (await list.json()) as { configs: { mailboxId: string; high: string }[] };
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0]).toMatchObject({ mailboxId: MAILBOX_ID, high: "important" });
  });

  it("all-none config drops the row (off)", async () => {
    await request(asOwner(), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "important",
      normal: "normal",
      low: "none",
    });
    const off = await request(asOwner(), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "none",
      normal: "none",
      low: "none",
    });
    expect(off.status).toBe(200);
    const rows = await db().select().from(mailboxNotify);
    expect(rows).toHaveLength(0);
  });

  it("forbids configuring a mailbox the user can't read", async () => {
    const res = await request(mountApp(pushRoutes, outsider), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "important",
      normal: "normal",
      low: "none",
    });
    expect(res.status).toBe(403);
  });

  it("lets a member with READ configure", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(mountApp(pushRoutes, member), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "important",
      normal: "normal",
      low: "none",
    });
    expect(res.status).toBe(200);
  });

  it("validates the notify config enum", async () => {
    const res = await request(asOwner(), "PUT", `/mailboxes/${MAILBOX_ID}`, {
      high: "loud",
      normal: "normal",
      low: "none",
    });
    expect(res.status).toBe(400);
  });
});
