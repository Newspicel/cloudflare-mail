import { domain, domainGrant, mailbox } from "@cfmail/db/schema";
import { MailboxKind } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempRoutes } from "../../src/api/temp.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { admin, DOMAIN_ID, MEMBER_ID, member, OWNER_ID, owner, seedBase } from "../support/seed.ts";

const asOwner = () => mountApp(tempRoutes, owner);

// Flip TEMP on for the seeded domain.
function allowTemp(kinds = MailboxKind.TEMP) {
  return db().update(domain).set({ allowedKinds: kinds }).where(eq(domain.id, DOMAIN_ID));
}

function grantDomain(userId: string, kinds = MailboxKind.TEMP, domainId = DOMAIN_ID) {
  return db().insert(domainGrant).values({ domainId, userId, allowedKinds: kinds });
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("temp", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(tempRoutes, null), "GET", "/domains");
    expect(res.status).toBe(401);
  });

  describe("GET /domains", () => {
    it("hides temp domains from a non-admin without a grant", async () => {
      await allowTemp();
      const res = await request(asOwner(), "GET", "/domains");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { domains: unknown[] };
      expect(body.domains).toHaveLength(0);
    });

    it("shows a temp domain to a non-admin with a matching grant", async () => {
      await allowTemp();
      await grantDomain(MEMBER_ID);
      const res = await request(mountApp(tempRoutes, member), "GET", "/domains");
      const body = (await res.json()) as { domains: { id: string; name: string }[] };
      expect(body.domains).toHaveLength(1);
      expect(body.domains[0]).toMatchObject({ id: DOMAIN_ID, name: "example.com" });
    });

    it("shows all temp-enabled domains to an admin without grants", async () => {
      await allowTemp();
      const res = await request(mountApp(tempRoutes, admin), "GET", "/domains");
      const body = (await res.json()) as { domains: { id: string }[] };
      expect(body.domains.map((d) => d.id)).toEqual([DOMAIN_ID]);
    });

    it("excludes a domain that doesn't allow temp mailboxes", async () => {
      await allowTemp(MailboxKind.PERSONAL);
      const res = await request(mountApp(tempRoutes, admin), "GET", "/domains");
      const body = (await res.json()) as { domains: unknown[] };
      expect(body.domains).toHaveLength(0);
    });
  });

  describe("POST /", () => {
    it("400s a body missing domainId", async () => {
      const res = await request(asOwner(), "POST", "/", { ttlSeconds: 3600 });
      expect(res.status).toBe(400);
    });

    it("creates a temp mailbox for an admin", async () => {
      await allowTemp();
      const res = await request(mountApp(tempRoutes, admin), "POST", "/", {
        domainId: DOMAIN_ID,
        displayName: "Throwaway",
        ttlSeconds: 600,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; address: string; expiresAt: string };
      expect(body.address).toMatch(/@example\.com$/);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, body.id) });
      expect(row?.type).toBe("temp");
      expect(row?.ownerUserId).toBe(admin.id);
    });

    it("creates a temp mailbox for a non-admin with a grant", async () => {
      await allowTemp();
      await grantDomain(OWNER_ID);
      const res = await request(asOwner(), "POST", "/", { domainId: DOMAIN_ID });
      expect(res.status).toBe(201);
    });

    it("403s a non-admin without a grant", async () => {
      await allowTemp();
      const res = await request(asOwner(), "POST", "/", { domainId: DOMAIN_ID });
      expect(res.status).toBe(403);
    });

    it("400s when the domain doesn't allow temp mailboxes", async () => {
      await allowTemp(MailboxKind.PERSONAL);
      const res = await request(mountApp(tempRoutes, admin), "POST", "/", { domainId: DOMAIN_ID });
      expect(res.status).toBe(400);
    });

    it("400s an unknown domain", async () => {
      const res = await request(mountApp(tempRoutes, admin), "POST", "/", {
        domainId: "no-such-domain",
      });
      expect(res.status).toBe(400);
    });
  });
});
