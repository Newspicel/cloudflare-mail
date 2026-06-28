import { domain, mailbox, redirect } from "@cfmail/db/schema";
import { ALL_MAILBOX_KINDS } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminRoutes } from "../../src/api/admin.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  admin,
  DOMAIN_ID,
  MAILBOX_ID,
  MEMBER_ID,
  OTHER_MAILBOX_ID,
  OWNER_ID,
  owner,
  seedBase,
} from "../support/seed.ts";

const asAdmin = () => mountApp(adminRoutes, admin);

// Let the seeded domain host every mailbox kind so create paths aren't blocked
// by domain.allowedKinds (admin still goes through authorizeMailboxCreate).
async function allowAllKinds(): Promise<void> {
  await db()
    .update(domain)
    .set({ allowedKinds: ALL_MAILBOX_KINDS })
    .where(eq(domain.id, DOMAIN_ID));
}

// A key-driven service mailbox, inserted directly so list/rotate/patch/delete
// have something to act on.
const SERVICE_ID = "mailbox-svc";
async function seedService(): Promise<void> {
  await db().insert(mailbox).values({
    id: SERVICE_ID,
    domainId: DOMAIN_ID,
    localPart: "svc",
    type: "service",
    ownerUserId: OWNER_ID,
    serviceMode: "duplex",
    serviceKeyHash: "deadbeef",
  });
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("admin gate", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(adminRoutes, null), "GET", "/mailboxes");
    expect(res.status).toBe(401);
  });

  it("403s a non-admin caller", async () => {
    const res = await request(mountApp(adminRoutes, owner), "GET", "/mailboxes");
    expect(res.status).toBe(403);
  });
});

describe("admin mailboxes", () => {
  it("lists non-service, non-delete-pending mailboxes", async () => {
    await seedService();
    await db()
      .update(mailbox)
      .set({ pendingPurge: "delete" })
      .where(eq(mailbox.id, OTHER_MAILBOX_ID));

    const res = await request(asAdmin(), "GET", "/mailboxes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailboxes: { id: string; address: string }[] };
    expect(body.mailboxes.map((m) => m.id)).toEqual([MAILBOX_ID]);
    expect(body.mailboxes[0]?.address).toBe("team@example.com");
  });

  it("creates a mailbox for an existing owner", async () => {
    await allowAllKinds();
    const res = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      localPart: "Fresh",
      ownerUserId: MEMBER_ID,
      type: "personal",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) });
    expect(row?.localPart).toBe("fresh"); // lowercased
    expect(row?.ownerUserId).toBe(MEMBER_ID);
  });

  it("400s an invalid create body", async () => {
    const res = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      ownerUserId: MEMBER_ID,
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("400s creating for an unknown owner", async () => {
    await allowAllKinds();
    const res = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      localPart: "nope",
      ownerUserId: "ghost",
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("400s creating temp / service via the generic endpoint", async () => {
    await allowAllKinds();
    const temp = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      localPart: "t",
      ownerUserId: OWNER_ID,
      type: "temp",
    });
    expect(temp.status).toBe(400);
    const svc = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      localPart: "s",
      ownerUserId: OWNER_ID,
      type: "service",
    });
    expect(svc.status).toBe(400);
  });

  it("400s when the domain forbids the kind", async () => {
    // seeded domain has allowedKinds = 0
    const res = await request(asAdmin(), "POST", "/mailboxes", {
      domainId: DOMAIN_ID,
      localPart: "blocked",
      ownerUserId: OWNER_ID,
      type: "personal",
    });
    expect(res.status).toBe(400);
  });
});

describe("admin mailbox migrate", () => {
  it("re-owns a mailbox", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}`, {
      ownerUserId: MEMBER_ID,
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.ownerUserId).toBe(MEMBER_ID);
  });

  it("switches a group mailbox to personal", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}`, { type: "personal" });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.type).toBe("personal");
  });

  it("404s an unknown mailbox", async () => {
    const res = await request(asAdmin(), "PATCH", "/mailboxes/ghost", { type: "personal" });
    expect(res.status).toBe(404);
  });

  it("400s an empty migrate body", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}`, {});
    expect(res.status).toBe(400);
  });

  it("400s migrating an unknown owner", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}`, {
      ownerUserId: "ghost",
    });
    expect(res.status).toBe(400);
  });
});

