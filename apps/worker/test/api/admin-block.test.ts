import { blocklist, blockRequest, systemConfig } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminBlockRoutes } from "../../src/api/admin-block.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { admin, OWNER_ID, owner, seedBase } from "../support/seed.ts";

const asAdmin = () => mountApp(adminBlockRoutes, admin);

let reqSeq = 0;
async function seedRequest(
  overrides: Partial<typeof blockRequest.$inferInsert> = {},
): Promise<string> {
  const id = `br-${++reqSeq}`;
  await db()
    .insert(blockRequest)
    .values({
      id,
      type: "email",
      value: "spammer@bad.test",
      requestedByUserId: OWNER_ID,
      status: "pending",
      ...overrides,
    });
  return id;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("admin-block gate", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(adminBlockRoutes, null), "GET", "/entries");
    expect(res.status).toBe(401);
  });

  it("403s a non-admin caller", async () => {
    const res = await request(mountApp(adminBlockRoutes, owner), "GET", "/entries");
    expect(res.status).toBe(403);
  });
});

describe("admin-block entries", () => {
  it("lists entries newest first", async () => {
    await db()
      .insert(blocklist)
      .values([
        { id: "b1", type: "email", value: "a@bad.test", createdAt: new Date(1000) },
        { id: "b2", type: "domain", value: "evil.test", createdAt: new Date(2000) },
      ]);
    const res = await request(asAdmin(), "GET", "/entries");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { id: string }[] };
    expect(body.entries.map((e) => e.id)).toEqual(["b2", "b1"]);
  });

  it("creates an email entry", async () => {
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "email",
      value: "  BadGuy@Bad.Test  ",
      reason: "  spam  ",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.blocklist.findFirst({ where: eq(blocklist.id, id) });
    expect(row?.value).toBe("badguy@bad.test"); // trimmed + lowercased
    expect(row?.reason).toBe("spam");
    expect(row?.createdByUserId).toBe(admin.id);
  });

  it("creates a domain entry", async () => {
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "domain",
      value: "evil.test",
    });
    expect(res.status).toBe(201);
  });

  it("400s a malformed value via the validator", async () => {
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "email",
      value: "not-an-email",
    });
    expect(res.status).toBe(400);
  });

  it("refuses to block a protected domain", async () => {
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "domain",
      value: "gmail.com",
    });
    expect(res.status).toBe(400);
  });

  it("still allows blocking an individual address on a protected domain", async () => {
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "email",
      value: "spammer@gmail.com",
    });
    expect(res.status).toBe(201);
  });

  it("409s a duplicate entry", async () => {
    await request(asAdmin(), "POST", "/entries", { type: "domain", value: "evil.test" });
    const res = await request(asAdmin(), "POST", "/entries", {
      type: "domain",
      value: "evil.test",
    });
    expect(res.status).toBe(409);
  });

  it("deletes an entry", async () => {
    await db().insert(blocklist).values({ id: "b1", type: "email", value: "a@bad.test" });
    const res = await request(asAdmin(), "DELETE", "/entries/b1");
    expect(res.status).toBe(204);
    const row = await db().query.blocklist.findFirst({ where: eq(blocklist.id, "b1") });
    expect(row).toBeUndefined();
  });

  it("404s deleting an unknown entry", async () => {
    const res = await request(asAdmin(), "DELETE", "/entries/nope");
    expect(res.status).toBe(404);
  });
});

