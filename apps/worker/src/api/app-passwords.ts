import { appPassword, domain, mailbox } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import type { AppPasswordCreatedDto, AppPasswordListDto } from "@cfmail/shared/responses";
import { createAppPassword } from "@cfmail/shared/schemas";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateAppPassword, hashAppPassword } from "../app-passwords.ts";
import { getImapConnection } from "../config.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";
import { requirePerm } from "../permissions.ts";

// Per-user cap: a mail client per device is plenty, and the login path
// verifies each candidate hash for a username in turn.
const MAX_PER_USER = 20;

export function appPasswordsRoutes() {
  const r = new Hono<AppBindings>()
    .use("*", requireUser)

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const rows = await db
        .select({
          id: appPassword.id,
          name: appPassword.name,
          mailboxId: appPassword.mailboxId,
          localPart: mailbox.localPart,
          domainName: domain.name,
          createdAt: appPassword.createdAt,
          lastUsedAt: appPassword.lastUsedAt,
        })
        .from(appPassword)
        .innerJoin(mailbox, eq(mailbox.id, appPassword.mailboxId))
        .innerJoin(domain, eq(domain.id, mailbox.domainId))
        .where(eq(appPassword.userId, u.id))
        .orderBy(desc(appPassword.createdAt));
      return c.json({
        passwords: rows.map((row) => ({
          id: row.id,
          name: row.name,
          mailboxId: row.mailboxId,
          mailboxAddress: `${row.localPart}@${row.domainName}`,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
        imap: await getImapConnection(db),
      } satisfies AppPasswordListDto);
    })

    // Mint a password for one mailbox. READ is the bar — an IMAP client can do
    // no more than the web app lets this user do (store.ts re-checks WRITE).
    .post("/", zValidator("json", createAppPassword), async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const body = c.req.valid("json");
      await requirePerm(db, u.id, body.mailboxId, Perm.READ);
      const mb = await db
        .select({ localPart: mailbox.localPart, domainName: domain.name, type: mailbox.type })
        .from(mailbox)
        .innerJoin(domain, eq(domain.id, mailbox.domainId))
        .where(eq(mailbox.id, body.mailboxId))
        .limit(1);
      const row = mb[0];
      if (!row) throw new HTTPException(404, { message: "mailbox not found" });
      if (row.type === "service") {
        throw new HTTPException(400, { message: "service mailboxes have no IMAP access" });
      }
      const existing = await db.$count(appPassword, eq(appPassword.userId, u.id));
      if (existing >= MAX_PER_USER) {
        throw new HTTPException(409, { message: `at most ${MAX_PER_USER} app passwords` });
      }
      const password = generateAppPassword();
      const id = crypto.randomUUID();
      await db.insert(appPassword).values({
        id,
        userId: u.id,
        mailboxId: body.mailboxId,
        name: body.name,
        hash: await hashAppPassword(password),
      });
      return c.json(
        {
          id,
          password,
          username: `${row.localPart}@${row.domainName}`,
        } satisfies AppPasswordCreatedDto,
        201,
      );
    })

    .delete("/:id", async (c) => {
      const db = dbFromCtx(c);
      const u = c.get("user")!;
      const id = c.req.param("id");
      const res = await db
        .delete(appPassword)
        .where(and(eq(appPassword.id, id), eq(appPassword.userId, u.id)));
      if (res.meta.changes === 0) throw new HTTPException(404, { message: "not found" });
      return c.body(null, 204);
    });

  return r;
}
