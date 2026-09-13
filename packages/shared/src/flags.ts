export const Flag = {
  SEEN: 1 << 0,
  STARRED: 1 << 1,
  DRAFT: 1 << 2,
  SENT: 1 << 3,
  TRASH: 1 << 4,
  // IMAP \Deleted: set by a mail client, pending EXPUNGE. Invisible to the web
  // app; expunge turns it into TRASH (or a hard delete when already in Trash).
  DELETED: 1 << 5,
} as const;

export type FlagBit = (typeof Flag)[keyof typeof Flag];

export function hasFlag(flags: number, bit: FlagBit): boolean {
  return (flags & bit) === bit;
}

export function setFlag(flags: number, bit: FlagBit, on: boolean): number {
  return on ? flags | bit : flags & ~bit;
}
