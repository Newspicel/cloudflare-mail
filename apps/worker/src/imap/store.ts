// The IMAP view of one mailbox for one user. Folders are *derived* from the
// existing thread/message model on every load (nothing in the mail pipelines
// knows IMAP exists); this module only owns the per-folder UID space
// (imap_folder / imap_uid) and translates IMAP mutations back into the same
// thread/message state the web app writes.
//
// Folder ↔ model mapping (per user U, mailbox M):
//   INBOX   inbound live messages of active threads not filed by U
//   Sent    outbound live messages of active threads not filed by U
//   Spam    every message of a spam thread
//   Trash   every message of a trashed thread, plus TRASH-flagged messages of
//           active threads
//   <name>  live messages of active threads U filed into custom folder <name>
// "active" = not trashed, not spam; "live" = no TRASH flag.
/* eslint-disable no-await-in-loop -- per-thread cleanup runs in order to keep D1 statement sizes bounded */

import type { DB } from "@cfmail/db";
import type { ImapFolderKind } from "@cfmail/db/enums";
import {
  domain,
  folder,
  imapFolder,
  imapUid,
  mailbox,
  message,
  thread,
  threadFolder,
} from "@cfmail/db/schema";
import { Flag, has, Perm } from "@cfmail/shared";
import { and, asc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { AppError, wrapUnique } from "../errors.ts";
import { broadcastToUsers } from "../hub.ts";
import { collectMessageBlobKeys, deleteBlobs } from "../mail/blobs.ts";
import { ingestRaw } from "../mail/ingest.ts";
import { parseMime } from "../mail/mime.ts";
import { recomputeThreadAfterMessageDelete } from "../mail/threads.ts";
import { ensureCrlf } from "./mime-tree.ts";

export interface Account {
  userId: string;
  mailboxId: string;
  address: string;
  perms: number;
}

export interface FolderRef {
  kind: ImapFolderKind;
  folderId: string | null;
  // Display name (decoded); "INBOX", "Sent", "Spam", "Trash" or the custom name.
  name: string;
  key: string;
}

export const SYSTEM_FOLDERS: { kind: ImapFolderKind; name: string; specialUse: string | null }[] = [
  { kind: "inbox", name: "INBOX", specialUse: null },
  { kind: "sent", name: "Sent", specialUse: "\\Sent" },
  { kind: "spam", name: "Spam", specialUse: "\\Junk" },
  { kind: "trash", name: "Trash", specialUse: "\\Trash" },
];

export function specialUseOf(ref: FolderRef): string | null {
  return SYSTEM_FOLDERS.find((s) => s.kind === ref.kind)?.specialUse ?? null;
}

// The message columns the session works from; the raw body comes from R2.
export interface MessageRow {
  id: string;
  threadId: string;
  direction: "in" | "out";
  flags: number;
  sizeBytes: number;
  subject: string;
  fromAddr: string;
  fromName: string | null;
  toAddrs: { name?: string; address: string }[];
  ccAddrs: { name?: string; address: string }[] | null;
  bccAddrs: { name?: string; address: string }[] | null;
  toText: string | null;
  bodyText: string | null;
  messageIdHdr: string | null;
  inReplyTo: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  rawR2Key: string | null;
  plainR2Key: string | null;
}

export interface UidEntry {
  uid: number;
  msg: MessageRow;
  // \Answered is derived: an outbound message in this mailbox replies to it.
  answered: boolean;
}

export interface FolderState {
  id: string;
  uidValidity: number;
  uidNext: number;
}

export interface FolderView {
  ref: FolderRef;
  state: FolderState;
  // Sorted by UID ascending — sequence numbers are 1-based positions here.
  entries: UidEntry[];
}

export type ImapFlag = "\\Seen" | "\\Flagged" | "\\Deleted" | "\\Draft" | "\\Answered";

// IMAP flag ↔ message.flags bit. \Answered is read-only (derived).
const FLAG_BITS: Record<Exclude<ImapFlag, "\\Answered">, number> = {
  "\\Seen": Flag.SEEN,
  "\\Flagged": Flag.STARRED,
  "\\Deleted": Flag.DELETED,
  "\\Draft": Flag.DRAFT,
};
const IMAP_BITS = Flag.SEEN | Flag.STARRED | Flag.DELETED | Flag.DRAFT;

export function internalDate(m: MessageRow): Date {
  return m.receivedAt ?? m.sentAt ?? m.createdAt;
}

export function flagsOf(entry: UidEntry): string[] {
  const out: string[] = [];
  const f = entry.msg.flags;
  if (f & Flag.SEEN) out.push("\\Seen");
  if (f & Flag.STARRED) out.push("\\Flagged");
  if (f & Flag.DELETED) out.push("\\Deleted");
  if (f & Flag.DRAFT) out.push("\\Draft");
  if (entry.answered) out.push("\\Answered");
  return out;
}

export function flagBits(flags: string[]): number {
  let bits = 0;
  for (const f of flags) {
    const bit = FLAG_BITS[f as Exclude<ImapFlag, "\\Answered">];
    if (bit) bits |= bit;
  }
  return bits;
}

const LIVE = sql`(${message.flags} & ${Flag.TRASH}) = 0`;
const TRASHED = sql`(${message.flags} & ${Flag.TRASH}) = ${Flag.TRASH}`;
const ACTIVE = and(eq(thread.trashed, false), eq(thread.spam, false))!;

// D1 caps bound parameters per statement; keep every IN list under it.
const CHUNK = 90;
function chunk<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class ImapStore {
  constructor(
    private readonly env: Env,
    private readonly db: DB,
    readonly account: Account,
  ) {}

  private requireWrite(): void {
    if (!has(this.account.perms, Perm.WRITE)) {
      throw new AppError("forbidden", "write access to this mailbox is required");
    }
  }

  // ─── Folders ──────────────────────────────────────────────────────────────

  async listFolders(): Promise<FolderRef[]> {
    const custom = await this.db
      .select({ id: folder.id, name: folder.name })
      .from(folder)
      .where(eq(folder.userId, this.account.userId))
      .orderBy(asc(folder.position), asc(folder.createdAt));
    return [
      ...SYSTEM_FOLDERS.map((s) => ({ kind: s.kind, folderId: null, name: s.name, key: s.kind })),
      ...custom.map((f) => ({
        kind: "folder" as const,
        folderId: f.id,
        name: f.name,
        key: `folder:${f.id}`,
      })),
    ];
  }

  // INBOX is case-insensitive per RFC 3501; everything else matches exactly,
  // then case-insensitively when that's unambiguous.
  async resolveFolder(name: string): Promise<FolderRef | null> {
    const all = await this.listFolders();
    if (name.toUpperCase() === "INBOX") return all[0]!;
    const exact = all.find((f) => f.name === name);
    if (exact) return exact;
    const ci = all.filter((f) => f.name.toLowerCase() === name.toLowerCase());
    return ci.length === 1 ? ci[0]! : null;
  }

  async createFolder(name: string): Promise<FolderRef> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) throw new AppError("bad_request", "invalid folder name");
    await this.assertNameFree(trimmed);
    const max = await this.db
      .select({ m: sql<number>`coalesce(max(${folder.position}), -1)` })
      .from(folder)
      .where(eq(folder.userId, this.account.userId));
    const id = crypto.randomUUID();
    await wrapUnique(
      () =>
        this.db.insert(folder).values({
          id,
          userId: this.account.userId,
          name: trimmed,
          position: (max[0]?.m ?? -1) + 1,
        }),
      "folder already exists",
    );
    await this.notify();
    return { kind: "folder", folderId: id, name: trimmed, key: `folder:${id}` };
  }

  // Folder names are compared case-insensitively even though the underlying
  // unique index is exact: `resolveFolder` falls back to a case-insensitive
  // match, which two names differing only in case would make ambiguous.
  private async assertNameFree(name: string, exceptFolderId?: string | null): Promise<void> {
    const lower = name.toLowerCase();
    const taken = (await this.listFolders()).some(
      (f) => f.name.toLowerCase() === lower && f.folderId !== exceptFolderId,
    );
    if (taken) throw new AppError("conflict", "folder already exists");
  }

  async deleteFolder(ref: FolderRef): Promise<void> {
    if (ref.kind !== "folder" || !ref.folderId) {
      throw new AppError("forbidden", "system folders cannot be deleted");
    }
    // thread_folder + imap_folder rows cascade on the FK.
    await this.db
      .delete(folder)
      .where(and(eq(folder.id, ref.folderId), eq(folder.userId, this.account.userId)));
    await this.notify();
  }

  async renameFolder(ref: FolderRef, newName: string): Promise<void> {
    if (ref.kind !== "folder" || !ref.folderId) {
      throw new AppError("forbidden", "system folders cannot be renamed");
    }
    const trimmed = newName.trim();
    if (!trimmed || trimmed.length > 64) throw new AppError("bad_request", "invalid folder name");
    await this.assertNameFree(trimmed, ref.folderId);
    await wrapUnique(
      () =>
        this.db
          .update(folder)
          .set({ name: trimmed })
          .where(and(eq(folder.id, ref.folderId!), eq(folder.userId, this.account.userId))),
      "folder already exists",
    );
    await this.notify();
  }

  // ─── Contents ─────────────────────────────────────────────────────────────

  private membershipFilter(ref: FolderRef): SQL {
    const mine = eq(message.mailboxId, this.account.mailboxId);
    const notFiled = sql`not exists (select 1 from ${threadFolder} where ${threadFolder.threadId} = ${thread.id} and ${threadFolder.userId} = ${this.account.userId})`;
    switch (ref.kind) {
      case "inbox":
        return and(mine, ACTIVE, notFiled, LIVE, eq(message.direction, "in"))!;
      case "sent":
        return and(mine, ACTIVE, notFiled, LIVE, eq(message.direction, "out"))!;
      case "spam":
        return and(mine, eq(thread.spam, true), eq(thread.trashed, false))!;
      case "trash":
        return and(mine, or(eq(thread.trashed, true), and(ACTIVE, TRASHED)))!;
      case "folder":
        return and(
          mine,
          ACTIVE,
          LIVE,
          sql`exists (select 1 from ${threadFolder} where ${threadFolder.threadId} = ${thread.id} and ${threadFolder.userId} = ${this.account.userId} and ${threadFolder.folderId} = ${ref.folderId})`,
        )!;
    }
  }

  private async members(ref: FolderRef): Promise<MessageRow[]> {
    return this.db
      .select({
        id: message.id,
        threadId: message.threadId,
        direction: message.direction,
        flags: message.flags,
        sizeBytes: message.sizeBytes,
        subject: message.subject,
        fromAddr: message.fromAddr,
        fromName: message.fromName,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs,
        bccAddrs: message.bccAddrs,
        toText: message.toText,
        bodyText: message.bodyText,
        messageIdHdr: message.messageIdHdr,
        inReplyTo: message.inReplyTo,
        receivedAt: message.receivedAt,
        sentAt: message.sentAt,
        createdAt: message.createdAt,
        rawR2Key: message.rawR2Key,
        plainR2Key: message.plainR2Key,
      })
      .from(message)
      .innerJoin(thread, eq(thread.id, message.threadId))
      .where(this.membershipFilter(ref));
  }

  private async folderState(ref: FolderRef): Promise<FolderState> {
    const where = and(
      eq(imapFolder.userId, this.account.userId),
      eq(imapFolder.mailboxId, this.account.mailboxId),
      eq(imapFolder.key, ref.key),
    );
    const existing = await this.db.query.imapFolder.findFirst({
      where,
      columns: { id: true, uidValidity: true, uidNext: true },
    });
    if (existing) return existing;
    // Seconds since the epoch fits the 32-bit UIDVALIDITY and is fresh per
    // (re)creation; concurrent first loads collapse via the unique key.
    await this.db
      .insert(imapFolder)
      .values({
        id: crypto.randomUUID(),
        userId: this.account.userId,
        mailboxId: this.account.mailboxId,
        kind: ref.kind,
        folderId: ref.folderId,
        key: ref.key,
        uidValidity: Math.floor(Date.now() / 1000),
        uidNext: 1,
      })
      .onConflictDoNothing();
    const row = await this.db.query.imapFolder.findFirst({
      where,
      columns: { id: true, uidValidity: true, uidNext: true },
    });
    if (!row) throw new AppError("internal", "failed to create imap folder state");
    return row;
  }

  // Reconcile the folder's UID map with its current contents: new members get
  // fresh UIDs (in arrival order), departed ones lose their row so a return
  // gets a higher UID. Returns the sorted view.
  async loadView(ref: FolderRef): Promise<FolderView> {
    const state = await this.folderState(ref);
    const [rows, mapped, answeredRows] = await Promise.all([
      this.members(ref),
      this.db
        .select({ uid: imapUid.uid, messageId: imapUid.messageId })
        .from(imapUid)
        .where(eq(imapUid.imapFolderId, state.id)),
      this.db
        .select({ inReplyTo: message.inReplyTo })
        .from(message)
        .where(
          and(
            eq(message.mailboxId, this.account.mailboxId),
            eq(message.direction, "out"),
            isNotNull(message.inReplyTo),
          ),
        ),
    ]);
    const answered = new Set(answeredRows.map((r) => r.inReplyTo!));
    const present = new Set(rows.map((r) => r.id));
    const uidByMsg = new Map(mapped.map((r) => [r.messageId, r.uid]));

    const gone = mapped.filter((r) => !present.has(r.messageId)).map((r) => r.uid);
    if (gone.length) {
      await Promise.all(
        chunk(gone).map((part) =>
          this.db
            .delete(imapUid)
            .where(and(eq(imapUid.imapFolderId, state.id), inArray(imapUid.uid, part))),
        ),
      );
    }

    const fresh = rows
      .filter((r) => !uidByMsg.has(r.id))
      .toSorted(
        (a, b) =>
          internalDate(a).getTime() - internalDate(b).getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      );
    if (fresh.length) {
      // Reserve the UID range atomically so two sessions of the same user can't
      // hand out the same numbers.
      const reserved = await this.db
        .update(imapFolder)
        .set({ uidNext: sql`${imapFolder.uidNext} + ${fresh.length}` })
        .where(eq(imapFolder.id, state.id))
        .returning({ uidNext: imapFolder.uidNext });
      const next = reserved[0]?.uidNext ?? state.uidNext + fresh.length;
      let uid = next - fresh.length;
      const values = fresh.map((r) => ({ imapFolderId: state.id, uid: uid++, messageId: r.id }));
      await Promise.all(
        chunk(values, 30).map((part) => this.db.insert(imapUid).values(part).onConflictDoNothing()),
      );
      state.uidNext = next;
      // Another session may have mapped some of these first; read the truth.
      const now = await this.db
        .select({ uid: imapUid.uid, messageId: imapUid.messageId })
        .from(imapUid)
        .where(eq(imapUid.imapFolderId, state.id));
      uidByMsg.clear();
      for (const r of now) uidByMsg.set(r.messageId, r.uid);
    }

    const entries: UidEntry[] = [];
    for (const msg of rows) {
      const uid = uidByMsg.get(msg.id);
      if (uid === undefined) continue;
      entries.push({
        uid,
        msg,
        answered: !!msg.messageIdHdr && answered.has(msg.messageIdHdr),
      });
    }
    entries.sort((a, b) => a.uid - b.uid);
    return { ref, state, entries };
  }

  // ─── Raw bytes ────────────────────────────────────────────────────────────

  // Decrypted plaintext is preferred for gateway-PGP mail (mirrors the body
  // endpoint). A missing blob degrades to a stub built from the row so a FETCH
  // never fails the whole batch.
  async raw(msg: MessageRow): Promise<Uint8Array> {
    const key = msg.plainR2Key ?? msg.rawR2Key;
    if (key) {
      const obj = await this.env.BLOBS.get(key);
      if (obj) return ensureCrlf(new Uint8Array(await obj.arrayBuffer()));
    }
    const lines = [
      `From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr}`,
      `To: ${msg.toAddrs.map((a) => a.address).join(", ")}`,
      `Subject: ${msg.subject}`,
      `Date: ${internalDate(msg).toUTCString()}`,
      ...(msg.messageIdHdr ? [`Message-ID: ${msg.messageIdHdr}`] : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      msg.bodyText ?? "",
      "",
    ];
    return new TextEncoder().encode(lines.join("\r\n"));
  }

  // ─── Flags ────────────────────────────────────────────────────────────────

  // Apply a STORE to the given messages. Only \Seen/\Flagged/\Deleted/\Draft
  // persist; anything else is ignored. Returns the new flag bits per message.
  async storeFlags(
    entries: UidEntry[],
    mode: "set" | "add" | "remove",
    flags: string[],
  ): Promise<Map<string, number>> {
    const bits = flagBits(flags);
    const ids = entries.map((e) => e.msg.id);
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    let expr: SQL;
    let apply: (f: number) => number;
    if (mode === "add") {
      expr = sql`${message.flags} | ${bits}`;
      apply = (f) => f | bits;
    } else if (mode === "remove") {
      expr = sql`${message.flags} & ${~bits}`;
      apply = (f) => f & ~bits;
    } else {
      expr = sql`(${message.flags} & ${~IMAP_BITS}) | ${bits}`;
      apply = (f) => (f & ~IMAP_BITS) | bits;
    }
    await Promise.all(
      chunk(ids).map((part) =>
        this.db
          .update(message)
          .set({ flags: expr })
          .where(and(eq(message.mailboxId, this.account.mailboxId), inArray(message.id, part))),
      ),
    );
    for (const e of entries) {
      const next = apply(e.msg.flags);
      e.msg.flags = next;
      out.set(e.msg.id, next);
    }
    // \Seen drives the thread unread badge the web app shows.
    const touchesSeen = mode === "set" || (bits & Flag.SEEN) !== 0;
    if (touchesSeen) await this.recomputeUnread([...new Set(entries.map((e) => e.msg.threadId))]);
    await this.notify();
    return out;
  }

  private async recomputeUnread(threadIds: string[]): Promise<void> {
    await Promise.all(
      chunk(threadIds).map((part) =>
        this.db
          .update(thread)
          .set({
            unreadCount: sql`(select count(*) from ${message} m where m.thread_id = ${thread.id} and m.direction = 'in' and (m.flags & ${Flag.SEEN}) = 0 and (m.flags & ${Flag.TRASH}) = 0)`,
          })
          .where(inArray(thread.id, part)),
      ),
    );
  }

  // ─── Moves / deletes ──────────────────────────────────────────────────────

  // Trash the given messages: whole threads when every live message of the
  // thread is included (so the cron's retention applies), else per-message
  // TRASH flags. Never both — the web's "restore" only clears thread.trashed.
  private async trash(entries: UidEntry[]): Promise<void> {
    this.requireWrite();
    const byThread = new Map<string, UidEntry[]>();
    for (const e of entries) {
      const list = byThread.get(e.msg.threadId) ?? [];
      list.push(e);
      byThread.set(e.msg.threadId, list);
    }
    const threadIds = [...byThread.keys()];
    const liveCounts = new Map<string, number>();
    for (const part of chunk(threadIds)) {
      const rows = await this.db
        .select({ threadId: message.threadId, c: sql<number>`count(*)` })
        .from(message)
        .where(and(inArray(message.threadId, part), LIVE))
        .groupBy(message.threadId);
      for (const r of rows) liveCounts.set(r.threadId, Number(r.c));
    }
    const wholeThreads: string[] = [];
    const flagOnly: string[] = [];
    for (const [tid, list] of byThread) {
      const liveHere = list.filter((e) => !(e.msg.flags & Flag.TRASH)).length;
      if (liveHere >= (liveCounts.get(tid) ?? 0)) wholeThreads.push(tid);
      else flagOnly.push(...list.map((e) => e.msg.id));
    }
    const now = new Date();
    await Promise.all([
      ...chunk(wholeThreads).map((part) =>
        this.db
          .update(thread)
          .set({ trashed: true, trashedAt: now, spam: false })
          .where(inArray(thread.id, part)),
      ),
      ...chunk(flagOnly).map((part) =>
        this.db
          .update(message)
          .set({ flags: sql`(${message.flags} | ${Flag.TRASH}) & ${~Flag.DELETED}` })
          .where(inArray(message.id, part)),
      ),
      ...chunk(entries.map((e) => e.msg.id)).map((part) =>
        this.db
          .update(message)
          .set({ flags: sql`${message.flags} & ${~Flag.DELETED}` })
          .where(inArray(message.id, part)),
      ),
    ]);
    await this.recomputeUnread(threadIds);
  }

  // Bring messages back into the active views: clear per-message trash marks,
  // un-trash/un-spam their threads, and unfile them from any custom folder.
  private async restore(entries: UidEntry[]): Promise<void> {
    const ids = entries.map((e) => e.msg.id);
    const threadIds = [...new Set(entries.map((e) => e.msg.threadId))];
    await Promise.all([
      ...chunk(ids).map((part) =>
        this.db
          .update(message)
          .set({ flags: sql`${message.flags} & ${~(Flag.TRASH | Flag.DELETED)}` })
          .where(inArray(message.id, part)),
      ),
      ...chunk(threadIds).map((part) =>
        this.db
          .update(thread)
          .set({ trashed: false, trashedAt: null, spam: false })
          .where(
            and(inArray(thread.id, part), or(eq(thread.trashed, true), eq(thread.spam, true))),
          ),
      ),
      ...chunk(threadIds).map((part) =>
        this.db
          .delete(threadFolder)
          .where(
            and(eq(threadFolder.userId, this.account.userId), inArray(threadFolder.threadId, part)),
          ),
      ),
    ]);
    await this.recomputeUnread(threadIds);
  }

  async moveMessages(source: FolderRef, entries: UidEntry[], target: FolderRef): Promise<void> {
    if (entries.length === 0) return;
    if (source.key === target.key) return;
    const threadIds = [...new Set(entries.map((e) => e.msg.threadId))];
    switch (target.kind) {
      case "trash":
        await this.trash(entries);
        break;
      case "spam": {
        this.requireWrite();
        await Promise.all([
          ...chunk(threadIds).map((part) =>
            this.db
              .update(thread)
              .set({ spam: true, trashed: false, trashedAt: null })
              .where(inArray(thread.id, part)),
          ),
          ...chunk(entries.map((e) => e.msg.id)).map((part) =>
            this.db
              .update(message)
              .set({ flags: sql`${message.flags} & ${~(Flag.TRASH | Flag.DELETED)}` })
              .where(inArray(message.id, part)),
          ),
        ]);
        break;
      }
      case "inbox":
      case "sent": {
        // A message's direction fixes which of the two it lands in; moving an
        // outbound message "to INBOX" just restores it (it reappears in Sent).
        if (source.kind === "inbox" || source.kind === "sent") {
          throw new AppError("bad_request", "messages cannot move between INBOX and Sent");
        }
        if (source.kind === "trash" || source.kind === "spam") this.requireWrite();
        await this.restore(entries);
        break;
      }
      case "folder": {
        if (source.kind === "trash" || source.kind === "spam") this.requireWrite();
        await this.restore(entries);
        const now = new Date();
        await Promise.all(
          threadIds.map((threadId) =>
            this.db
              .insert(threadFolder)
              .values({
                userId: this.account.userId,
                threadId,
                folderId: target.folderId!,
                filedAt: now,
              })
              .onConflictDoUpdate({
                target: [threadFolder.userId, threadFolder.threadId],
                set: { folderId: target.folderId!, filedAt: now },
              }),
          ),
        );
        break;
      }
    }
    await this.notify();
  }

  // EXPUNGE: \Deleted messages leave the folder. From the active folders that
  // means Trash; from Trash/Spam it's permanent.
  async expunge(ref: FolderRef, entries: UidEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.requireWrite();
    if (ref.kind === "trash" || ref.kind === "spam") {
      await this.destroy(entries);
    } else {
      await this.trash(entries);
    }
    await this.notify();
  }

  private async destroy(entries: UidEntry[]): Promise<void> {
    const threadIds = [...new Set(entries.map((e) => e.msg.threadId))];
    for (const e of entries) {
      const keys = await collectMessageBlobKeys(this.db, e.msg.id);
      await deleteBlobs(this.env, keys);
    }
    await Promise.all(
      chunk(entries.map((e) => e.msg.id)).map((part) =>
        this.db.delete(message).where(inArray(message.id, part)),
      ),
    );
    for (const threadId of threadIds) {
      const left = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(message)
        .where(eq(message.threadId, threadId));
      if (Number(left[0]?.c ?? 0) === 0) {
        await this.db.delete(thread).where(eq(thread.id, threadId));
      } else {
        await recomputeThreadAfterMessageDelete(this.db, threadId);
      }
    }
  }

  // ─── APPEND ───────────────────────────────────────────────────────────────

  // Store a client-supplied message through the normal ingest pipeline and
  // place it per the target folder. Re-appending a Message-ID the mailbox
  // already holds is a no-op (clients retry APPEND after timeouts).
  async append(
    ref: FolderRef,
    raw: Uint8Array,
    flags: string[],
    date: Date | null,
  ): Promise<{ messageId: string; duplicate: boolean }> {
    this.requireWrite();
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const parsed = await parseMime(buf);
    if (parsed.messageId) {
      const dup = await this.db.query.message.findFirst({
        where: and(
          eq(message.mailboxId, this.account.mailboxId),
          eq(message.messageIdHdr, parsed.messageId),
        ),
        columns: { id: true },
      });
      if (dup) return { messageId: dup.id, duplicate: true };
    }
    const own = this.account.address.toLowerCase();
    const from = (parsed.from?.address ?? "").trim().toLowerCase();
    const direction: "in" | "out" =
      ref.kind === "inbox" ? "in" : ref.kind === "sent" ? "out" : from === own ? "out" : "in";
    const headerDate = parsed.date ? new Date(parsed.date) : null;
    const when =
      date ?? (headerDate && !Number.isNaN(headerDate.getTime()) ? headerDate : new Date());
    let bits = flagBits(flags);
    if (direction === "out") bits |= Flag.SENT;
    if (ref.kind === "trash") bits |= Flag.TRASH;
    const result = await ingestRaw(this.env, this.db, {
      mailboxId: this.account.mailboxId,
      raw: buf,
      parsed,
      direction,
      deliveredTo: direction === "in" ? own : null,
      flags: bits,
      receivedAt: direction === "in" ? when : null,
      sentAt: direction === "out" ? when : null,
      spam: null,
    });
    if (ref.kind === "spam") {
      await this.db
        .update(thread)
        .set({ spam: true, trashed: false, trashedAt: null })
        .where(eq(thread.id, result.threadId));
    } else if (ref.kind === "folder") {
      const now = new Date();
      await this.db
        .insert(threadFolder)
        .values({
          userId: this.account.userId,
          threadId: result.threadId,
          folderId: ref.folderId!,
          filedAt: now,
        })
        .onConflictDoUpdate({
          target: [threadFolder.userId, threadFolder.threadId],
          set: { folderId: ref.folderId!, filedAt: now },
        });
    }
    await this.notify();
    return { messageId: result.messageId, duplicate: false };
  }

  // One coarse event per mutation: the web app refetches the mailbox, and any
  // other IMAP session of this user re-reconciles its selected folder.
  private async notify(): Promise<void> {
    await broadcastToUsers(this.env, [this.account.userId], {
      type: "mailbox_changed",
      mailboxId: this.account.mailboxId,
    });
  }
}

// Resolve a mailbox's full address for the account object / APPEND direction.
export async function mailboxAddress(db: DB, mailboxId: string): Promise<string | null> {
  const rows = await db
    .select({ localPart: mailbox.localPart, domainName: domain.name })
    .from(mailbox)
    .innerJoin(domain, eq(domain.id, mailbox.domainId))
    .where(eq(mailbox.id, mailboxId))
    .limit(1);
  const r = rows[0];
  return r ? `${r.localPart}@${r.domainName}` : null;
}
