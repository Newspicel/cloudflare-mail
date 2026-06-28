import { contactKey, domain, mailbox, mailboxInvite, mailboxMember } from "@cfmail/db/schema";
import { MailboxKind, Perm } from "@cfmail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailboxesRoutes } from "../../src/api/mailboxes.ts";
import { generateKeypair } from "../../src/mail/pgp.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  ADMIN_ID,
  admin,
  DOMAIN_ID,
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  OUTSIDER_ID,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedContactKey,
} from "../support/seed.ts";

const asOwner = () => mountApp(mailboxesRoutes, owner);
const asMember = () => mountApp(mailboxesRoutes, member);
const asOutsider = () => mountApp(mailboxesRoutes, outsider);
const asAdmin = () => mountApp(mailboxesRoutes, admin);
const asAnon = () => mountApp(mailboxesRoutes, null);

// ── Local seed helpers (kept in-file per harness convention) ────────────────

const SERVICE_MAILBOX_ID = "mailbox-service";
const TEMP_MAILBOX_ID = "mailbox-temp";

async function insertMailbox(
  id: string,
  overrides: Partial<typeof mailbox.$inferInsert> = {},
): Promise<void> {
  await db()
    .insert(mailbox)
    .values({
      id,
      domainId: DOMAIN_ID,
      localPart: id,
      type: "group",
      ownerUserId: OWNER_ID,
      ...overrides,
    });
}

async function setDomainKinds(kinds: number): Promise<void> {
  await db().update(domain).set({ allowedKinds: kinds }).where(eq(domain.id, DOMAIN_ID));
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("GET /", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("lists owned mailboxes with owner role and full perms", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: { id: string; role: string; perms: number; address: string }[];
    };
    expect(body.mailboxes).toHaveLength(2);
    for (const m of body.mailboxes) {
      expect(m.role).toBe("owner");
      expect(m.perms).toBe(7);
    }
    expect(body.mailboxes.map((m) => m.address)).toContain("team@example.com");
  });

  it("shows a shared mailbox with member role and granted perms", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { id: string; role: string; perms: number }[] };
    expect(body.mailboxes).toHaveLength(1);
    expect(body.mailboxes[0]).toMatchObject({ id: MAILBOX_ID, role: "member", perms: Perm.READ });
  });

  it("hides service mailboxes from the listing", async () => {
    await insertMailbox(SERVICE_MAILBOX_ID, { type: "service" });
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as { mailboxes: { id: string }[] };
    expect(body.mailboxes.map((m) => m.id)).not.toContain(SERVICE_MAILBOX_ID);
  });

  it("returns an empty list for a user with no mailboxes", async () => {
    const res = await request(asOutsider(), "GET", "/");
    const body = (await res.json()) as { mailboxes: unknown[] };
    expect(body.mailboxes).toHaveLength(0);
  });
});

describe("POST /", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", "/", {});
    expect(res.status).toBe(401);
  });

  it("400s an invalid body (bad local part)", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "bad+part",
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("400s creating a service mailbox (admin-only path)", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "svc",
      type: "service",
    });
    expect(res.status).toBe(400);
  });

  it("400s when the domain does not allow the kind", async () => {
    // allowedKinds defaults to 0 → no kind permitted.
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "nope",
      type: "personal",
    });
    expect(res.status).toBe(400);
  });

  it("403s a non-admin without a domain grant", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const res = await request(asOutsider(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "mine",
      type: "personal",
    });
    expect(res.status).toBe(403);
  });

  it("creates a mailbox as admin when the domain allows the kind", async () => {
    await setDomainKinds(MailboxKind.PERSONAL);
    const res = await request(asAdmin(), "POST", "/", {
      domainId: DOMAIN_ID,
      localPart: "MixedCase",
      type: "personal",
      displayName: "Mine",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) });
    expect(row?.localPart).toBe("mixedcase"); // lowercased
    expect(row?.ownerUserId).toBe(ADMIN_ID);
  });
});

