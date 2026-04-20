import { message } from "@cfmail/db/schema";
import { Flag, setFlag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { sendMessage } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { sendFromMailbox } from "../mail/send.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

const patchSchema = z.object({
  seen: z.boolean().optional(),
  starred: z.boolean().optional(),
  trash: z.boolean().optional(),
});

export function messagesRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.post("/send", zValidator("json", sendMessage), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const body = c.req.valid("json");
    await requirePerm(db, user.id, body.mailboxId, Perm.WRITE);
    const result = await sendFromMailbox(c.env, db, user.id, body);
    return c.json(result, 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const patch = c.req.valid("json");

    const msg = await db.query.message.findFirst({
      where: eq(message.id, id),
      columns: { mailboxId: true, flags: true },
    });
    if (!msg) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, msg.mailboxId, Perm.READ);

    let flags = msg.flags;
    if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
    if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
    if (patch.trash !== undefined) flags = setFlag(flags, Flag.TRASH, patch.trash);

    await db.update(message).set({ flags }).where(eq(message.id, id));
    return c.json({ flags });
  });

  r.get("/:id/raw", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const msg = await db.query.message.findFirst({
      where: eq(message.id, id),
      columns: { mailboxId: true, rawR2Key: true },
    });
    if (!msg?.rawR2Key) throw new HTTPException(404, { message: "not found" });
    await requirePerm(db, user.id, msg.mailboxId, Perm.READ);
    const obj = await c.env.BLOBS.get(msg.rawR2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    return new Response(obj.body, {
      headers: { "content-type": "message/rfc822" },
    });
  });

  return r;
}
