import { Flag, hasFlag, setFlag } from "@cfmail/shared/flags";
import {
  ALL_MAILBOX_KINDS,
  ALL_PERMS,
  describeKinds,
  describe as describePerms,
  grant,
  has,
  kindBit,
  MailboxKind,
  Perm,
  revoke,
} from "@cfmail/shared/permissions";
import { describe, expect, it } from "vitest";

describe("message flags", () => {
  it("detects a set bit and rejects an unset one", () => {
    const flags = Flag.SEEN | Flag.STARRED;
    expect(hasFlag(flags, Flag.SEEN)).toBe(true);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);
    expect(hasFlag(flags, Flag.TRASH)).toBe(false);
  });

  it("sets and clears a bit without touching the others", () => {
    let flags = Flag.SEEN;
    flags = setFlag(flags, Flag.STARRED, true);
    expect(hasFlag(flags, Flag.SEEN)).toBe(true);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);

    flags = setFlag(flags, Flag.SEEN, false);
    expect(hasFlag(flags, Flag.SEEN)).toBe(false);
    expect(hasFlag(flags, Flag.STARRED)).toBe(true);
  });

  it("is idempotent", () => {
    expect(setFlag(Flag.SEEN, Flag.SEEN, true)).toBe(Flag.SEEN);
    expect(setFlag(0, Flag.SEEN, false)).toBe(0);
  });
});

describe("permission bits", () => {
  it("has() requires the exact bit", () => {
    expect(has(Perm.READ | Perm.WRITE, Perm.READ)).toBe(true);
    expect(has(Perm.READ, Perm.MANAGE)).toBe(false);
  });

  it("grant() adds bits, revoke() removes them", () => {
    const granted = grant(0, Perm.READ, Perm.WRITE);
    expect(has(granted, Perm.READ)).toBe(true);
    expect(has(granted, Perm.WRITE)).toBe(true);
    expect(has(granted, Perm.MANAGE)).toBe(false);

    const revoked = revoke(granted, Perm.WRITE);
    expect(has(revoked, Perm.WRITE)).toBe(false);
    expect(has(revoked, Perm.READ)).toBe(true);
  });

  it("ALL_PERMS carries every bit", () => {
    expect(has(ALL_PERMS, Perm.READ)).toBe(true);
    expect(has(ALL_PERMS, Perm.WRITE)).toBe(true);
    expect(has(ALL_PERMS, Perm.MANAGE)).toBe(true);
  });

  it("describe() lists set permissions in order", () => {
    expect(describePerms(ALL_PERMS)).toEqual(["read", "write", "manage"]);
    expect(describePerms(Perm.READ | Perm.MANAGE)).toEqual(["read", "manage"]);
    expect(describePerms(0)).toEqual([]);
  });
});

describe("mailbox kinds", () => {
  it("kindBit() maps names to bits and rejects unknowns", () => {
    expect(kindBit("personal")).toBe(MailboxKind.PERSONAL);
    expect(kindBit("temp")).toBe(MailboxKind.TEMP);
    // @ts-expect-error — exercising the runtime guard for an unknown kind
    expect(() => kindBit("bogus")).toThrow(/unknown mailbox kind/);
  });

  it("describeKinds() round-trips ALL_MAILBOX_KINDS", () => {
    expect(describeKinds(ALL_MAILBOX_KINDS)).toEqual(["personal", "group", "service", "temp"]);
    expect(describeKinds(MailboxKind.GROUP | MailboxKind.SERVICE)).toEqual(["group", "service"]);
    expect(describeKinds(0)).toEqual([]);
  });
});
