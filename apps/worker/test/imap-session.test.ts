/* eslint-disable no-await-in-loop -- protocol conversations are sequential */
import { appPassword, message, thread, threadFolder } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashAppPassword } from "../src/app-passwords.ts";
import { broadcastToUsers } from "../src/hub.ts";
import { ImapSession } from "../src/imap/session.ts";
import { ingestRaw } from "../src/mail/ingest.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { grantMember, MAILBOX_ID, MEMBER_ID, OWNER_ID, seedBase } from "./support/seed.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ADDRESS = "team@example.com";
const PASSWORD = "abcde-fghjk-mnpqr-stuvw";
// A distinct secret per user: both rows are login candidates for the mailbox
// address, so sharing one secret would authenticate whichever row is found first.
const MEMBER_PASSWORD = "22222-33333-44444-55555";

function eml(opts: {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  date?: string;
}): ArrayBuffer {
  const lines = [
    `From: ${opts.from ?? "Alice <alice@elsewhere.test>"}`,
    `To: ${opts.to ?? `Team <${ADDRESS}>`}`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Date: ${opts.date ?? "Mon, 1 Jan 2024 10:00:00 +0000"}`,
    `Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@elsewhere.test>`}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Hi there",
    "",
  ];
  return enc.encode(lines.join("\r\n")).buffer as ArrayBuffer;
}

async function ingest(
  opts: Parameters<typeof eml>[0] & { direction?: "in" | "out"; flags?: number },
) {
  const direction = opts.direction ?? "in";
  const when = new Date(opts.date ?? "2024-01-01T10:00:00Z");
  return ingestRaw(e, db(), {
    mailboxId: MAILBOX_ID,
    raw: eml(opts),
    direction,
    deliveredTo: direction === "in" ? ADDRESS : null,
    flags: opts.flags ?? (direction === "out" ? Flag.SENT | Flag.SEEN : 0),
    receivedAt: direction === "in" ? when : null,
    sentAt: direction === "out" ? when : null,
    spam: null,
  });
}

// A scripted IMAP client over an in-memory socket pair.
class Client {
  private readonly toServer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly fromServer: ReadableStreamDefaultReader<Uint8Array>;
  private buf = "";
  private n = 0;
  readonly done: Promise<void>;

  constructor() {
    const c2s = new TransformStream<Uint8Array, Uint8Array>();
    const s2c = new TransformStream<Uint8Array, Uint8Array>();
    this.toServer = c2s.writable.getWriter();
    this.fromServer = s2c.readable.getReader();
    const session = new ImapSession(
      { readable: c2s.readable, writable: s2c.writable, close: () => {} },
      e,
      db(),
      "127.0.0.1",
    );
    this.done = session.run();
  }

  async write(s: string): Promise<void> {
    await this.toServer.write(enc.encode(s));
  }

  // Read until a line satisfies `until`; returns every line seen.
  async readUntil(until: (line: string) => boolean, timeoutMs = 5000): Promise<string[]> {
    const lines: string[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const nl = this.buf.indexOf("\r\n");
      if (nl !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        lines.push(line);
        if (until(line)) return lines;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; got:\n${lines.join("\n")}\n<buf>${this.buf}`);
      const timer = new Promise<null>((r) => setTimeout(() => r(null), left));
      const res = await Promise.race([this.fromServer.read(), timer]);
      if (res === null) throw new Error(`timeout; got:\n${lines.join("\n")}`);
      if (res.done) throw new Error(`closed; got:\n${lines.join("\n")}`);
      this.buf += dec.decode(res.value, { stream: true });
    }
  }

  greeting(): Promise<string[]> {
    return this.readUntil((l) => l.startsWith("* OK"));
  }

  // Send a command and collect everything up to its tagged reply.
  async cmd(line: string): Promise<{ tag: string; lines: string[]; status: string; last: string }> {
    const tag = `A${++this.n}`;
    await this.write(`${tag} ${line}\r\n`);
    const lines = await this.readUntil((l) => l.startsWith(`${tag} `));
    const last = lines[lines.length - 1]!;
    return { tag, lines, status: last.split(" ")[1]!, last };
  }

  async ok(line: string): Promise<string[]> {
    const r = await this.cmd(line);
    expect(r.last, r.lines.join("\n")).toMatch(new RegExp(`^${r.tag} OK`));
    return r.lines;
  }

  async login(user = ADDRESS, pass = PASSWORD): Promise<void> {
    await this.greeting();
    await this.ok(`LOGIN "${user}" "${pass}"`);
  }

  // Signal EOF and drop the response side: the server's read loop ends, so the
  // session tears itself down. Sending LOGOUT here would block forever once the
  // session has already exited (nothing drains the pipe).
  async close(): Promise<void> {
    await this.toServer.close().catch(() => undefined);
    await this.fromServer.cancel().catch(() => undefined);
    await this.done;
  }
}

