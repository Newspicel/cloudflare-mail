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
