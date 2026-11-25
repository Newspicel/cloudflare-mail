// MCP clients the user has granted access over OAuth. A grant is the user's
// oauth_consent row for that client; the MCP edge (api/mcp.ts) requires it on
// every call, so revoking here cuts a client off at its next request. The
// client's tokens go too, so it can't quietly refresh its way back in — it has
// to send the user through consent again.

import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@cfmail/db/schema";
import type { ConnectedAppListDto } from "@cfmail/shared/responses";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { baseUrlFromRequest, mcpResource } from "../auth.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";

export function connectedAppsRoutes() {
  return (
    new Hono<AppBindings>()
      .use("*", requireUser)

      .get("/", async (c) => {
        const db = dbFromCtx(c);
        const u = c.get("user")!;
        const rows = await db
          .select({
            clientId: oauthConsent.clientId,
            name: oauthClient.name,
            uri: oauthClient.uri,
            icon: oauthClient.icon,
            grantedAt: oauthConsent.createdAt,
          })
          .from(oauthConsent)
          .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
          .where(eq(oauthConsent.userId, u.id))
          .orderBy(desc(oauthConsent.createdAt));
        return c.json({
          apps: rows.map((r) => ({
            clientId: r.clientId,
            name: r.name ?? r.clientId,
            uri: r.uri,
            icon: r.icon,
            grantedAt: r.grantedAt.toISOString(),
          })),
          mcpUrl: mcpResource(baseUrlFromRequest(c.req.raw)),
        } satisfies ConnectedAppListDto);
      })

      // CIMD client ids are URLs, so the id travels in the body, not the path.
      .post(
        "/revoke",
        zValidator("json", z.object({ clientId: z.string().min(1).max(2048) })),
        async (c) => {
          const db = dbFromCtx(c);
          const u = c.get("user")!;
          const { clientId } = c.req.valid("json");

          const mine = (
            t: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken,
          ) => and(eq(t.userId, u.id), eq(t.clientId, clientId));
          const removed = await db.delete(oauthConsent).where(mine(oauthConsent)).returning({
            id: oauthConsent.id,
          });
          if (removed.length === 0) throw new HTTPException(404, { message: "not found" });
          await db.batch([
            db.delete(oauthAccessToken).where(mine(oauthAccessToken)),
            db.delete(oauthRefreshToken).where(mine(oauthRefreshToken)),
          ]);
          return c.json({ ok: true });
        },
      )
  );
}