describe("GET /:id/settings", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(401);
  });

  it("403s an outsider", async () => {
    const res = await request(asOutsider(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(403);
  });

  it("403s a missing mailbox (requirePerm runs before the row lookup)", async () => {
    const res = await request(asOwner(), "GET", "/does-not-exist/settings");
    expect(res.status).toBe(403);
  });

  it("returns settings to the owner and never leaks the private key", async () => {
    await db()
      .update(mailbox)
      .set({ pgpPublicKey: "PUB", pgpPrivateKeyWrapped: "SECRET", pgpFingerprint: "FPR" })
      .where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("Wrapped");
    const body = JSON.parse(text) as { pgpConfigured: boolean; pgpPublicKey: string };
    expect(body.pgpConfigured).toBe(true);
    expect(body.pgpPublicKey).toBe("PUB");
  });

  it("lets a member with READ view settings", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/settings`);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /:id/settings", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "PATCH", `/${MAILBOX_ID}/settings`, { displayName: "x" });
    expect(res.status).toBe(401);
  });

  it("400s an invalid body (bad spam filter level)", async () => {
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, {
      spamFilter: "loud",
    });
    expect(res.status).toBe(400);
  });

  it("403s a member with READ only", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/settings`, { displayName: "x" });
    expect(res.status).toBe(403);
  });

  it("updates identity fields for a member with MANAGE", async () => {
    await grantMember(db(), Perm.READ | Perm.MANAGE);
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/settings`, {
      displayName: "  Team Inbox  ",
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.displayName).toBe("Team Inbox"); // trimmed
  });

  it("400s a temp mailbox", async () => {
    await insertMailbox(TEMP_MAILBOX_ID, { type: "temp" });
    const res = await request(asOwner(), "PATCH", `/${TEMP_MAILBOX_ID}/settings`, {
      displayName: "x",
    });
    expect(res.status).toBe(400);
  });

  it("400s enabling a pgp mode without a keypair", async () => {
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, { pgpMode: "sign" });
    expect(res.status).toBe(400);
  });

  it("allows a pgp mode once a key exists", async () => {
    await db().update(mailbox).set({ pgpPublicKey: "PUB" }).where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/settings`, { pgpMode: "sign" });
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpMode).toBe("sign");
  });
});

describe("PGP key management", () => {
  it("401s generate for an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(401);
  });

  it("403s generate for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(403);
  });

  it("400s generate on a temp mailbox", async () => {
    await insertMailbox(TEMP_MAILBOX_ID, { type: "temp" });
    const res = await request(asOwner(), "POST", `/${TEMP_MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(400);
  });

  it("generates a keypair, persists it wrapped, and returns only public material", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/generate`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { fingerprint: string; publicKey: string };
    expect(body.fingerprint.length).toBeGreaterThan(0);
    expect(body.publicKey).toContain("BEGIN PGP PUBLIC KEY");
    expect(text).not.toContain("PRIVATE KEY");

    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpPublicKey).toBeTruthy();
    expect(row?.pgpPrivateKeyWrapped).toBeTruthy();
    expect(row?.pgpPassphraseWrapped).toBeTruthy();
    expect(row?.pgpFingerprint).toBe(body.fingerprint);
  });

  it("400s import of an invalid private key", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/import`, {
      privateKey: "not a real key",
    });
    expect(res.status).toBe(400);
  });

  it("400s import with a missing body", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/pgp/import`, {});
    expect(res.status).toBe(400);
  });

  it("403s import for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/pgp/import`, {
      privateKey: "x",
    });
    expect(res.status).toBe(403);
  });

  it("deletes the keypair and disables pgp", async () => {
    await db()
      .update(mailbox)
      .set({
        pgpMode: "sign",
        pgpPublicKey: "PUB",
        pgpPrivateKeyWrapped: "SECRET",
        pgpFingerprint: "FPR",
      })
      .where(eq(mailbox.id, MAILBOX_ID));
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/pgp`);
    expect(res.status).toBe(200);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, MAILBOX_ID) });
    expect(row?.pgpMode).toBe("off");
    expect(row?.pgpPublicKey).toBeNull();
    expect(row?.pgpPrivateKeyWrapped).toBeNull();
    expect(row?.pgpFingerprint).toBeNull();
  });

  it("403s delete for a member without MANAGE", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/pgp`);
    expect(res.status).toBe(403);
  });
});

