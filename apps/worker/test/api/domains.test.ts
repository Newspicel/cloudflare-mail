import { domain } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { domainsRoutes } from "../../src/api/domains.ts";
import { getConfig, setConfig } from "../../src/config.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { admin, DOMAIN_ID, owner, seedBase } from "../support/seed.ts";

const asAdmin = () => mountApp(domainsRoutes, admin);
const asOwner = () => mountApp(domainsRoutes, owner);
const asAnon = () => mountApp(domainsRoutes, null);

async function verifyDomain(id: string): Promise<void> {
  await db().update(domain).set({ spfOk: true, dkimOk: true }).where(eq(domain.id, id));
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("domains", () => {
  // ── GET / (any signed-in user) ──────────────────────────────────────────
  it("401s an anonymous caller listing domains", async () => {
    const res = await request(asAnon(), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("lists domains for any signed-in user (non-admin allowed)", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: { name: string }[] };
    expect(body.domains.map((d) => d.name)).toEqual(["example.com"]);
  });

  // ── GET /settings (admin) ───────────────────────────────────────────────
  it("403s a non-admin reading settings", async () => {
    const res = await request(asOwner(), "GET", "/settings");
    expect(res.status).toBe(403);
  });

  it("401s an anonymous caller reading settings", async () => {
    const res = await request(asAnon(), "GET", "/settings");
    expect(res.status).toBe(401);
  });

  it("returns the configured auth-from address", async () => {
    await setConfig(db(), "auth_from_address", "noreply@example.com");
    const res = await request(asAdmin(), "GET", "/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authFromAddress: "noreply@example.com" });
  });

  // ── PUT /settings/auth-from (admin) ─────────────────────────────────────
  it("403s a non-admin setting the auth-from address", async () => {
    const res = await request(asOwner(), "PUT", "/settings/auth-from", {
      address: "a@example.com",
    });
    expect(res.status).toBe(403);
  });

  it("400s an invalid email via the validator", async () => {
    const res = await request(asAdmin(), "PUT", "/settings/auth-from", { address: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("400s when the address domain is not configured", async () => {
    const res = await request(asAdmin(), "PUT", "/settings/auth-from", {
      address: "a@missing.test",
    });
    expect(res.status).toBe(400);
  });

  it("400s when the domain is not verified for sending", async () => {
    // seedBase domain has spfOk/dkimOk false.
    const res = await request(asAdmin(), "PUT", "/settings/auth-from", {
      address: "a@example.com",
    });
    expect(res.status).toBe(400);
  });

  it("sets the auth-from address on a verified domain", async () => {
    await verifyDomain(DOMAIN_ID);
    const res = await request(asAdmin(), "PUT", "/settings/auth-from", {
      address: "Hello@Example.com",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getConfig(db(), "auth_from_address")).toBe("hello@example.com");
  });

  // ── POST / (admin) ──────────────────────────────────────────────────────
  it("401s an anonymous caller creating a domain", async () => {
    const res = await request(asAnon(), "POST", "/", { name: "new.test" });
    expect(res.status).toBe(401);
  });

  it("403s a non-admin creating a domain", async () => {
    const res = await request(asOwner(), "POST", "/", { name: "new.test" });
    expect(res.status).toBe(403);
  });

  it("400s an invalid domain name via the validator", async () => {
    const res = await request(asAdmin(), "POST", "/", { name: "nodots" });
    expect(res.status).toBe(400);
  });

  it("creates a domain (lowercased), defaulting allowedKinds to 0", async () => {
    const res = await request(asAdmin(), "POST", "/", { name: "New.TEST" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();

    const list = await request(asAdmin(), "GET", "/");
    const body = (await list.json()) as {
      domains: { id: string; name: string; allowedKinds: number }[];
    };
    const created = body.domains.find((d) => d.id === id);
    expect(created).toMatchObject({ name: "new.test", allowedKinds: 0 });
  });

  it("creates a domain with an explicit allowedKinds bitfield", async () => {
    const res = await request(asAdmin(), "POST", "/", { name: "kinds.test", allowedKinds: 5 });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = await request(asAdmin(), "GET", "/");
    const body = (await list.json()) as { domains: { id: string; allowedKinds: number }[] };
    expect(body.domains.find((d) => d.id === id)?.allowedKinds).toBe(5);
  });

  // ── PATCH /:id (admin) ──────────────────────────────────────────────────
  it("403s a non-admin patching a domain", async () => {
    const res = await request(asOwner(), "PATCH", `/${DOMAIN_ID}`, { allowedKinds: 3 });
    expect(res.status).toBe(403);
  });

  it("400s an out-of-range allowedKinds via the validator", async () => {
    const res = await request(asAdmin(), "PATCH", `/${DOMAIN_ID}`, { allowedKinds: 99 });
    expect(res.status).toBe(400);
  });

  it("patches a domain's allowedKinds", async () => {
    const res = await request(asAdmin(), "PATCH", `/${DOMAIN_ID}`, { allowedKinds: 7 });
    expect(res.status).toBe(200);
    const row = await db().query.domain.findFirst({ where: eq(domain.id, DOMAIN_ID) });
    expect(row?.allowedKinds).toBe(7);
  });

  it("no-ops an empty patch with 200", async () => {
    const res = await request(asAdmin(), "PATCH", `/${DOMAIN_ID}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s patching an unknown domain", async () => {
    const res = await request(asAdmin(), "PATCH", "/ghost", { allowedKinds: 1 });
    expect(res.status).toBe(404);
  });

  // ── DELETE /:id (admin) ─────────────────────────────────────────────────
  it("401s an anonymous caller deleting a domain", async () => {
    const res = await request(asAnon(), "DELETE", `/${DOMAIN_ID}`);
    expect(res.status).toBe(401);
  });

  it("403s a non-admin deleting a domain", async () => {
    const res = await request(asOwner(), "DELETE", `/${DOMAIN_ID}`);
    expect(res.status).toBe(403);
  });

  it("deletes a domain", async () => {
    const created = await request(asAdmin(), "POST", "/", { name: "gone.test" });
    const { id } = (await created.json()) as { id: string };
    const res = await request(asAdmin(), "DELETE", `/${id}`);
    expect(res.status).toBe(204);
    const row = await db().query.domain.findFirst({ where: eq(domain.id, id) });
    expect(row).toBeUndefined();
  });

  it("404s deleting an unknown domain", async () => {
    const res = await request(asAdmin(), "DELETE", "/ghost");
    expect(res.status).toBe(404);
  });

  // ── POST /:id/check (admin) ─────────────────────────────────────────────
  it("403s a non-admin running a domain check", async () => {
    const res = await request(asOwner(), "POST", `/${DOMAIN_ID}/check`);
    expect(res.status).toBe(403);
  });

  it("401s an anonymous caller running a domain check", async () => {
    const res = await request(asAnon(), "POST", `/${DOMAIN_ID}/check`);
    expect(res.status).toBe(401);
  });

  it("404s checking a missing domain (resolved before any DNS lookup)", async () => {
    const res = await request(asAdmin(), "POST", "/missing/check");
    expect(res.status).toBe(404);
  });
  // Note: the happy path of POST /:id/check performs live DNS-over-HTTPS lookups
  // (mail/dns.ts), so it is omitted here — it can't be asserted offline.
});
