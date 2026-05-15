// Per-mailbox permission bits (READ/WRITE/MANAGE) — used by mailbox_member.perms.

export const Perm = {
  READ: 1 << 0,
  WRITE: 1 << 1,
  MANAGE: 1 << 2,
} as const;

export type PermBit = (typeof Perm)[keyof typeof Perm];

export const ALL_PERMS = Perm.READ | Perm.WRITE | Perm.MANAGE;

export function has(perms: number, bit: PermBit): boolean {
  return (perms & bit) === bit;
}

export function grant(perms: number, ...bits: PermBit[]): number {
  let out = perms;
  for (const b of bits) out |= b;
  return out;
}

export function revoke(perms: number, ...bits: PermBit[]): number {
  let out = perms;
  for (const b of bits) out &= ~b;
  return out;
}

export function describe(perms: number): string[] {
  const out: string[] = [];
  if (has(perms, Perm.READ)) out.push("read");
  if (has(perms, Perm.WRITE)) out.push("write");
  if (has(perms, Perm.MANAGE)) out.push("manage");
  return out;
}

// Mailbox-kind bits — used by domain.allowedKinds and domain_grant.allowedKinds.
// "Which mailbox types may exist on this domain?" / "Which kinds may this user
// create on this domain?"

export const MailboxKind = {
  PERSONAL: 1 << 0,
  GROUP: 1 << 1,
  SERVICE: 1 << 2,
  TEMP: 1 << 3,
} as const;

export type MailboxKindBit = (typeof MailboxKind)[keyof typeof MailboxKind];

export const ALL_MAILBOX_KINDS =
  MailboxKind.PERSONAL | MailboxKind.GROUP | MailboxKind.SERVICE | MailboxKind.TEMP;

const KIND_BIT_BY_NAME: Record<string, MailboxKindBit> = {
  personal: MailboxKind.PERSONAL,
  group: MailboxKind.GROUP,
  service: MailboxKind.SERVICE,
  temp: MailboxKind.TEMP,
};

export function kindBit(name: "personal" | "group" | "service" | "temp"): MailboxKindBit {
  const b = KIND_BIT_BY_NAME[name];
  if (b === undefined) throw new Error(`unknown mailbox kind: ${name}`);
  return b;
}

export function describeKinds(kinds: number): ("personal" | "group" | "service" | "temp")[] {
  const out: ("personal" | "group" | "service" | "temp")[] = [];
  if ((kinds & MailboxKind.PERSONAL) === MailboxKind.PERSONAL) out.push("personal");
  if ((kinds & MailboxKind.GROUP) === MailboxKind.GROUP) out.push("group");
  if ((kinds & MailboxKind.SERVICE) === MailboxKind.SERVICE) out.push("service");
  if ((kinds & MailboxKind.TEMP) === MailboxKind.TEMP) out.push("temp");
  return out;
}