describe("admin-block requests", () => {
  it("lists requests newest first", async () => {
    await seedRequest({ createdAt: new Date(1000) });
    await seedRequest({ createdAt: new Date(2000), value: "x@bad.test" });
    const res = await request(asAdmin(), "GET", "/requests");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: { value: string; requestedByEmail: string }[] };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]?.value).toBe("x@bad.test");
    expect(body.requests[0]?.requestedByEmail).toBe(owner.email);
  });

  it("approves a request, promoting it onto the blocklist", async () => {
    const id = await seedRequest({ value: "Spammer@Bad.Test", note: "  please block  " });
    const res = await request(asAdmin(), "POST", `/requests/${id}/approve`);
    expect(res.status).toBe(200);

    const req = await db().query.blockRequest.findFirst({ where: eq(blockRequest.id, id) });
    expect(req?.status).toBe("approved");
    expect(req?.reviewedByUserId).toBe(admin.id);
    expect(req?.reviewedAt).toBeTruthy();

    const entry = await db().query.blocklist.findFirst({
      where: eq(blocklist.value, "spammer@bad.test"),
    });
    expect(entry?.type).toBe("email");
    expect(entry?.reason).toBe("please block");
  });

  it("approve is idempotent against an existing blocklist row", async () => {
    await db().insert(blocklist).values({ id: "b1", type: "email", value: "spammer@bad.test" });
    const id = await seedRequest({ value: "spammer@bad.test" });
    const res = await request(asAdmin(), "POST", `/requests/${id}/approve`);
    expect(res.status).toBe(200);
    const rows = await db()
      .select({ id: blocklist.id })
      .from(blocklist)
      .where(eq(blocklist.value, "spammer@bad.test"));
    expect(rows).toHaveLength(1);
  });

  it("404s approving an unknown request", async () => {
    const res = await request(asAdmin(), "POST", "/requests/ghost/approve");
    expect(res.status).toBe(404);
  });

  it("409s approving an already-reviewed request", async () => {
    const id = await seedRequest({ status: "denied" });
    const res = await request(asAdmin(), "POST", `/requests/${id}/approve`);
    expect(res.status).toBe(409);
  });

  it("400s approving a request for a protected domain", async () => {
    const id = await seedRequest({ type: "domain", value: "gmail.com" });
    const res = await request(asAdmin(), "POST", `/requests/${id}/approve`);
    expect(res.status).toBe(400);
  });

  it("denies a request", async () => {
    const id = await seedRequest();
    const res = await request(asAdmin(), "POST", `/requests/${id}/deny`);
    expect(res.status).toBe(200);
    const req = await db().query.blockRequest.findFirst({ where: eq(blockRequest.id, id) });
    expect(req?.status).toBe("denied");
    expect(req?.reviewedByUserId).toBe(admin.id);
  });

  it("deletes a request", async () => {
    const id = await seedRequest();
    const res = await request(asAdmin(), "DELETE", `/requests/${id}`);
    expect(res.status).toBe(204);
    const req = await db().query.blockRequest.findFirst({ where: eq(blockRequest.id, id) });
    expect(req).toBeUndefined();
  });

  it("404s denying an unknown request", async () => {
    const res = await request(asAdmin(), "POST", "/requests/nope/deny");
    expect(res.status).toBe(404);
  });

  it("404s deleting an unknown request", async () => {
    const res = await request(asAdmin(), "DELETE", "/requests/nope");
    expect(res.status).toBe(404);
  });
});

describe("admin-block protected domains", () => {
  it("returns the default whitelist when nothing is configured", async () => {
    const res = await request(asAdmin(), "GET", "/protected-domains");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: string[] };
    expect(body.domains).toContain("gmail.com");
  });

  it("replaces the whitelist and normalizes the values", async () => {
    const res = await request(asAdmin(), "PUT", "/protected-domains", {
      domains: ["Example.org", "example.org", "foo.test"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: string[] };
    expect(body.domains.toSorted()).toEqual(["example.org", "foo.test"]); // deduped + lowercased

    const cfg = await db().query.systemConfig.findFirst({
      where: eq(systemConfig.key, "protected_domains"),
    });
    expect(cfg?.value).toBeTruthy();

    // gmail.com is no longer protected, so a domain block of it now succeeds.
    const block = await request(asAdmin(), "POST", "/entries", {
      type: "domain",
      value: "gmail.com",
    });
    expect(block.status).toBe(201);
  });

  it("400s an invalid protected-domains body", async () => {
    const res = await request(asAdmin(), "PUT", "/protected-domains", {
      domains: ["not a domain"],
    });
    expect(res.status).toBe(400);
  });
});
