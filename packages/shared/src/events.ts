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
  z.object({
    type: z.literal("mailbox_expired"),
    mailboxId: z.string(),
  }),
  z.object({
    type: z.literal("ping"),
    ts: z.number(),
  }),
]);
export type HubEvent = z.infer<typeof hubEvent>;
