import { label, rule } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rulesRoutes } from "../../src/api/rules.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asOwner = () => mountApp(rulesRoutes, owner);
const asMember = () => mountApp(rulesRoutes, member);
const asOutsider = () => mountApp(rulesRoutes, outsider);

// A minimal-but-valid createRule body. Override fields per test.
function ruleBody(over: Record<string, unknown> = {}) {
  return {
    mailboxId: MAILBOX_ID,
    name: "Rule",
    conditions: [{ field: "from", op: "contains", value: "spam@evil.test" }],
    conditionMode: "all",
    actions: [{ type: "markSpam" }],
    ...over,
  };
}

async function makeRule(over: Record<string, unknown> = {}): Promise<string> {
  const res = await request(asOwner(), "POST", "/", ruleBody(over));
  const { id } = (await res.json()) as { id: string };
  return id;
}

// Insert a label directly so clone's cross-mailbox remap has something to map.
async function makeLabel(mailboxId: string, name: string): Promise<string> {
  const id = `label-${name}-${mailboxId}`;
  await db().insert(label).values({ id, mailboxId, name });
  return id;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("rules", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(rulesRoutes, null), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(401);
  });

  // ── list ──────────────────────────────────────────────────────────────────
  it("requires mailboxId on list (400)", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(400);
  });

  it("403s an outsider listing a mailbox they can't read", async () => {
    const res = await request(asOutsider(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  it("creates rules and lists them in priority then createdAt order", async () => {
    await makeRule({ name: "B", priority: 5 });
    await makeRule({ name: "A", priority: 1 });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: { name: string; priority: number }[] };
    expect(body.rules.map((r) => r.name)).toEqual(["A", "B"]);
    expect(body.rules.map((r) => r.priority)).toEqual([1, 5]);
  });

  // ── create ────────────────────────────────────────────────────────────────
  it("creates a rule (201) and auto-assigns the next priority", async () => {
    const first = await request(asOwner(), "POST", "/", ruleBody({ name: "One" }));
    expect(first.status).toBe(201);
    await request(asOwner(), "POST", "/", ruleBody({ name: "Two" }));
    const list = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    const body = (await list.json()) as { rules: { name: string; priority: number }[] };
    // First gets priority 0, second priority 1 (max + 1).
    expect(body.rules.find((r) => r.name === "One")?.priority).toBe(0);
    expect(body.rules.find((r) => r.name === "Two")?.priority).toBe(1);
  });

  it("400s an invalid create body (empty actions)", async () => {
    const res = await request(asOwner(), "POST", "/", ruleBody({ actions: [] }));
    expect(res.status).toBe(400);
  });

  it("400s an invalid create body (bad condition op)", async () => {
    const res = await request(asOwner(), "POST", "/", {
      ...ruleBody(),
      conditions: [{ field: "from", op: "bogus", value: "x" }],
    });
    expect(res.status).toBe(400);
  });

  it("409s a duplicate rule name within a mailbox", async () => {
    await makeRule({ name: "Dup" });
    const res = await request(asOwner(), "POST", "/", ruleBody({ name: "Dup" }));
    expect(res.status).toBe(409);
  });

  it("forbids a member without MANAGE from creating (403)", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const res = await request(asMember(), "POST", "/", ruleBody());
    expect(res.status).toBe(403);
  });

  it("lets a member with MANAGE create (201)", async () => {
    await grantMember(db(), Perm.READ | Perm.MANAGE);
    const res = await request(asMember(), "POST", "/", ruleBody({ name: "Member rule" }));
    expect(res.status).toBe(201);
  });

  // ── patch ─────────────────────────────────────────────────────────────────
  it("patches a rule's fields (200)", async () => {
    const id = await makeRule({ name: "Old" });
    const res = await request(asOwner(), "PATCH", `/${id}`, { name: " New ", enabled: false });
    expect(res.status).toBe(200);
    const list = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    const body = (await list.json()) as { rules: { name: string; enabled: boolean }[] };
    expect(body.rules[0]).toMatchObject({ name: "New", enabled: false });
  });

  it("treats an empty patch as a no-op (200)", async () => {
    const id = await makeRule();
    const res = await request(asOwner(), "PATCH", `/${id}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("400s an invalid patch body (empty name)", async () => {
    const id = await makeRule();
    const res = await request(asOwner(), "PATCH", `/${id}`, { name: "" });
    expect(res.status).toBe(400);
  });

  it("404s patching a missing rule", async () => {
    const res = await request(asOwner(), "PATCH", "/nope", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("409s a patch that collides with another rule's name", async () => {
    await makeRule({ name: "Taken" });
    const id = await makeRule({ name: "Free" });
    const res = await request(asOwner(), "PATCH", `/${id}`, { name: "Taken" });
    expect(res.status).toBe(409);
  });

  it("forbids a member without MANAGE from patching (403)", async () => {
    const id = await makeRule();
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "PATCH", `/${id}`, { name: "x" });
    expect(res.status).toBe(403);
  });

  // ── delete ────────────────────────────────────────────────────────────────
  it("deletes a rule (204)", async () => {
    const id = await makeRule();
    const res = await request(asOwner(), "DELETE", `/${id}`);
    expect(res.status).toBe(204);
    const list = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(((await list.json()) as { rules: unknown[] }).rules).toHaveLength(0);
  });

  it("404s deleting a missing rule", async () => {
    const res = await request(asOwner(), "DELETE", "/nope");
    expect(res.status).toBe(404);
  });

  it("forbids a member without MANAGE from deleting (403)", async () => {
    const id = await makeRule();
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "DELETE", `/${id}`);
    expect(res.status).toBe(403);
  });

  // ── clone ─────────────────────────────────────────────────────────────────
  it("clones a rule within the same mailbox (201, default name + new priority)", async () => {
    const id = await makeRule({ name: "Source", priority: 3 });
    const res = await request(asOwner(), "POST", `/${id}/clone`, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; strippedLabels: string[] };
    expect(body.strippedLabels).toEqual([]);

    const list = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    const rules = ((await list.json()) as { rules: { name: string; priority: number }[] }).rules;
    const copy = rules.find((r) => r.name === "Source (copy)");
    expect(copy).toBeDefined();
    // nextPriority = max(existing) + 1 = 4.
    expect(copy?.priority).toBe(4);
  });

  it("clones cross-mailbox, remapping labels by name and reporting strays", async () => {
    const srcLabel = await makeLabel(MAILBOX_ID, "Important");
    const stray = await makeLabel(MAILBOX_ID, "Orphan");
    // Destination has a matching "Important" label but no "Orphan".
    const dstLabel = await makeLabel(OTHER_MAILBOX_ID, "Important");
    const id = await makeRule({
      name: "Tagger",
      actions: [
        { type: "applyLabel", labelId: srcLabel },
        { type: "applyLabel", labelId: stray },
      ],
    });

    const res = await request(asOwner(), "POST", `/${id}/clone`, { mailboxId: OTHER_MAILBOX_ID });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; strippedLabels: string[] };
    expect(body.strippedLabels).toEqual(["Orphan"]);

    const cloned = await db().select().from(rule).where(eq(rule.id, body.id));
    const actions = cloned[0]?.actions ?? [];
    expect(actions).toEqual([{ type: "applyLabel", labelId: dstLabel }]);
  });

  it("404s cloning a missing rule", async () => {
    const res = await request(asOwner(), "POST", "/nope/clone", {});
    expect(res.status).toBe(404);
  });

  it("400s an invalid clone body (name too long)", async () => {
    const id = await makeRule();
    const res = await request(asOwner(), "POST", `/${id}/clone`, { name: "x".repeat(101) });
    expect(res.status).toBe(400);
  });

  it("403s cloning into a mailbox where the caller lacks MANAGE", async () => {
    // Member can READ the source mailbox but holds nothing on the target.
    await grantMember(db(), Perm.READ | Perm.MANAGE, MAILBOX_ID);
    const ownerRule = await makeRule({ name: "X" });
    const res = await request(asMember(), "POST", `/${ownerRule}/clone`, {
      mailboxId: OTHER_MAILBOX_ID,
    });
    expect(res.status).toBe(403);
  });
});