describe("admin mailbox settings", () => {
  it("returns full settings for a mailbox", async () => {
    const res = await request(asAdmin(), "GET", `/mailboxes/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; spamFilter: string; spamUsage: unknown };
    expect(body.id).toBe(MAILBOX_ID);
    expect(body.spamFilter).toBe("standard");
    expect(body.spamUsage).toBeNull();
  });

  it("404s settings for an unknown mailbox", async () => {
    const res = await request(asAdmin(), "GET", "/mailboxes/ghost/settings");
    expect(res.status).toBe(404);
  });

  it("patches the spam filter and display name", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}/settings`, {
      displayName: "  Team  ",
      spamFilter: "ai",
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.displayName).toBe("Team");
    expect(row?.spamFilter).toBe("ai");
  });

  it("400s an invalid settings body", async () => {
    const res = await request(asAdmin(), "PATCH", `/mailboxes/${MAILBOX_ID}/settings`, {
      spamFilter: "bogus",
    });
    expect(res.status).toBe(400);
  });

  it("404s settings patch for an unknown mailbox", async () => {
    const res = await request(asAdmin(), "PATCH", "/mailboxes/ghost/settings", {
      spamFilter: "ai",
    });
    expect(res.status).toBe(404);
  });
});

describe("admin mailbox delete / empty", () => {
  it("marks a mailbox for delete-purge", async () => {
    const res = await request(asAdmin(), "DELETE", `/mailboxes/${MAILBOX_ID}`, {});
    expect(res.status).toBe(204);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pendingPurge).toBe("delete");
  });

  it("leaves a redirect at the old address when asked", async () => {
    const res = await request(asAdmin(), "DELETE", `/mailboxes/${MAILBOX_ID}`, {
      redirectToMailboxId: OTHER_MAILBOX_ID,
    });
    expect(res.status).toBe(204);
    const rd = await db().query.redirect.findFirst({
      where: eq(redirect.targetMailboxId, OTHER_MAILBOX_ID),
    });
    expect(rd?.localPart).toBe("team");
  });

  it("400s redirecting a mailbox to itself", async () => {
    const res = await request(asAdmin(), "DELETE", `/mailboxes/${MAILBOX_ID}`, {
      redirectToMailboxId: MAILBOX_ID,
    });
    expect(res.status).toBe(400);
  });

  it("400s redirecting to an unknown target", async () => {
    const res = await request(asAdmin(), "DELETE", `/mailboxes/${MAILBOX_ID}`, {
      redirectToMailboxId: "ghost",
    });
    expect(res.status).toBe(400);
  });

  it("404s deleting an unknown mailbox", async () => {
    const res = await request(asAdmin(), "DELETE", "/mailboxes/ghost", {});
    expect(res.status).toBe(404);
  });

  it("marks a mailbox for empty-purge", async () => {
    const res = await request(asAdmin(), "POST", `/mailboxes/${MAILBOX_ID}/empty`);
    expect(res.status).toBe(204);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pendingPurge).toBe("empty");
  });

  it("404s emptying an unknown mailbox", async () => {
    const res = await request(asAdmin(), "POST", "/mailboxes/ghost/empty");
    expect(res.status).toBe(404);
  });
});

