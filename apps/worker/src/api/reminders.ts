import { message, reminder } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import type { ReminderListDto } from "@cfmail/shared/responses";
import { createReminder, updateReminder } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";
import { serializeReminder } from "./serialize.ts";

export function remindersRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    // The bell's feed: this user's live reminders (pending + fired), soonest first.
    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const rows = await db
        .select()
        .from(reminder)
        .where(and(eq(reminder.userId, user.id), inArray(reminder.status, ["pending", "fired"])))
        .orderBy(desc(reminder.status), reminder.remindAt);
      return c.json({ reminders: rows.map(serializeReminder) } satisfies ReminderListDto);
    })

    .post("/", zValidator("json", createReminder), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const body = c.req.valid("json");
      await requirePerm(db, user.id, body.mailboxId, Perm.READ);

      // Snapshot the latest message's subject so the bell + push need no join.
      const latest = await db
        .select({ subject: message.subject })
        .from(message)
        .where(eq(message.threadId, body.threadId))
        .orderBy(desc(message.createdAt))
        .limit(1);

      const id = crypto.randomUUID();
      const [row] = await db
        .insert(reminder)
        .values({
          id,
          userId: user.id,
          mailboxId: body.mailboxId,
          threadId: body.threadId,
          messageId: body.messageId ?? null,
          kind: "manual",
          remindAt: new Date(body.remindAt),
          subject: latest[0]?.subject ?? "",
          note: body.note ?? null,
        })
        .returning();
      if (!row) throw new HTTPException(500, { message: "reminder insert failed" });
      return c.json({ reminder: serializeReminder(row) }, 201);
    })

    .patch("/:id", zValidator("json", updateReminder), async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");
      await requireOwnReminder(db, id, user.id);

      const patch: Partial<typeof reminder.$inferInsert> = { updatedAt: new Date() };
      if (body.remindAt !== undefined) patch.remindAt = new Date(body.remindAt);
      if (body.note !== undefined) patch.note = body.note ?? null;
      // Rescheduling a fired reminder revives it; an explicit `done` dismisses it.
      if (body.status === "done") patch.status = "done";
      else if (body.remindAt !== undefined) patch.status = "pending";

      await db.update(reminder).set(patch).where(eq(reminder.id, id));
      return c.json({ ok: true });
    })

    .delete("/:id", async (c) => {
      const db = dbFromCtx(c);
      const user = c.get("user")!;
      const id = c.req.param("id");
      await requireOwnReminder(db, id, user.id);
      await db.delete(reminder).where(eq(reminder.id, id));
      return c.body(null, 204);
    });

  return r;
}

// Reminders are personal — ownership is the `userId` match, not mailbox RBAC.
async function requireOwnReminder(
  db: ReturnType<typeof dbFromCtx>,
  id: string,
  userId: string,
): Promise<void> {
  const row = await db.query.reminder.findFirst({
    where: eq(reminder.id, id),
    columns: { userId: true },
  });
  if (!row || row.userId !== userId) {
    throw new HTTPException(404, { message: "reminder not found" });
  }
}
