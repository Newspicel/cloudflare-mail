import { attachment, message } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

export function attachmentsRoutes() {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser);

  r.post("/upload", async (c) => {
    const user = c.get("user")!;
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    const filename = c.req.header("x-filename") ?? "upload.bin";

    const body = await c.req.raw.arrayBuffer();
    if (!body.byteLength) throw new HTTPException(400, { message: "empty" });
    if (body.byteLength > 25 * 1024 * 1024) throw new HTTPException(413, { message: "too large" });

    const key = `draft/${user.id}/${crypto.randomUUID()}-${sanitize(filename)}`;
    await c.env.BLOBS.put(key, body, { httpMetadata: { contentType } });
    return c.json({ r2Key: key, filename, contentType, sizeBytes: body.byteLength });
  });

  r.get("/:id", async (c) => {
    const db = dbFromCtx(c);
    const user = c.get("user")!;
    const id = c.req.param("id");

    const rows = await db
      .select({
        r2Key: attachment.r2Key,
        filename: attachment.filename,
        contentType: attachment.contentType,
        mailboxId: message.mailboxId,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .where(eq(attachment.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new HTTPException(404, { message: "not found" });

    await requirePerm(db, user.id, row.mailboxId, Perm.READ);
    const obj = await c.env.BLOBS.get(row.r2Key);
    if (!obj) throw new HTTPException(404, { message: "blob missing" });
    return new Response(obj.body, {
      headers: {
        "content-type": row.contentType,
        "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "_")}"`,
      },
    });
  });

  return r;
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 128);
}
