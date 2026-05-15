import type { DB } from "@cfmail/db";
import { domain, domainGrant } from "@cfmail/db/schema";
import { kindBit, type MailboxKindBit } from "@cfmail/shared/permissions";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { User } from "./auth.ts";

// Authorises a (user, domain, kind) triple for mailbox creation.
//
// Admins bypass entirely. Non-admins need:
//   1. domain.allowedKinds has the bit (domain permits this kind at all), AND
//   2. domain_grant(userId, domainId).allowedKinds has the bit (this user
//      is permitted to create that kind on this domain).
export async function authorizeMailboxCreate(
  db: DB,
  user: User,
  domainId: string,
  type: "personal" | "group" | "service" | "temp",
): Promise<void> {
  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, domainId),
    columns: { id: true, allowedKinds: true },
  });
  if (!dom) throw new HTTPException(400, { message: "domain not found" });

  const bit: MailboxKindBit = kindBit(type);
  if ((dom.allowedKinds & bit) !== bit) {
    throw new HTTPException(400, {
      message: `domain does not allow ${type} mailboxes`,
    });
  }

  if ((user as { role?: string }).role === "admin") return;

  const grant = await db.query.domainGrant.findFirst({
    where: and(eq(domainGrant.userId, user.id), eq(domainGrant.domainId, domainId)),
    columns: { allowedKinds: true },
  });
  if (!grant || (grant.allowedKinds & bit) !== bit) {
    throw new HTTPException(403, { message: `not permitted to create ${type} on this domain` });
  }
}