describe("contact keys", () => {
  it("401s listing for an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(401);
  });

  it("403s an outsider listing", async () => {
    const res = await request(asOutsider(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(403);
  });

  it("lists contact keys for a member with READ", async () => {
    await grantMember(db(), Perm.READ);
    await seedContactKey(db(), MAILBOX_ID, "alice@elsewhere.test");
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/contacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { email: string; fingerprint: string }[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.email).toBe("alice@elsewhere.test");
  });

  it("400s adding an invalid public key", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {
      publicKey: "garbage",
    });
    expect(res.status).toBe(400);
  });

  it("400s adding with no public key (validator)", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {});
    expect(res.status).toBe(400);
  });

  it("403s a member without MANAGE adding a key", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/contacts`, { publicKey: "x" });
    expect(res.status).toBe(403);
  });

  it("adds a contact key from valid armored material", async () => {
    const km = await generateKeypair("Contact", "contact@elsewhere.test");
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/contacts`, {
      publicKey: km.publicArmored,
    });
    expect(res.status).toBe(201);
    const row = await db().query.contactKey.findFirst({
      where: eq(contactKey.mailboxId, MAILBOX_ID),
    });
    expect(row?.email).toBe("contact@elsewhere.test");
    expect(row?.verified).toBe(true);
    expect(row?.source).toBe("import");
  });

  it("verifies and unverifies a contact key", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "bob@elsewhere.test", { verified: false });
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: true,
    });
    expect(res.status).toBe(200);
    const row = await db().query.contactKey.findFirst({ where: eq(contactKey.id, id) });
    expect(row?.verified).toBe(true);
  });

  it("400s verify with a bad body", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "carol@elsewhere.test");
    const res = await request(asOwner(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: "yes",
    });
    expect(res.status).toBe(400);
  });

  it("403s a member without MANAGE verifying", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedContactKey(db(), MAILBOX_ID, "dan@elsewhere.test");
    const res = await request(asMember(), "PATCH", `/${MAILBOX_ID}/contacts/${id}`, {
      verified: true,
    });
    expect(res.status).toBe(403);
  });

  it("deletes a contact key", async () => {
    const id = await seedContactKey(db(), MAILBOX_ID, "erin@elsewhere.test");
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/contacts/${id}`);
    expect(res.status).toBe(200);
    const row = await db().query.contactKey.findFirst({ where: eq(contactKey.id, id) });
    expect(row).toBeUndefined();
  });

  it("403s a member without MANAGE deleting", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedContactKey(db(), MAILBOX_ID, "fred@elsewhere.test");
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/contacts/${id}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /:id/import", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", `/${MAILBOX_ID}/import`, "raw");
    expect(res.status).toBe(401);
  });

  it("403s a member with READ only (needs WRITE)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/import`, "raw");
    expect(res.status).toBe(403);
  });

  it("400s an empty body", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/import`);
    expect(res.status).toBe(400);
  });

  it("400s importing into a service mailbox", async () => {
    await insertMailbox(SERVICE_MAILBOX_ID, { type: "service" });
    const res = await request(asOwner(), "POST", `/${SERVICE_MAILBOX_ID}/import`, "raw bytes");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:id", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "DELETE", `/${MAILBOX_ID}`);
    expect(res.status).toBe(401);
  });

  it("404s a missing mailbox", async () => {
    const res = await request(asOwner(), "DELETE", "/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("403s a member with MANAGE (owner-only route)", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE | Perm.MANAGE);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("lets the owner delete their mailbox", async () => {
    const res = await request(asOwner(), "DELETE", `/${OTHER_MAILBOX_ID}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailbox.findFirst({ where: eq(mailbox.id, OTHER_MAILBOX_ID) });
    expect(row).toBeUndefined();
  });
});

describe("members", () => {
  it("401s listing members for an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(401);
  });

  it("403s a member with READ listing members (needs MANAGE)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(403);
  });

  it("lists members for the owner", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asOwner(), "GET", `/${MAILBOX_ID}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { userId: string; email: string }[] };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ userId: member.id, email: member.email });
  });

  it("400s granting with a missing body field", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
    });
    expect(res.status).toBe(400);
  });

  it("404s granting to an unknown user", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: "ghost",
      read: true,
    });
    expect(res.status).toBe(404);
  });

  it("403s a member without MANAGE granting", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: OUTSIDER_ID,
      read: true,
    });
    expect(res.status).toBe(403);
  });

  it("grants a member with the requested perms", async () => {
    const res = await request(asOwner(), "POST", `/${MAILBOX_ID}/members`, {
      mailboxId: MAILBOX_ID,
      userId: OUTSIDER_ID,
      read: true,
      write: true,
    });
    expect(res.status).toBe(200);
    const row = await db().query.mailboxMember.findFirst({
      where: and(eq(mailboxMember.mailboxId, MAILBOX_ID), eq(mailboxMember.userId, OUTSIDER_ID)),
    });
    expect(row?.perms).toBe(Perm.READ | Perm.WRITE);
  });

  it("removes a member", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/members/${member.id}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailboxMember.findFirst({
      where: and(eq(mailboxMember.mailboxId, MAILBOX_ID), eq(mailboxMember.userId, member.id)),
    });
    expect(row).toBeUndefined();
  });

  it("403s a member without MANAGE removing", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/members/${OUTSIDER_ID}`);
    expect(res.status).toBe(403);
  });
});

async function seedInvite(): Promise<string> {
  const id = "invite-1";
  await db().insert(mailboxInvite).values({
    id,
    mailboxId: MAILBOX_ID,
    email: "invitee@example.com",
    perms: Perm.READ,
    invitedByUserId: OWNER_ID,
  });
  return id;
}

describe("invites", () => {
  it("401s listing invites for an anonymous caller", async () => {
    const res = await request(asAnon(), "GET", `/${MAILBOX_ID}/invites`);
    expect(res.status).toBe(401);
  });

  it("403s a member with READ listing invites", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "GET", `/${MAILBOX_ID}/invites`);
    expect(res.status).toBe(403);
  });

  it("lists invites for the owner", async () => {
    await seedInvite();
    const res = await request(asOwner(), "GET", `/${MAILBOX_ID}/invites`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: { email: string }[] };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]?.email).toBe("invitee@example.com");
  });

  it("deletes an invite", async () => {
    const id = await seedInvite();
    const res = await request(asOwner(), "DELETE", `/${MAILBOX_ID}/invites/${id}`);
    expect(res.status).toBe(204);
    const row = await db().query.mailboxInvite.findFirst({ where: eq(mailboxInvite.id, id) });
    expect(row).toBeUndefined();
  });

  it("403s a member without MANAGE deleting an invite", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedInvite();
    const res = await request(asMember(), "DELETE", `/${MAILBOX_ID}/invites/${id}`);
    expect(res.status).toBe(403);
  });
});
