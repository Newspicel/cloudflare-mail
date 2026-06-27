import type { draft, message, reminder, thread } from "@cfmail/db/schema";
import type {
  DraftDto,
  MessageDto,
  MessagePgpKeyDto,
  ReminderDto,
  ThreadDto,
} from "@cfmail/shared";

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

export function serializeMessage(
  r: typeof message.$inferSelect,
  pgpKey?: MessagePgpKeyDto | null,
): MessageDto {
  return {
    ...r,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    pgpKey: pgpKey ?? null,
  };
}

export function serializeReminder(r: typeof reminder.$inferSelect): ReminderDto {
  return {
    ...r,
    remindAt: r.remindAt.toISOString(),
    firedAt: r.firedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function serializeDraft(r: typeof draft.$inferSelect): DraftDto {
  const { scheduledPayload: _payload, scheduledAttempts: _attempts, ...rest } = r;
  return {
    ...rest,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
  };
}
