import type { DB } from "@cfmail/db";
import { mailboxInvite, mailboxMember, user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";

// Turn pending mailbox invites addressed to a user's email into real
// memberships. Runs on session creation (auth.ts databaseHooks) and when the
// mailbox list is fetched — deliberately not on every request, so the auth
// cookieCache actually skips D1 on the hot path.
export async function materializeInvites(db: DB, userId: string, email?: string): Promise<void> {
  let addr = email;
  if (!addr) {
    const u = await db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: { email: true },
    });
    addr = u?.email;
  }
  if (!addr) return;

  const pending = await db
    .select({
      id: mailboxInvite.id,
      mailboxId: mailboxInvite.mailboxId,
      perms: mailboxInvite.perms,
    })
    .from(mailboxInvite)
    .where(eq(mailboxInvite.email, addr.toLowerCase()));
  await Promise.all(
    pending.map(async (inv) => {
      await db
        .insert(mailboxMember)
        .values({ mailboxId: inv.mailboxId, userId, perms: inv.perms })
        .onConflictDoUpdate({
          target: [mailboxMember.mailboxId, mailboxMember.userId],
          set: { perms: inv.perms },
        });
      await db.delete(mailboxInvite).where(eq(mailboxInvite.id, inv.id));
    }),
  );
}
