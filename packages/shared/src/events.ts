import { z } from "zod";

export const hubEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_message"),
    mailboxId: z.string(),
    messageId: z.string(),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal("message_sent"),
    mailboxId: z.string(),
    messageId: z.string(),
    threadId: z.string(),
  }),
  // A thread's metadata changed in place (e.g. best-effort AI summary/category
  // landed after delivery) — clients re-fetch the list without bumping it.
  z.object({
    type: z.literal("thread_updated"),
    mailboxId: z.string(),
    threadId: z.string(),
  }),
  // A thread's read/unread state changed on one device — peers sync their cached
  // unread badge, and on read=true dismiss any push notification for the thread.
  z.object({
    type: z.literal("thread_read"),
    mailboxId: z.string(),
    threadId: z.string(),
    read: z.boolean(),
  }),
  z.object({
    type: z.literal("mailbox_expired"),
    mailboxId: z.string(),
  }),
  // A deferred (scheduled) send failed at dispatch time. The draft was reverted
  // to an editable draft so the user can retry; the client refreshes + warns.
  z.object({
    type: z.literal("scheduled_send_failed"),
    mailboxId: z.string(),
    draftId: z.string(),
    error: z.string(),
  }),
  // A reminder's time arrived: the bell badge increments and a toast/push fires.
  z.object({
    type: z.literal("reminder_fired"),
    reminderId: z.string(),
    mailboxId: z.string(),
    threadId: z.string(),
    subject: z.string(),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal("ping"),
    ts: z.number(),
  }),
]);
export type HubEvent = z.infer<typeof hubEvent>;
