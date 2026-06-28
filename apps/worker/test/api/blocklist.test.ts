import { blocklist } from "@cfmail/db/schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blocklistRoutes } from "../../src/api/blocklist.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { owner, seedBase } from "../support/seed.ts";

const asOwner = () => mountApp(blocklistRoutes, owner);

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await db()
    .insert(blocklist)
    .values([
      { id: "b1", type: "email", value: "spammer@bad.test" },
      { id: "b2", type: "domain", value: "evil.test" },
    ]);
});

describe("blocklist/check", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(blocklistRoutes, null), "POST", "/check", { addresses: [] });
    expect(res.status).toBe(401);
  });

  it("returns the blocked subset by exact address and by domain", async () => {
    const res = await request(asOwner(), "POST", "/check", {
      addresses: ["SPAMMER@bad.test", "anyone@evil.test", "ok@good.test"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocked: string[] };
    expect(body.blocked.toSorted()).toEqual(["anyone@evil.test", "spammer@bad.test"]);
  });

  it("returns an empty list when nothing matches", async () => {
    const res = await request(asOwner(), "POST", "/check", { addresses: ["ok@good.test"] });
    expect(((await res.json()) as { blocked: string[] }).blocked).toEqual([]);
  });

  it("validates the body shape", async () => {
    const res = await request(asOwner(), "POST", "/check", { addresses: "nope" });
    expect(res.status).toBe(400);
  });
});