describe("admin service mailboxes", () => {
  it("lists service mailboxes with stats", async () => {
    await seedService();
    const res = await request(asAdmin(), "GET", "/service");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: { id: string; address: string; hasKey: boolean; messageCount: number }[];
    };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({
      id: SERVICE_ID,
      address: "svc@example.com",
      hasKey: true,
      messageCount: 0,
    });
  });

  it("creates a service mailbox and returns the key once", async () => {
    await allowAllKinds();
    const res = await request(asAdmin(), "POST", "/service", {
      domainId: DOMAIN_ID,
      localPart: "api",
      mode: "send",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; key: string };
    expect(body.key).toBeTruthy();
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, body.id) });
    expect(row?.type).toBe("service");
    expect(row?.serviceMode).toBe("send");
    expect(row?.serviceKeyHash).toBeTruthy();
    expect(row?.spamFilter).toBe("off");
  });

  it("400s an invalid service create body", async () => {
    const res = await request(asAdmin(), "POST", "/service", { domainId: DOMAIN_ID });
    expect(res.status).toBe(400);
  });

  it("rotates a service key", async () => {
    await seedService();
    const res = await request(asAdmin(), "POST", `/service/${SERVICE_ID}/rotate`);
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    expect(key).toBeTruthy();
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, SERVICE_ID) });
    expect(row?.serviceKeyHash).not.toBe("deadbeef");
  });

  it("404s rotating an unknown service mailbox", async () => {
    const res = await request(asAdmin(), "POST", "/service/ghost/rotate");
    expect(res.status).toBe(404);
  });

  it("patches a service mailbox", async () => {
    await seedService();
    const res = await request(asAdmin(), "PATCH", `/service/${SERVICE_ID}`, {
      displayName: "Service",
      mode: "send",
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, SERVICE_ID) });
    expect(row?.displayName).toBe("Service");
    expect(row?.serviceMode).toBe("send");
  });

  it("404s patching an unknown service mailbox", async () => {
    const res = await request(asAdmin(), "PATCH", "/service/ghost", { mode: "send" });
    expect(res.status).toBe(404);
  });

  it("deletes a service mailbox", async () => {
    await seedService();
    const res = await request(asAdmin(), "DELETE", `/service/${SERVICE_ID}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, SERVICE_ID) });
    expect(row).toBeUndefined();
  });

  it("404s deleting an unknown service mailbox", async () => {
    const res = await request(asAdmin(), "DELETE", "/service/ghost");
    expect(res.status).toBe(404);
  });
});

async function seedRedirect(localPart = "alias", target = MAILBOX_ID): Promise<string> {
  const id = `rd-${localPart}`;
  await db()
    .insert(redirect)
    .values({ id, domainId: DOMAIN_ID, localPart, targetMailboxId: target });
  return id;
}

describe("admin redirects", () => {
  it("lists redirects with resolved addresses", async () => {
    await seedRedirect("alias");
    const res = await request(asAdmin(), "GET", "/redirects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirects: { address: string; targetAddress: string }[];
    };
    expect(body.redirects[0]).toMatchObject({
      address: "alias@example.com",
      targetAddress: "team@example.com",
    });
  });

  it("creates a redirect", async () => {
    const res = await request(asAdmin(), "POST", "/redirects", {
      domainId: DOMAIN_ID,
      localPart: "news",
      targetMailboxId: MAILBOX_ID,
    });
    expect(res.status).toBe(201);
    const rd = await db().query.redirect.findFirst({
      where: eq(redirect.localPart, "news"),
    });
    expect(rd?.targetMailboxId).toBe(MAILBOX_ID);
  });

  it("400s an invalid redirect body", async () => {
    const res = await request(asAdmin(), "POST", "/redirects", {
      domainId: DOMAIN_ID,
      localPart: "news",
    });
    expect(res.status).toBe(400);
  });

  it("400s a redirect to an unknown target", async () => {
    const res = await request(asAdmin(), "POST", "/redirects", {
      domainId: DOMAIN_ID,
      localPart: "news",
      targetMailboxId: "ghost",
    });
    expect(res.status).toBe(400);
  });

  it("400s a redirect targeting a service mailbox", async () => {
    await seedService();
    const res = await request(asAdmin(), "POST", "/redirects", {
      domainId: DOMAIN_ID,
      localPart: "news",
      targetMailboxId: SERVICE_ID,
    });
    expect(res.status).toBe(400);
  });

  it("409s a redirect clashing with an existing mailbox address", async () => {
    const res = await request(asAdmin(), "POST", "/redirects", {
      domainId: DOMAIN_ID,
      localPart: "team", // MAILBOX_ID already owns this
      targetMailboxId: OTHER_MAILBOX_ID,
    });
    expect(res.status).toBe(409);
  });

  it("re-points a redirect", async () => {
    const id = await seedRedirect("alias");
    const res = await request(asAdmin(), "PATCH", `/redirects/${id}`, {
      targetMailboxId: OTHER_MAILBOX_ID,
    });
    expect(res.status).toBe(200);
    const rd = await db().query.redirect.findFirst({ where: eq(redirect.id, id) });
    expect(rd?.targetMailboxId).toBe(OTHER_MAILBOX_ID);
  });

  it("400s re-pointing to an unknown target", async () => {
    const id = await seedRedirect("alias");
    const res = await request(asAdmin(), "PATCH", `/redirects/${id}`, { targetMailboxId: "ghost" });
    expect(res.status).toBe(400);
  });

  it("404s re-pointing an unknown redirect to a valid target", async () => {
    const res = await request(asAdmin(), "PATCH", "/redirects/ghost", {
      targetMailboxId: MAILBOX_ID,
    });
    expect(res.status).toBe(404);
  });

  it("404s deleting an unknown redirect", async () => {
    const res = await request(asAdmin(), "DELETE", "/redirects/ghost");
    expect(res.status).toBe(404);
  });

  it("deletes a redirect", async () => {
    const id = await seedRedirect("alias");
    const res = await request(asAdmin(), "DELETE", `/redirects/${id}`);
    expect(res.status).toBe(204);
    const rd = await db().query.redirect.findFirst({ where: eq(redirect.id, id) });
    expect(rd).toBeUndefined();
  });
});
