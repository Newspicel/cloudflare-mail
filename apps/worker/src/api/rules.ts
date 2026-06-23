import type { DB } from "@cfmail/db";
import { label, type RuleAction, rule } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import type { RuleCloneResultDto, RuleDto, RuleListDto } from "@cfmail/shared/responses";
import { cloneRule, createRule, updateRule } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { requireEntityAccess, requirePerm } from "../permissions.ts";
import { buildPatch, wrapUnique } from "./util.ts";

function serializeRule(r: typeof rule.$inferSelect): RuleDto {
  return { ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

// Next free priority for a mailbox (max + 1), so a created/cloned rule sorts last.
async function nextPriority(db: DB, mailboxId: string): Promise<number> {
  const top = await db
    .select({ priority: rule.priority })
    .from(rule)
    .where(eq(rule.mailboxId, mailboxId))
    .orderBy(desc(rule.priority))
    .limit(1);
  return (top[0]?.priority ?? -1) + 1;
}

export function rulesRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  // List a mailbox's rules in evaluation order.
  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const mailboxId = c.req.query("mailboxId");
    if (!mailboxId) throw new HTTPException(400, { message: "mailboxId required" });
    await requirePerm(db, user.id, mailboxId, Perm.READ);
    const rows = await db
      .select()
      .from(rule)
      .where(eq(rule.mailboxId, mailboxId))
      .orderBy(asc(rule.priority), asc(rule.createdAt));
    return c.json({ rules: rows.map(serializeRule) } satisfies RuleListDto);
  });

  r.post("/", zValidator("json", createRule), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requirePerm(db, user.id, body.mailboxId, Perm.MANAGE);
    const id = crypto.randomUUID();
    const priority = body.priority ?? (await nextPriority(db, body.mailboxId));
    await wrapUnique(
      () =>
        db.insert(rule).values({
          id,
          mailboxId: body.mailboxId,
          createdBy: user.id,
          name: body.name.trim(),
          conditions: body.conditions,
          conditionMode: body.conditionMode,
          actions: body.actions,
          priority,
          enabled: body.enabled ?? undefined,
        }),
      "a rule with that name already exists",
    );
    return c.json({ id }, 201);
  });

  r.patch("/:id", zValidator("json", updateRule), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    await requireEntityAccess(db, user.id, rule, id, Perm.MANAGE);
    const patch = buildPatch<typeof rule.$inferInsert>(body, {
      name: (v: string) => v.trim(),
      conditions: true,
      conditionMode: true,
      actions: true,
      priority: true,
      enabled: true,
    });
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    await wrapUnique(
      () => db.update(rule).set(patch).where(eq(rule.id, id)),
      "a rule with that name already exists",
    );
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    await requireEntityAccess(db, user.id, rule, id, Perm.MANAGE);
    await db.delete(rule).where(eq(rule.id, id));
    return c.body(null, 204);
  });

  // Copy a rule, optionally into another mailbox. Labels are per-mailbox, so on a
  // cross-mailbox clone each applyLabel target is remapped by name into the
  // destination — dropped (and reported) when there's no match. moveFolder rides
  // along unchanged (folders are user-scoped) and createdBy becomes the cloner.
  r.post("/:id/clone", zValidator("json", cloneRule), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const src = await requireEntityAccess(db, user.id, rule, id, Perm.READ);
    const targetMailbox = body.mailboxId ?? src.mailboxId;
    await requirePerm(db, user.id, targetMailbox, Perm.MANAGE);

    let actions = src.actions ?? [];
    const strippedLabels: string[] = [];
    if (targetMailbox !== src.mailboxId) {
      const remap = await remapLabels(db, src.mailboxId, targetMailbox, actions);
      actions = remap.actions;
      strippedLabels.push(...remap.stripped);
    }

    const newId = crypto.randomUUID();
    const name = (body.name ?? `${src.name} (copy)`).trim();
    const priority = await nextPriority(db, targetMailbox);
    await wrapUnique(
      () =>
        db.insert(rule).values({
          id: newId,
          mailboxId: targetMailbox,
          createdBy: user.id,
          name,
          conditions: src.conditions,
          conditionMode: src.conditionMode,
          actions,
          priority,
          enabled: src.enabled,
        }),
      "a rule with that name already exists",
    );
    return c.json({ id: newId, strippedLabels } satisfies RuleCloneResultDto, 201);
  });

  return r;
}

// Translate applyLabel actions from a source mailbox to a destination by label
// name; actions whose label has no destination match are removed and their names
// returned for the UI to surface.
async function remapLabels(
  db: DB,
  fromMailbox: string,
  toMailbox: string,
  actions: RuleAction[],
): Promise<{ actions: RuleAction[]; stripped: string[] }> {
  const labelIds = actions.flatMap((a) => (a.type === "applyLabel" ? [a.labelId] : []));
  if (labelIds.length === 0) return { actions, stripped: [] };

  const srcLabels = await db
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(and(eq(label.mailboxId, fromMailbox), inArray(label.id, labelIds)));
  const srcNameById = new Map(srcLabels.map((l) => [l.id, l.name]));

  const names = [...new Set(srcLabels.map((l) => l.name))];
  const dstLabels = names.length
    ? await db
        .select({ id: label.id, name: label.name })
        .from(label)
        .where(and(eq(label.mailboxId, toMailbox), inArray(label.name, names)))
    : [];
  const dstIdByName = new Map(dstLabels.map((l) => [l.name, l.id]));

  const stripped: string[] = [];
  const out = actions.flatMap((a): RuleAction[] => {
    if (a.type !== "applyLabel") return [a];
    const name = srcNameById.get(a.labelId);
    const dstId = name ? dstIdByName.get(name) : undefined;
    if (dstId) return [{ type: "applyLabel", labelId: dstId }];
    if (name) stripped.push(name);
    return [];
  });
  return { actions: out, stripped };
}