let clients: Client[] = [];
function connect(): Client {
  const c = new Client();
  clients.push(c);
  return c;
}

async function issuePassword(
  userId: string,
  password = PASSWORD,
  mailboxId = MAILBOX_ID,
): Promise<void> {
  await db()
    .insert(appPassword)
    .values({
      id: crypto.randomUUID(),
      userId,
      mailboxId,
      name: "test",
      hash: await hashAppPassword(password),
    });
}

function literalBody(lines: string[], from: number): string {
  // Lines after a `{n}` literal header up to (not including) the next "* " or tagged line.
  const out: string[] = [];
  for (let i = from; i < lines.length; i++) {
    if (/^(\* |A\d+ )/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\r\n");
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await issuePassword(OWNER_ID);
});
afterEach(async () => {
  const cs = clients;
  clients = [];
  await Promise.all(cs.map((c) => c.close()));
});

describe("authentication", () => {
  it("greets with capabilities and rejects bad credentials", async () => {
    const c = connect();
    const [greet] = await c.greeting();
    expect(greet).toMatch(/^\* OK \[CAPABILITY IMAP4rev1 .*AUTH=PLAIN\]/);
    const bad = await c.cmd(`LOGIN "${ADDRESS}" "nope"`);
    expect(bad.last).toMatch(/NO \[AUTHENTICATIONFAILED\]/);
    const denied = await c.cmd("SELECT INBOX");
    expect(denied.status).toBe("NO");
    const ok = await c.cmd(`LOGIN "${ADDRESS}" "${PASSWORD}"`);
    expect(ok.last).toMatch(/OK \[CAPABILITY .*IDLE.*MOVE.*\] Logged in/);
  });

  it("accepts the password without dashes and AUTHENTICATE PLAIN with an initial response", async () => {
    const c = connect();
    await c.greeting();
    const ir = btoa(`\0${ADDRESS}\0${PASSWORD.replaceAll("-", "")}`);
    const r = await c.cmd(`AUTHENTICATE PLAIN ${ir}`);
    expect(r.status).toBe("OK");
  });

  it("accepts the user's sign-in email as the username", async () => {
    const c = connect();
    await c.greeting();
    const r = await c.cmd(`LOGIN "owner@example.com" "${PASSWORD}"`);
    expect(r.status).toBe("OK");
  });

  it("refuses a password whose mailbox access was revoked", async () => {
    await issuePassword(MEMBER_ID, MEMBER_PASSWORD);
    // Never granted membership → the password verifies but RBAC says no.
    const c = connect();
    await c.greeting();
    const r = await c.cmd(`LOGIN "${ADDRESS}" "${MEMBER_PASSWORD}"`);
    expect(r.last).toMatch(/NO \[NOPERM\]/);
  });
});

describe("folders", () => {
  it("lists the system folders with special-use attributes", async () => {
    const c = connect();
    await c.login();
    const lines = await c.ok('LIST "" "*"');
    expect(lines).toContain('* LIST (\\HasNoChildren) "/" "INBOX"');
    expect(lines).toContain('* LIST (\\HasNoChildren \\Sent) "/" "Sent"');
    expect(lines).toContain('* LIST (\\HasNoChildren \\Junk) "/" "Spam"');
    expect(lines).toContain('* LIST (\\HasNoChildren \\Trash) "/" "Trash"');
    expect(await c.ok('LIST "" ""')).toContain('* LIST (\\Noselect) "/" ""');
    expect(await c.ok("NAMESPACE")).toContain('* NAMESPACE (("" "/")) NIL NIL');
  });

  it("creates, renames, lists (mUTF-7) and deletes custom folders", async () => {
    const c = connect();
    await c.login();
    await c.ok('CREATE "Entw&APw-rfe"');
    let lines = await c.ok('LIST "" "*"');
    expect(lines).toContain('* LIST (\\HasNoChildren) "/" "Entw&APw-rfe"');
    await c.ok('RENAME "Entw&APw-rfe" "Projects"');
    lines = await c.ok('LIST "" "Proj%"');
    expect(lines).toContain('* LIST (\\HasNoChildren) "/" "Projects"');
    // Case variants collide: resolveFolder's case-insensitive fallback would
    // otherwise be ambiguous.
    const dup = await c.cmd('CREATE "projects"');
    expect(dup.status).toBe("NO");
    await c.ok('DELETE "Projects"');
    lines = await c.ok('LIST "" "*"');
    expect(lines.some((l) => l.includes("Projects"))).toBe(false);
    expect((await c.cmd('DELETE "INBOX"')).status).toBe("NO");
  });

  it("reports STATUS and LIST-STATUS", async () => {
    await ingest({ subject: "one" });
    await ingest({ subject: "two", flags: Flag.SEEN });
    const c = connect();
    await c.login();
    const lines = await c.ok("STATUS INBOX (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)");
    expect(lines[0]).toMatch(
      /^\* STATUS "INBOX" \(MESSAGES 2 UNSEEN 1 UIDNEXT 3 UIDVALIDITY \d+\)$/,
    );
    const ls = await c.ok('LIST "" "INBOX" RETURN (STATUS (MESSAGES))');
    expect(ls).toContain('* STATUS "INBOX" (MESSAGES 2)');
  });
});

describe("select / fetch / search", () => {
  it("selects INBOX and fetches envelope, structure and body sections", async () => {
    await ingest({ subject: "First", body: "alpha", date: "Mon, 1 Jan 2024 10:00:00 +0000" });
    await ingest({
      subject: "Second",
      body: "beta",
      from: "Bob <bob@elsewhere.test>",
      date: "Tue, 2 Jan 2024 10:00:00 +0000",
    });
    const c = connect();
    await c.login();
    const sel = await c.ok("SELECT INBOX");
    expect(sel).toContain("* 2 EXISTS");
    expect(sel).toContain("* OK [UNSEEN 1] First unseen");
    expect(sel.some((l) => /^\* OK \[UIDVALIDITY \d+\]/.test(l))).toBe(true);
    expect(sel).toContain("* OK [UIDNEXT 3] Predicted next UID");
    expect(sel[sel.length - 1]).toMatch(/OK \[READ-WRITE\] SELECT completed/);

    const fetched = await c.ok(
      "FETCH 1:* (UID FLAGS RFC822.SIZE ENVELOPE BODYSTRUCTURE INTERNALDATE)",
    );
    expect(fetched[0]).toMatch(
      /^\* 1 FETCH \(UID 1 FLAGS \(\) RFC822.SIZE \d+ ENVELOPE \("Mon, 1 Jan 2024 10:00:00 \+0000" "First" \(\("Alice" NIL "alice" "elsewhere.test"\)\).* BODYSTRUCTURE \("TEXT" "PLAIN" \("CHARSET" "utf-8"\) NIL NIL "7BIT" \d+ \d+ NIL NIL NIL NIL\) INTERNALDATE "01-Jan-2024 10:00:00 \+0000"\)$/,
    );
    expect(fetched[1]).toMatch(/^\* 2 FETCH \(UID 2 .*"Second".*\)$/);

    const hdr = await c.ok("FETCH 2 BODY.PEEK[HEADER.FIELDS (Subject From)]");
    expect(hdr[0]).toMatch(/^\* 2 FETCH \(BODY\[HEADER.FIELDS \(SUBJECT FROM\)\] \{\d+\}$/);
    expect(literalBody(hdr, 1)).toBe("From: Bob <bob@elsewhere.test>\r\nSubject: Second\r\n\r\n)");

    // Non-PEEK body fetch sets \Seen and reports it.
    const body = await c.ok("FETCH 1 BODY[TEXT]");
    expect(body[0]).toMatch(/^\* 1 FETCH \(BODY\[TEXT\] \{\d+\}$/);
    expect(body.some((l) => l.endsWith(" FLAGS (\\Seen))"))).toBe(true);
    const rows = await db().query.message.findMany({ where: eq(message.subject, "First") });
    expect(rows[0]!.flags & Flag.SEEN).toBe(Flag.SEEN);
    const th = await db().query.thread.findFirst({ where: eq(thread.id, rows[0]!.threadId) });
    expect(th!.unreadCount).toBe(0);

    const partial = await c.ok("UID FETCH 2 (BODY.PEEK[TEXT]<0.2>)");
    expect(partial[0]).toBe("* 2 FETCH (BODY[TEXT]<0> {2}");
    expect(partial[1]).toBe("be UID 2)");
  });

  it("answers SEARCH over flags, senders, dates and UIDs", async () => {
    await ingest({
      subject: "Invoice",
      from: "billing@vendor.test",
      date: "Mon, 1 Jan 2024 10:00:00 +0000",
    });
    await ingest({
      subject: "Party",
      body: "cake",
      date: "Fri, 5 Jan 2024 10:00:00 +0000",
      flags: Flag.SEEN,
    });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    expect((await c.ok("SEARCH UNSEEN"))[0]).toBe("* SEARCH 1");
    expect((await c.ok('SEARCH FROM "vendor"'))[0]).toBe("* SEARCH 1");
    expect((await c.ok('SEARCH BODY "cake"'))[0]).toBe("* SEARCH 2");
    expect((await c.ok("SEARCH SINCE 3-Jan-2024"))[0]).toBe("* SEARCH 2");
    expect((await c.ok('SEARCH OR SUBJECT "Invoice" SUBJECT "Party"'))[0]).toBe("* SEARCH 1 2");
    expect((await c.ok('SEARCH NOT SUBJECT "Invoice"'))[0]).toBe("* SEARCH 2");
    expect((await c.ok("UID SEARCH ALL"))[0]).toBe("* SEARCH 1 2");
    expect((await c.ok('SEARCH HEADER Message-ID "elsewhere"'))[0]).toBe("* SEARCH 1 2");
    expect((await c.ok('SEARCH CHARSET UTF-8 SUBJECT "Party"'))[0]).toBe("* SEARCH 2");
    const bad = await c.cmd('SEARCH CHARSET ISO-8859-1 SUBJECT "x"');
    expect(bad.last).toMatch(/NO \[BADCHARSET/);
  });

  it("splits inbound and outbound mail between INBOX and Sent and derives \\Answered", async () => {
    await ingest({ subject: "Q", messageId: "<q@elsewhere.test>" });
    await ingest({
      subject: "Re: Q",
      direction: "out",
      from: `Team <${ADDRESS}>`,
      to: "alice@elsewhere.test",
    });
    // The reply references the question.
    await db()
      .update(message)
      .set({ inReplyTo: "<q@elsewhere.test>" })
      .where(eq(message.subject, "Re: Q"));
    const c = connect();
    await c.login();
    expect(await c.ok("SELECT INBOX")).toContain("* 1 EXISTS");
    expect((await c.ok("FETCH 1 FLAGS"))[0]).toBe("* 1 FETCH (FLAGS (\\Answered))");
    expect(await c.ok("SELECT Sent")).toContain("* 1 EXISTS");
    expect((await c.ok("FETCH 1 FLAGS"))[0]).toBe("* 1 FETCH (FLAGS (\\Seen))");
  });
});

describe("store / move / expunge", () => {
  it("STORE updates flags and mirrors them into the thread model", async () => {
    await ingest({ subject: "A" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    const r = await c.ok("STORE 1 +FLAGS (\\Flagged \\Seen)");
    expect(r[0]).toBe("* 1 FETCH (FLAGS (\\Seen \\Flagged))");
    let row = (await db().query.message.findMany())[0]!;
    expect(row.flags & Flag.STARRED).toBe(Flag.STARRED);
    expect(row.flags & Flag.SEEN).toBe(Flag.SEEN);
    const silent = await c.ok("UID STORE 1 -FLAGS.SILENT (\\Seen)");
    expect(silent).toHaveLength(1);
    row = (await db().query.message.findMany())[0]!;
    expect(row.flags & Flag.SEEN).toBe(0);
    const th = await db().query.thread.findFirst({ where: eq(thread.id, row.threadId) });
    expect(th!.unreadCount).toBe(1);
    expect((await c.ok("STORE 1 FLAGS (\\Draft)"))[0]).toBe("* 1 FETCH (FLAGS (\\Draft))");
  });

  it("MOVE to Trash trashes and reports COPYUID; the message shows up in Trash", async () => {
    await ingest({ subject: "keep" });
    await ingest({ subject: "bin", date: "Tue, 2 Jan 2024 10:00:00 +0000" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    const mv = await c.ok("UID MOVE 2 Trash");
    expect(mv.some((l) => /^\* OK \[COPYUID \d+ 2 1\]/.test(l))).toBe(true);
    expect(mv).toContain("* 2 EXPUNGE");
    const bin = await db().query.message.findFirst({ where: eq(message.subject, "bin") });
    const th = await db().query.thread.findFirst({ where: eq(thread.id, bin!.threadId) });
    expect(th!.trashed).toBe(true);
    const trash = await c.ok("SELECT Trash");
    expect(trash).toContain("* 1 EXISTS");
    // Moving it back restores the thread.
    await c.ok("MOVE 1 INBOX");
    const again = await db().query.thread.findFirst({ where: eq(thread.id, bin!.threadId) });
    expect(again!.trashed).toBe(false);
    expect(await c.ok("SELECT INBOX")).toContain("* 2 EXISTS");
  });

  it("MOVE to a custom folder files the thread for this user", async () => {
    await ingest({ subject: "file me" });
    const c = connect();
    await c.login();
    await c.ok('CREATE "Projects"');
    await c.ok("SELECT INBOX");
    await c.ok("MOVE 1 Projects");
    const filed = await db().query.threadFolder.findMany({
      where: eq(threadFolder.userId, OWNER_ID),
    });
    expect(filed).toHaveLength(1);
    expect(await c.ok("SELECT Projects")).toContain("* 1 EXISTS");
    expect(await c.ok("SELECT INBOX")).toContain("* 0 EXISTS");
  });

  it("EXPUNGE from INBOX trashes, EXPUNGE from Trash deletes for good", async () => {
    const { messageId } = await ingest({ subject: "gone" });
    const rawKey = (await db().query.message.findFirst({ where: eq(message.id, messageId) }))!
      .rawR2Key!;
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    await c.ok("STORE 1 +FLAGS (\\Deleted)");
    const ex = await c.ok("EXPUNGE");
    expect(ex).toContain("* 1 EXPUNGE");
    expect(await db().query.message.findFirst({ where: eq(message.id, messageId) })).toBeDefined();
    await c.ok("SELECT Trash");
    await c.ok("STORE 1 +FLAGS (\\Deleted)");
    await c.ok("EXPUNGE");
    expect(
      await db().query.message.findFirst({ where: eq(message.id, messageId) }),
    ).toBeUndefined();
    expect(await db().query.thread.findMany()).toHaveLength(0);
    expect(await e.BLOBS.get(rawKey)).toBeNull();
  });

  it("CLOSE expunges silently and COPY is refused", async () => {
    await ingest({ subject: "x" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    expect((await c.cmd("COPY 1 Trash")).last).toMatch(/NO \[CANNOT\]/);
    await c.ok("STORE 1 +FLAGS.SILENT (\\Deleted)");
    const close = await c.ok("CLOSE");
    expect(close).toHaveLength(1);
    expect(await c.ok("SELECT INBOX")).toContain("* 0 EXISTS");
  });

  it("renumbers sequence numbers after an expunge", async () => {
    await ingest({ subject: "one", date: "Mon, 1 Jan 2024 10:00:00 +0000" });
    await ingest({ subject: "two", date: "Tue, 2 Jan 2024 10:00:00 +0000" });
    await ingest({ subject: "three", date: "Wed, 3 Jan 2024 10:00:00 +0000" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    await c.ok("UID MOVE 1 Trash");
    const f = await c.ok("FETCH 1:* (UID ENVELOPE)");
    expect(f[0]).toMatch(/^\* 1 FETCH \(UID 2 .*"two"/);
    expect(f[1]).toMatch(/^\* 2 FETCH \(UID 3 .*"three"/);
  });

  it("gives a departed-and-returned message a fresh UID", async () => {
    await ingest({ subject: "boomerang" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    await c.ok("UID MOVE 1 Spam");
    await c.ok("SELECT Spam");
    await c.ok("UID MOVE 1 INBOX");
    const sel = await c.ok("SELECT INBOX");
    expect(sel).toContain("* 1 EXISTS");
    expect((await c.ok("FETCH 1 UID"))[0]).toBe("* 1 FETCH (UID 2)");
  });
});

describe("append", () => {
  it("stores an appended message, sets flags and returns APPENDUID", async () => {
    const c = connect();
    await c.login();
    const raw = new TextDecoder().decode(eml({ subject: "Appended", messageId: "<app@x.test>" }));
    const r = await c.ok(
      `APPEND INBOX (\\Seen) "13-Sep-2026 07:05:09 +0000" {${enc.encode(raw).length}+}\r\n${raw}`,
    );
    expect(r[r.length - 1]).toMatch(/OK \[APPENDUID \d+ 1\] APPEND completed/);
    const row = await db().query.message.findFirst({ where: eq(message.subject, "Appended") });
    expect(row!.direction).toBe("in");
    expect(row!.flags & Flag.SEEN).toBe(Flag.SEEN);
    expect(row!.receivedAt?.toISOString()).toBe("2026-09-13T07:05:09.000Z");
    // Re-appending the same Message-ID is a no-op that still points at it.
    const again = await c.ok(`APPEND INBOX {${enc.encode(raw).length}+}\r\n${raw}`);
    expect(again[again.length - 1]).toMatch(/APPENDUID \d+ 1\]/);
    expect(await db().query.message.findMany()).toHaveLength(1);
  });

  it("files into Sent as outbound and refuses unknown folders", async () => {
    const c = connect();
    await c.login();
    const raw = new TextDecoder().decode(
      eml({ subject: "Copy", from: `Team <${ADDRESS}>`, to: "x@y.test" }),
    );
    await c.ok(`APPEND Sent {${enc.encode(raw).length}+}\r\n${raw}`);
    const row = await db().query.message.findFirst({ where: eq(message.subject, "Copy") });
    expect(row!.direction).toBe("out");
    const miss = await c.cmd(`APPEND Nope {${enc.encode(raw).length}+}\r\n${raw}`);
    expect(miss.last).toMatch(/NO \[TRYCREATE\]/);
  });
});

describe("rbac", () => {
  it("lets a read-only member read and flag but not trash or append", async () => {
    await grantMember(db(), Perm.READ);
    await issuePassword(MEMBER_ID, MEMBER_PASSWORD);
    await ingest({ subject: "shared" });
    const c = connect();
    await c.login(ADDRESS, MEMBER_PASSWORD);
    await c.ok("SELECT INBOX");
    await c.ok("STORE 1 +FLAGS (\\Seen)");
    expect((await c.cmd("UID MOVE 1 Trash")).last).toMatch(/NO \[NOPERM\]/);
    await c.ok("STORE 1 +FLAGS (\\Deleted)");
    expect((await c.cmd("EXPUNGE")).last).toMatch(/NO \[NOPERM\]/);
    const raw = new TextDecoder().decode(eml({ subject: "nope" }));
    expect((await c.cmd(`APPEND INBOX {${enc.encode(raw).length}+}\r\n${raw}`)).last).toMatch(
      /NO \[NOPERM\]/,
    );
    // Filing into their own folder is personal organization — allowed.
    await c.ok('CREATE "Mine"');
    await c.ok("UID MOVE 1 Mine");
  });
});

describe("live updates", () => {
  it("NOOP reports flag changes made elsewhere", async () => {
    const { messageId } = await ingest({ subject: "live" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    await db()
      .update(message)
      .set({ flags: Flag.SEEN | Flag.STARRED })
      .where(eq(message.id, messageId));
    const noop = await c.ok("NOOP");
    expect(noop).toContain("* 1 FETCH (FLAGS (\\Seen \\Flagged) UID 1)");
  });

  it("IDLE wakes on a hub event and reports new mail", async () => {
    await ingest({ subject: "before" });
    const c = connect();
    await c.login();
    await c.ok("SELECT INBOX");
    await c.write("A99 IDLE\r\n");
    await c.readUntil((l) => l === "+ idling");
    const res = await ingest({ subject: "after", date: "Tue, 2 Jan 2024 10:00:00 +0000" });
    await broadcastToUsers(e, [OWNER_ID], {
      type: "new_message",
      mailboxId: MAILBOX_ID,
      messageId: res.messageId,
      threadId: res.threadId,
    });
    await c.readUntil((l) => l === "* 2 EXISTS");
    await c.write("DONE\r\n");
    const rest = await c.readUntil((l) => l.startsWith("A99 "));
    expect(rest[rest.length - 1]).toBe("A99 OK IDLE terminated");
    expect((await c.ok("FETCH 2 ENVELOPE"))[0]).toContain('"after"');
  });

  it("a second session sees the first session's changes", async () => {
    await ingest({ subject: "shared" });
    const a = connect();
    const b = connect();
    await a.login();
    await b.login();
    await a.ok("SELECT INBOX");
    await b.ok("SELECT INBOX");
    await a.ok("STORE 1 +FLAGS.SILENT (\\Flagged)");
    const seen = await b.ok("NOOP");
    expect(seen).toContain("* 1 FETCH (FLAGS (\\Flagged) UID 1)");
  });
});

describe("session hygiene", () => {
  it("rejects oversized non-APPEND literals without dropping the connection", async () => {
    const c = connect();
    await c.login();
    await c.write("A5 LOGIN {100000}\r\n");
    await c.readUntil((l) => l.startsWith("* NO [TOOBIG]"));
    expect((await c.cmd("NOOP")).status).toBe("OK");
  });

  it("answers BAD for garbage and unknown commands", async () => {
    const c = connect();
    await c.login();
    expect((await c.cmd("FROBNICATE")).status).toBe("BAD");
    expect((await c.cmd("FETCH 1 FLAGS")).status).toBe("NO");
  });

  it("LOGOUT says BYE and ends the session", async () => {
    const c = connect();
    await c.login();
    const r = await c.cmd("LOGOUT");
    expect(r.lines[0]).toMatch(/^\* BYE/);
    expect(r.last).toMatch(/OK LOGOUT completed$/);
    await c.done;
  });
});
