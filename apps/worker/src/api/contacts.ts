import { domain, mailbox, mailboxMember, message } from "@cfmail/db/schema";
import type { ContactsDto } from "@cfmail/shared/responses";
import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { requireUser } from "../middleware.ts";

// Recipient suggestions for the composer: addresses of the mailboxes the user
// can access plus addresses seen in their history. Everything is scoped to
// accessible mailboxes so one user's addresses/history never leak to another.
export function contactsRoutes() {
  const r = new Hono<AppBindings>();

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = dbFromCtx(c);
    const u = c.get("user")!;

    const [owned, member] = await Promise.all([
      db.select({ id: mailbox.id }).from(mailbox).where(eq(mailbox.ownerUserId, u.id)),
      db
        .select({ id: mailboxMember.mailboxId })
        .from(mailboxMember)
        .where(eq(mailboxMember.userId, u.id)),
    ]);
    const accessibleIds = [...new Set([...owned.map((m) => m.id), ...member.map((m) => m.id)])];

    const map = new Map<string, { address: string; name?: string }>();
    const add = (address?: string | null, name?: string | null) => {
      const addr = address?.trim().toLowerCase();
      if (!addr?.includes("@")) return;
      const existing = map.get(addr);
      const clean = name?.trim();
      if (!existing) map.set(addr, { address: addr, name: clean || undefined });
      else if (!existing.name && clean) existing.name = clean;
    };

    if (accessibleIds.length) {
      const dirRows = await db
        .select({
          localPart: mailbox.localPart,
          displayName: mailbox.displayName,
          domainName: domain.name,
        })
        .from(mailbox)
        .innerJoin(domain, eq(mailbox.domainId, domain.id))
        .where(inArray(mailbox.id, accessibleIds));
      for (const m of dirRows) add(`${m.localPart}@${m.domainName}`, m.displayName);

      const msgs = await db
        .select({
          fromAddr: message.fromAddr,
          fromName: message.fromName,
          toAddrs: message.toAddrs,
          ccAddrs: message.ccAddrs,
          bccAddrs: message.bccAddrs,
        })
        .from(message)
        .where(inArray(message.mailboxId, accessibleIds))
        .orderBy(desc(message.createdAt))
        .limit(1000);
      for (const m of msgs) {
        add(m.fromAddr, m.fromName);
        for (const a of m.toAddrs ?? []) add(a.address, a.name);
        for (const a of m.ccAddrs ?? []) add(a.address, a.name);
        for (const a of m.bccAddrs ?? []) add(a.address, a.name);
      }
    }

    return c.json({ contacts: [...map.values()] } satisfies ContactsDto);
  });

  return r;
}
