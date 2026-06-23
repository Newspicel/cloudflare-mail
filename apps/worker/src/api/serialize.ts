import type { draft, message, thread } from "@cfmail/db/schema";
import type { DraftDto, MessageDto, ThreadDto } from "@cfmail/shared";

// Map Drizzle rows (with real `Date` columns) to the wire shape `c.json()`
// emits. The return types are the canonical DTOs, so any schema change that
// breaks a response shape fails typecheck right here.

export function serializeThread(r: typeof thread.$inferSelect): ThreadDto {
  return {
    ...r,
    lastMsgAt: r.lastMsgAt.toISOString(),
    trashedAt: r.trashedAt?.toISOString() ?? null,
  };
}

export function serializeMessage(r: typeof message.$inferSelect): MessageDto {
  return {
    ...r,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeDraft(r: typeof draft.$inferSelect): DraftDto {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
