// One IMAP connection: greeting → (LOGIN/AUTHENTICATE) → folder commands →
// LOGOUT. Wire parsing is protocol.ts, mail semantics are store.ts; this file
// is the RFC 3501 state machine and response formatting in between.
//
// Untagged EXISTS/EXPUNGE/FETCH FLAGS updates are produced by diffing the
// selected folder's snapshot against a fresh reconcile (`sync`), which runs at
// the points the RFC allows EXPUNGE to be sent: NOOP/CHECK, UID commands,
// IDLE wake-ups, and after this session's own mutations.
/* eslint-disable no-await-in-loop -- responses must be written in protocol order */

import type { DB } from "@cfmail/db";
import { Flag } from "@cfmail/shared/flags";
import { loginWithAppPassword } from "../app-passwords.ts";
import type { Env } from "../env.ts";
import { AppError } from "../errors.ts";
import { MAX_EMAIL_BYTES } from "../mail/ingest.ts";
import {
  extractSection,
  parseSectionSpec,
  renderBodyStructure,
  renderEnvelope,
  type Section,
  sectionLabel,
} from "./fetch.ts";
import { HubListener } from "./hub-listener.ts";
import { type MimePart, parseMimeTree } from "./mime-tree.ts";
import {
  astring,
  bytesToString,
  decodeMutf7,
  encodeMutf7,
  expandSequenceSet,
  formatDateTime,
  isSequenceSet,
  joinParts,
  LineReader,
  LiteralTooLarge,
  literal,
  matchesPattern,
  ProtocolError,
  parseDateTime,
  readCommand,
  type Tok,
  tokAtom,
  tokenize,
  tokList,
  tokString,
} from "./protocol.ts";
import { evaluateSearch, parseSearchKeys } from "./search.ts";
import {
  type FolderRef,
  type FolderView,
  flagsOf,
  ImapStore,
  internalDate,
  specialUseOf,
  type UidEntry,
} from "./store.ts";

const DELIM = "/";
const PRE_AUTH_CAPS = ["IMAP4rev1", "LITERAL+", "SASL-IR", "AUTH=PLAIN"];
const AUTH_CAPS = [
  ...PRE_AUTH_CAPS,
  "IDLE",
  "NAMESPACE",
  "ID",
  "UIDPLUS",
  "MOVE",
  "UNSELECT",
  "CHILDREN",
  "SPECIAL-USE",
  "LIST-STATUS",
  "ENABLE",
];
const FLAGS_LIST = "(\\Answered \\Flagged \\Deleted \\Seen \\Draft)";
const PERMANENT_FLAGS = "(\\Flagged \\Deleted \\Seen \\Draft)";
// RFC 3501 requires at least 30 minutes before an autologout.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// While IDLE, re-reconcile on a timer too: peers' changes that aren't broadcast
// to this user (another member trashing a thread) surface within this window.
const IDLE_POLL_MS = 3 * 60 * 1000;
const NON_APPEND_LITERAL_MAX = 64 * 1024;
const IMAP_FLAG_BITS = Flag.SEEN | Flag.STARRED | Flag.DELETED | Flag.DRAFT;
// Commands that need a selected mailbox. Anything outside this set (and the
// earlier state-independent lists) is an unknown command, not a state error.
const SELECTED_COMMANDS = new Set([
  "CLOSE",
  "UNSELECT",
  "EXPUNGE",
  "SEARCH",
  "FETCH",
  "STORE",
  "COPY",
  "MOVE",
  "UID",
]);

type Part = string | Uint8Array;

export interface SessionSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

interface Selected {
  view: FolderView;
  readOnly: boolean;
}

export class ImapSession {
  private state: "unauth" | "auth" | "logout" = "unauth";
  private store: ImapStore | null = null;
  private selected: Selected | null = null;
  private hub: HubListener | null = null;
  private readonly reader: LineReader;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socket: SessionSocket,
    private readonly env: Env,
    private readonly db: DB,
    private readonly clientIp: string | null,
  ) {
    this.reader = new LineReader(socket.readable.getReader());
    this.writer = socket.writable.getWriter();
  }

  async run(): Promise<void> {
    try {
      await this.send(`* OK [CAPABILITY ${PRE_AUTH_CAPS.join(" ")}] cfmail IMAP4rev1 ready`);
      while (this.state !== "logout") {
        const cmd = await this.readNext();
        if (cmd === null) break;
        await this.handle(cmd);
      }
    } catch (err) {
      if (!(err instanceof ConnectionClosed)) console.error("imap session error", err);
    } finally {
      await this.teardown();
    }
  }

  private async teardown(): Promise<void> {
    this.state = "logout";
    this.hub?.close();
    this.hub = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.writer.close();
    } catch {
      // peer already gone
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }

  // ─── I/O ──────────────────────────────────────────────────────────────────

  private async send(...parts: Part[]): Promise<void> {
    try {
      await this.writer.write(joinParts([...parts, "\r\n"]));
    } catch {
      throw new ConnectionClosed();
    }
  }

  private async tagged(tag: string, status: "OK" | "NO" | "BAD", text: string): Promise<void> {
    await this.send(`${tag} ${status} ${text}`);
  }

  // Next full command, or null when the peer disconnected or went silent past
  // the autologout window.
  private async readNext(): Promise<Uint8Array | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), IDLE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        readCommand(
          this.reader,
          () => this.send("+ Ready for literal data"),
          (acc, size) => size <= (isAppendLine(acc) ? MAX_EMAIL_BYTES : NON_APPEND_LITERAL_MAX),
        ),
        timeout,
      ]);
      if (result === "timeout") {
        await this.send("* BYE Autologout; idle for too long");
        return null;
      }
      return result;
    } catch (err) {
      if (err instanceof LiteralTooLarge) {
        // The client hasn't sent the literal yet (no continuation was given),
        // so it's safe to reject and keep the connection.
        await this.send("* NO [TOOBIG] literal too large");
        return this.readNext();
      }
      if (err instanceof ProtocolError) {
        await this.send(`* BAD ${err.message}`);
        return this.readNext();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  private async handle(buf: Uint8Array): Promise<void> {
    let toks: Tok[];
    try {
      toks = tokenize(buf);
    } catch (err) {
      await this.send(`* BAD ${err instanceof Error ? err.message : "parse error"}`);
      return;
    }
    const tag = tokAtom(toks[0]);
    const name = tokAtom(toks[1])?.toUpperCase();
    if (!tag || !name) {
      await this.send("* BAD Invalid command");
      return;
    }
    const args = toks.slice(2);
    try {
      await this.dispatch(tag, name, args);
    } catch (err) {
      if (err instanceof ConnectionClosed) throw err;
      if (err instanceof AppError) {
        const code =
          err.code === "forbidden"
            ? "[NOPERM] "
            : err.code === "not_found"
              ? "[NONEXISTENT] "
              : err.code === "rate_limited"
                ? "[LIMIT] "
                : "";
        await this.tagged(tag, "NO", `${code}${err.message}`);
        return;
      }
      if (err instanceof ProtocolError) {
        await this.tagged(tag, "BAD", err.message);
        return;
      }
      console.error(`imap ${name} failed`, err);
      await this.tagged(tag, "NO", `${name} failed`);
    }
  }

  private async dispatch(tag: string, name: string, args: Tok[]): Promise<void> {
    switch (name) {
      case "CAPABILITY":
        await this.send(`* CAPABILITY ${this.caps().join(" ")}`);
        return this.tagged(tag, "OK", "CAPABILITY completed");
      case "NOOP":
      case "CHECK":
        await this.sync();
        return this.tagged(tag, "OK", `${name} completed`);
      case "LOGOUT":
        await this.send("* BYE cfmail logging out");
        await this.tagged(tag, "OK", "LOGOUT completed");
        this.state = "logout";
        return;
      case "ID":
        await this.send('* ID ("name" "cfmail" "vendor" "cloudflare-mail")');
        return this.tagged(tag, "OK", "ID completed");
      case "STARTTLS":
        return this.tagged(
          tag,
          "NO",
          "TLS is terminated before the server; connect on the TLS port",
        );
    }

    if (this.state === "unauth") {
      switch (name) {
        case "LOGIN":
          return this.cmdLogin(tag, args);
        case "AUTHENTICATE":
          return this.cmdAuthenticate(tag, args);
        default:
          return this.tagged(tag, "NO", "Please authenticate first");
      }
    }

    switch (name) {
      case "LOGIN":
      case "AUTHENTICATE":
        return this.tagged(tag, "BAD", "Already authenticated");
      case "ENABLE":
        await this.send("* ENABLED");
        return this.tagged(tag, "OK", "ENABLE completed");
      case "NAMESPACE":
        await this.send(`* NAMESPACE (("" "${DELIM}")) NIL NIL`);
        return this.tagged(tag, "OK", "NAMESPACE completed");
      case "SELECT":
      case "EXAMINE":
        return this.cmdSelect(tag, args, name === "EXAMINE");
      case "CREATE":
        return this.cmdCreate(tag, args);
      case "DELETE":
        return this.cmdDelete(tag, args);
      case "RENAME":
        return this.cmdRename(tag, args);
      case "SUBSCRIBE":
      case "UNSUBSCRIBE":
        return this.tagged(tag, "OK", `${name} completed`);
      case "LIST":
      case "LSUB":
      case "XLIST":
        return this.cmdList(tag, args, name);
      case "STATUS":
        return this.cmdStatus(tag, args);
      case "APPEND":
        return this.cmdAppend(tag, args);
      case "IDLE":
        return this.cmdIdle(tag);
    }

    if (!SELECTED_COMMANDS.has(name)) return this.tagged(tag, "BAD", `Unknown command ${name}`);
    if (!this.selected) return this.tagged(tag, "NO", "No mailbox selected");

    switch (name) {
      case "CLOSE":
        return this.cmdClose(tag);
      case "UNSELECT":
        this.selected = null;
        return this.tagged(tag, "OK", "UNSELECT completed");
      case "EXPUNGE":
        return this.cmdExpunge(tag, null);
      case "SEARCH":
        return this.cmdSearch(tag, args, false);
      case "FETCH":
        return this.cmdFetch(tag, args, false);
      case "STORE":
        return this.cmdStore(tag, args, false);
      case "COPY":
        return this.tagged(tag, "NO", "[CANNOT] COPY is not supported; use MOVE");
      case "MOVE":
        return this.cmdMove(tag, args, false);
      case "UID": {
        const sub = tokAtom(args[0])?.toUpperCase();
        const rest = args.slice(1);
        switch (sub) {
          case "FETCH":
            return this.cmdFetch(tag, rest, true);
          case "STORE":
            return this.cmdStore(tag, rest, true);
          case "SEARCH":
            return this.cmdSearch(tag, rest, true);
          case "COPY":
            return this.tagged(tag, "NO", "[CANNOT] COPY is not supported; use MOVE");
          case "MOVE":
            return this.cmdMove(tag, rest, true);
          case "EXPUNGE":
            return this.cmdExpunge(tag, tokString(rest[0]));
          default:
            return this.tagged(tag, "BAD", "Unknown UID command");
        }
      }
      default:
        return this.tagged(tag, "BAD", `Unknown command ${name}`);
    }
  }

  private caps(): string[] {
    return this.state === "unauth" ? PRE_AUTH_CAPS : AUTH_CAPS;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  private async cmdLogin(tag: string, args: Tok[]): Promise<void> {
    const user = tokString(args[0]);
    const pass = tokString(args[1]);
    if (user === null || pass === null)
      return this.tagged(tag, "BAD", "LOGIN needs user and password");
    await this.finishLogin(tag, user, pass);
  }

  private async cmdAuthenticate(tag: string, args: Tok[]): Promise<void> {
    const mech = tokAtom(args[0])?.toUpperCase();
    if (mech !== "PLAIN") return this.tagged(tag, "NO", "Unsupported authentication mechanism");
    let ir = tokString(args[1]);
    if (ir === null) {
      await this.send("+ ");
      const line = await this.reader.readLine();
      if (line === null) throw new ConnectionClosed();
      ir = bytesToString(line).trim();
    }
    if (ir === "*") return this.tagged(tag, "BAD", "Authentication cancelled");
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(
        Uint8Array.from(atob(ir === "=" ? "" : ir), (c) => c.charCodeAt(0)),
      );
    } catch {
      return this.tagged(tag, "BAD", "Invalid base64");
    }
    const parts = decoded.split("\0");
    if (parts.length !== 3) return this.tagged(tag, "BAD", "Invalid PLAIN response");
    await this.finishLogin(tag, parts[1]!, parts[2]!);
  }

  private async finishLogin(tag: string, username: string, password: string): Promise<void> {
    const login = await loginWithAppPassword(this.db, username, password, this.clientIp);
    if (!login) return this.tagged(tag, "NO", "[AUTHENTICATIONFAILED] Invalid credentials");
    this.store = new ImapStore(this.env, this.db, login);
    this.state = "auth";
    this.hub = new HubListener(this.env, login.userId, login.mailboxId);
    this.hub.start();
    await this.tagged(tag, "OK", `[CAPABILITY ${AUTH_CAPS.join(" ")}] Logged in`);
  }

  // ─── Folder commands ──────────────────────────────────────────────────────

  private async folderArg(t: Tok | undefined): Promise<FolderRef | null> {
    const raw = tokString(t);
    if (raw === null) throw new ProtocolError("mailbox name required");
    return this.store!.resolveFolder(decodeMutf7(raw).replace(/\/+$/, ""));
  }

  private async cmdSelect(tag: string, args: Tok[], readOnly: boolean): Promise<void> {
    this.selected = null;
    const ref = await this.folderArg(args[0]);
    if (!ref) return this.tagged(tag, "NO", "[NONEXISTENT] No such mailbox");
    const view = await this.store!.loadView(ref);
    this.selected = { view, readOnly };
    const unseenIdx = view.entries.findIndex((e) => !(e.msg.flags & Flag.SEEN));
    await this.send(`* FLAGS ${FLAGS_LIST}`);
    await this.send(
      readOnly
        ? "* OK [PERMANENTFLAGS ()] Read-only mailbox"
        : `* OK [PERMANENTFLAGS ${PERMANENT_FLAGS}] Flags permitted`,
    );
    await this.send(`* ${view.entries.length} EXISTS`);
    await this.send("* 0 RECENT");
    if (unseenIdx !== -1) await this.send(`* OK [UNSEEN ${unseenIdx + 1}] First unseen`);
    await this.send(`* OK [UIDVALIDITY ${view.state.uidValidity}] UIDs valid`);
    await this.send(`* OK [UIDNEXT ${view.state.uidNext}] Predicted next UID`);
    this.hub?.take();
    await this.tagged(
      tag,
      "OK",
      `[${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${readOnly ? "EXAMINE" : "SELECT"} completed`,
    );
  }

  private async cmdCreate(tag: string, args: Tok[]): Promise<void> {
    const raw = tokString(args[0]);
    if (raw === null) return this.tagged(tag, "BAD", "CREATE needs a name");
    const name = decodeMutf7(raw).replace(/\/+$/, "");
    if (name.toUpperCase() === "INBOX") return this.tagged(tag, "NO", "INBOX already exists");
    await this.store!.createFolder(name);
    await this.tagged(tag, "OK", "CREATE completed");
  }

  private async cmdDelete(tag: string, args: Tok[]): Promise<void> {
    const ref = await this.folderArg(args[0]);
    if (!ref) return this.tagged(tag, "NO", "[NONEXISTENT] No such mailbox");
    if (this.selected?.view.ref.key === ref.key) this.selected = null;
    await this.store!.deleteFolder(ref);
    await this.tagged(tag, "OK", "DELETE completed");
  }

  private async cmdRename(tag: string, args: Tok[]): Promise<void> {
    const ref = await this.folderArg(args[0]);
    const to = tokString(args[1]);
    if (!ref) return this.tagged(tag, "NO", "[NONEXISTENT] No such mailbox");
    if (to === null) return this.tagged(tag, "BAD", "RENAME needs a new name");
    await this.store!.renameFolder(ref, decodeMutf7(to).replace(/\/+$/, ""));
    await this.tagged(tag, "OK", "RENAME completed");
  }

  // LIST / LSUB with the RFC 5258 extras clients actually send: selection
  // options are ignored (everything is subscribed), RETURN (SPECIAL-USE |
  // STATUS (...)) is honored.
  private async cmdList(tag: string, args: Tok[], verb: string): Promise<void> {
    let i = 0;
    if (args[i]?.t === "list") i++; // selection options
    const ref = tokString(args[i++]);
    const patTok = args[i++];
    if (ref === null || !patTok)
      return this.tagged(tag, "BAD", `${verb} needs reference and pattern`);
    const patterns =
      patTok.t === "list"
        ? patTok.v.map((t) => tokString(t)).filter((s): s is string => s !== null)
        : [tokString(patTok) ?? ""];
    let statusItems: string[] | null = null;
    if (tokAtom(args[i])?.toUpperCase() === "RETURN") {
      const opts = tokList(args[i + 1]) ?? [];
      for (let k = 0; k < opts.length; k++) {
        if (tokAtom(opts[k])?.toUpperCase() === "STATUS") {
          statusItems = (tokList(opts[k + 1]) ?? []).map((t) => tokAtom(t)?.toUpperCase() ?? "");
          k++;
        }
      }
    }
    const listVerb = verb === "LSUB" ? "LSUB" : "LIST";
    const folders = await this.store!.listFolders();
    for (const pattern of patterns) {
      const full = decodeMutf7(ref) + decodeMutf7(pattern);
      if (full === "") {
        await this.send(`* ${listVerb} (\\Noselect) "${DELIM}" ""`);
        continue;
      }
      for (const f of folders) {
        if (!matchesPattern(f.name, full, DELIM)) continue;
        const attrs = ["\\HasNoChildren"];
        const special = specialUseOf(f);
        if (special) attrs.push(special);
        await this.send(
          `* ${listVerb} (${attrs.join(" ")}) "${DELIM}" `,
          astring(encodeMutf7(f.name)),
        );
        if (statusItems) await this.sendStatus(f, statusItems);
      }
    }
    await this.tagged(tag, "OK", `${verb} completed`);
  }

  private async cmdStatus(tag: string, args: Tok[]): Promise<void> {
    const ref = await this.folderArg(args[0]);
    if (!ref) return this.tagged(tag, "NO", "[NONEXISTENT] No such mailbox");
    const items = (tokList(args[1]) ?? []).map((t) => tokAtom(t)?.toUpperCase() ?? "");
    await this.sendStatus(ref, items);
    await this.tagged(tag, "OK", "STATUS completed");
  }

  private async sendStatus(ref: FolderRef, items: string[]): Promise<void> {
    // STATUS on the selected folder must not disturb its snapshot; use a
    // separate load (same UID space, so numbers agree).
    const view =
      this.selected && this.selected.view.ref.key === ref.key
        ? this.selected.view
        : await this.store!.loadView(ref);
    const out: string[] = [];
    for (const it of items) {
      switch (it) {
        case "MESSAGES":
          out.push(`MESSAGES ${view.entries.length}`);
          break;
        case "UNSEEN":
          out.push(`UNSEEN ${view.entries.filter((e) => !(e.msg.flags & Flag.SEEN)).length}`);
          break;
        case "UIDNEXT":
          out.push(`UIDNEXT ${view.state.uidNext}`);
          break;
        case "UIDVALIDITY":
          out.push(`UIDVALIDITY ${view.state.uidValidity}`);
          break;
        case "RECENT":
          out.push("RECENT 0");
          break;
        case "HIGHESTMODSEQ":
          out.push("HIGHESTMODSEQ 1");
          break;
      }
    }
    await this.send("* STATUS ", astring(encodeMutf7(ref.name)), ` (${out.join(" ")})`);
  }

  private async cmdAppend(tag: string, args: Tok[]): Promise<void> {
    const ref = await this.folderArg(args[0]);
    if (!ref) return this.tagged(tag, "NO", "[TRYCREATE] No such mailbox");
    let i = 1;
    let flags: string[] = [];
    if (args[i]?.t === "list") {
      flags = (tokList(args[i]) ?? []).map((t) => tokAtom(t) ?? "");
      i++;
    }
    let date: Date | null = null;
    if (args[i]?.t === "str") {
      date = parseDateTime(tokString(args[i]) ?? "");
      if (!date) return this.tagged(tag, "BAD", "Invalid date-time");
      i++;
    }
    const lit = args[i];
    if (lit?.t !== "lit") return this.tagged(tag, "BAD", "APPEND needs a message literal");
    const result = await this.store!.append(ref, lit.v, flags, date);
    const view = await this.store!.loadView(ref);
    const entry = view.entries.find((e) => e.msg.id === result.messageId);
    if (this.selected?.view.ref.key === ref.key) await this.sync();
    const code = entry ? `[APPENDUID ${view.state.uidValidity} ${entry.uid}] ` : "";
    await this.tagged(tag, "OK", `${code}APPEND completed`);
  }

  // ─── IDLE ─────────────────────────────────────────────────────────────────

  private async cmdIdle(tag: string): Promise<void> {
    await this.send("+ idling");
    const done = this.reader.readLine();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<"tick">((resolve) => {
        timer = setTimeout(() => resolve("tick"), IDLE_POLL_MS);
      });
      const result = await Promise.race([done, this.hub?.wait() ?? new Promise(() => {}), tick]);
      if (timer) clearTimeout(timer);
      if (result instanceof Uint8Array || result === null) {
        if (result === null) throw new ConnectionClosed();
        const line = bytesToString(result).trim().toUpperCase();
        await this.tagged(
          tag,
          line === "DONE" ? "OK" : "BAD",
          line === "DONE" ? "IDLE terminated" : "Expected DONE",
        );
        return;
      }
      if (this.hub?.mailboxGone) {
        await this.send("* BYE Mailbox no longer exists");
        this.state = "logout";
        return;
      }
      // The DONE read is still outstanding, so a failed reconcile must not
      // unwind past this loop (that would leave two readers on the socket).
      try {
        await this.sync();
      } catch (err) {
        if (err instanceof ConnectionClosed) throw err;
        console.error("imap idle sync failed", err);
      }
    }
  }

  // ─── Selected-state commands ──────────────────────────────────────────────

  private async cmdClose(tag: string): Promise<void> {
    const sel = this.selected!;
    if (!sel.readOnly) {
      const doomed = sel.view.entries.filter((e) => e.msg.flags & Flag.DELETED);
      if (doomed.length) await this.store!.expunge(sel.view.ref, doomed);
    }
    this.selected = null;
    await this.tagged(tag, "OK", "CLOSE completed");
  }

  private async cmdExpunge(tag: string, uidSet: string | null): Promise<void> {
    const sel = this.selected!;
    if (sel.readOnly) return this.tagged(tag, "NO", "[READ-ONLY] Mailbox is read-only");
    let doomed = sel.view.entries.filter((e) => e.msg.flags & Flag.DELETED);
    if (uidSet !== null) {
      const uids = new Set(
        expandSequenceSet(
          uidSet,
          sel.view.entries.map((e) => e.uid),
        ),
      );
      doomed = doomed.filter((e) => uids.has(e.uid));
    }
    if (doomed.length) await this.store!.expunge(sel.view.ref, doomed);
    await this.sync();
    await this.tagged(tag, "OK", "EXPUNGE completed");
  }

  private resolveSet(spec: string | null, uid: boolean): UidEntry[] {
    if (spec === null || !isSequenceSet(spec)) throw new ProtocolError("Invalid sequence set");
    const entries = this.selected!.view.entries;
    if (uid) {
      const wanted = new Set(
        expandSequenceSet(
          spec,
          entries.map((e) => e.uid),
        ),
      );
      return entries.filter((e) => wanted.has(e.uid));
    }
    const seqs = expandSequenceSet(
      spec,
      entries.map((_, i) => i + 1),
    );
    return seqs.map((n) => entries[n - 1]!);
  }

  private seqOf(entry: UidEntry): number {
    return this.selected!.view.entries.indexOf(entry) + 1;
  }

  private async cmdSearch(tag: string, args: Tok[], uid: boolean): Promise<void> {
    let keys = args;
    if (tokAtom(keys[0])?.toUpperCase() === "CHARSET") {
      const cs = (tokString(keys[1]) ?? "").toUpperCase();
      if (cs !== "UTF-8" && cs !== "US-ASCII") {
        return this.tagged(tag, "NO", "[BADCHARSET (US-ASCII UTF-8)] Unsupported charset");
      }
      keys = keys.slice(2);
    }
    const node = parseSearchKeys(keys);
    const sel = this.selected!;
    const hits = await evaluateSearch(node, {
      entries: sel.view.entries,
      raw: (e) => this.store!.raw(e.msg),
    });
    const nums = hits.map((e) => (uid ? e.uid : this.seqOf(e)));
    await this.send(`* SEARCH${nums.length ? ` ${nums.join(" ")}` : ""}`);
    if (uid) await this.sync();
    await this.tagged(tag, "OK", `${uid ? "UID " : ""}SEARCH completed`);
  }

  private async cmdStore(tag: string, args: Tok[], uid: boolean): Promise<void> {
    const sel = this.selected!;
    if (sel.readOnly) return this.tagged(tag, "NO", "[READ-ONLY] Mailbox is read-only");
    const entries = this.resolveSet(tokString(args[0]), uid);
    const op = (tokAtom(args[1]) ?? "").toUpperCase();
    const m = /^([+-]?)FLAGS(\.SILENT)?$/.exec(op);
    if (!m) return this.tagged(tag, "BAD", "Invalid STORE attribute");
    const mode = m[1] === "+" ? "add" : m[1] === "-" ? "remove" : "set";
    const silent = !!m[2];
    const flagTok = args[2];
    const flags = (flagTok?.t === "list" ? flagTok.v : args.slice(2)).map((t) => tokAtom(t) ?? "");
    await this.store!.storeFlags(entries, mode, flags);
    if (!silent) {
      for (const e of entries) {
        const uidPart = uid ? ` UID ${e.uid}` : "";
        await this.send(`* ${this.seqOf(e)} FETCH (FLAGS (${flagsOf(e).join(" ")})${uidPart})`);
      }
    }
    if (uid) await this.sync();
    await this.tagged(tag, "OK", `${uid ? "UID " : ""}STORE completed`);
  }

  private async cmdMove(tag: string, args: Tok[], uid: boolean): Promise<void> {
    const sel = this.selected!;
    if (sel.readOnly) return this.tagged(tag, "NO", "[READ-ONLY] Mailbox is read-only");
    const entries = this.resolveSet(tokString(args[0]), uid);
    const target = await this.folderArg(args[1]);
    if (!target) return this.tagged(tag, "NO", "[TRYCREATE] No such mailbox");
    if (entries.length === 0) return this.tagged(tag, "OK", "MOVE completed");
    await this.store!.moveMessages(sel.view.ref, entries, target);
    // COPYUID (RFC 6851 §3.3): report where the messages landed when they all
    // resolved to a UID in the target.
    const dest = await this.store!.loadView(target);
    const byMsg = new Map(dest.entries.map((e) => [e.msg.id, e.uid]));
    const srcUids: number[] = [];
    const dstUids: number[] = [];
    for (const e of entries) {
      const d = byMsg.get(e.msg.id);
      if (d === undefined) continue;
      srcUids.push(e.uid);
      dstUids.push(d);
    }
    if (dstUids.length === entries.length) {
      await this.send(
        `* OK [COPYUID ${dest.state.uidValidity} ${compressSet(srcUids)} ${compressSet(dstUids)}] Moved`,
      );
    }
    await this.sync();
    await this.tagged(tag, "OK", `${uid ? "UID " : ""}MOVE completed`);
  }

  // ─── FETCH ────────────────────────────────────────────────────────────────

  private async cmdFetch(tag: string, args: Tok[], uid: boolean): Promise<void> {
    const sel = this.selected!;
    const entries = this.resolveSet(tokString(args[0]), uid);
    const items = parseFetchItems(args.slice(1));
    if (uid && !items.some((i) => i.kind === "UID")) items.push({ kind: "UID" });

    // A non-PEEK body fetch implicitly sets \Seen; do it in one batch first so
    // every response already shows the new flags.
    const setsSeen = items.some((i) => i.kind === "BODY[]" && !i.peek);
    let flagged = new Set<string>();
    if (setsSeen && !sel.readOnly) {
      const unseen = entries.filter((e) => !(e.msg.flags & Flag.SEEN));
      if (unseen.length) {
        await this.store!.storeFlags(unseen, "add", ["\\Seen"]);
        flagged = new Set(unseen.map((e) => e.msg.id));
      }
    }
    const wantFlags = items.some((i) => i.kind === "FLAGS");
    const needsRaw = items.some(
      (i) => i.kind === "ENVELOPE" || i.kind === "BODYSTRUCTURE" || i.kind === "BODY[]",
    );

    for (const e of entries) {
      const parts: Part[] = [];
      let raw: Uint8Array | null = null;
      let tree: MimePart | null = null;
      if (needsRaw) {
        raw = await this.store!.raw(e.msg);
        tree = parseMimeTree(raw);
      }
      const push = (...p: Part[]) => {
        if (parts.length) parts.push(" ");
        parts.push(...p);
      };
      for (const it of items) {
        switch (it.kind) {
          case "UID":
            push(`UID ${e.uid}`);
            break;
          case "FLAGS":
            push(`FLAGS (${flagsOf(e).join(" ")})`);
            break;
          case "INTERNALDATE":
            push(`INTERNALDATE "${formatDateTime(internalDate(e.msg))}"`);
            break;
          case "RFC822.SIZE":
            push(`RFC822.SIZE ${raw ? raw.length : e.msg.sizeBytes}`);
            break;
          case "ENVELOPE":
            push("ENVELOPE ", ...renderEnvelope(tree!.headers));
            break;
          case "BODYSTRUCTURE":
            push(
              `${it.extended ? "BODYSTRUCTURE" : "BODY"} `,
              ...renderBodyStructure(tree!, it.extended),
            );
            break;
          case "BODY[]": {
            const bytes = extractSection(raw!, tree!, it.section);
            const name = it.label === "BODY" ? `BODY[${sectionLabel(it.section)}]` : it.label;
            if (bytes === null) {
              push(`${name} NIL`);
              break;
            }
            let out = bytes;
            let origin = "";
            if (it.partial) {
              const [start, count] = it.partial;
              out = bytes.subarray(start, start + count);
              origin = `<${start}>`;
            }
            push(`${name}${origin} `, literal(out));
            break;
          }
        }
      }
      if (!wantFlags && flagged.has(e.msg.id)) push(`FLAGS (${flagsOf(e).join(" ")})`);
      await this.send(`* ${this.seqOf(e)} FETCH (`, ...parts, ")");
    }
    if (uid) await this.sync();
    await this.tagged(tag, "OK", `${uid ? "UID " : ""}FETCH completed`);
  }

  // ─── Untagged updates ─────────────────────────────────────────────────────

  // Re-reconcile the selected folder and emit what changed. Safe to call
  // anywhere EXPUNGE responses are allowed.
  private async sync(): Promise<void> {
    this.hub?.take();
    if (!this.selected || !this.store) return;
    const old = this.selected.view.entries;
    const fresh = await this.store.loadView(this.selected.view.ref);
    const freshUids = new Set(fresh.entries.map((e) => e.uid));
    let expunged = 0;
    for (let i = old.length - 1; i >= 0; i--) {
      if (!freshUids.has(old[i]!.uid)) {
        await this.send(`* ${i + 1} EXPUNGE`);
        expunged++;
      }
    }
    const oldByUid = new Map(old.map((e) => [e.uid, e]));
    const appeared = fresh.entries.some((e) => !oldByUid.has(e.uid));
    if (appeared || fresh.entries.length !== old.length - expunged) {
      await this.send(`* ${fresh.entries.length} EXISTS`);
    }
    for (let i = 0; i < fresh.entries.length; i++) {
      const e = fresh.entries[i]!;
      const o = oldByUid.get(e.uid);
      if (!o) continue;
      const changed =
        (o.msg.flags & IMAP_FLAG_BITS) !== (e.msg.flags & IMAP_FLAG_BITS) ||
        o.answered !== e.answered;
      if (changed)
        await this.send(`* ${i + 1} FETCH (FLAGS (${flagsOf(e).join(" ")}) UID ${e.uid})`);
    }
    this.selected.view = fresh;
  }
}

class ConnectionClosed extends Error {}

function isAppendLine(acc: Uint8Array): boolean {
  const head = bytesToString(acc.subarray(0, Math.min(acc.length, 200)));
  return /^\S+\s+APPEND\s/i.test(head);
}

// ─── FETCH item parsing ─────────────────────────────────────────────────────

type FetchItem =
  | { kind: "UID" | "FLAGS" | "INTERNALDATE" | "RFC822.SIZE" | "ENVELOPE" }
  | { kind: "BODYSTRUCTURE"; extended: boolean }
  | {
      kind: "BODY[]";
      section: Section;
      peek: boolean;
      partial: [number, number] | null;
      label: string;
    };

function parseFetchItems(args: Tok[]): FetchItem[] {
  const toks = args.length === 1 && args[0]?.t === "list" ? args[0].v : args;
  const out: FetchItem[] = [];
  for (const t of toks) {
    if (t.t === "sect") {
      const base = t.base.toUpperCase();
      const peek = base === "BODY.PEEK";
      if (base !== "BODY" && !peek) throw new ProtocolError(`Invalid fetch item ${t.base}`);
      const spec = t.v.map((x) =>
        x.t === "list" ? x.v.map((y) => tokString(y) ?? "") : (tokString(x) ?? ""),
      );
      const section = parseSectionSpec(spec);
      if (!section) throw new ProtocolError("Invalid BODY section");
      out.push({ kind: "BODY[]", section, peek, partial: t.partial, label: "BODY" });
      continue;
    }
    const name = (tokAtom(t) ?? "").toUpperCase();
    switch (name) {
      case "ALL":
        out.push(
          { kind: "FLAGS" },
          { kind: "INTERNALDATE" },
          { kind: "RFC822.SIZE" },
          { kind: "ENVELOPE" },
        );
        break;
      case "FAST":
        out.push({ kind: "FLAGS" }, { kind: "INTERNALDATE" }, { kind: "RFC822.SIZE" });
        break;
      case "FULL":
        out.push(
          { kind: "FLAGS" },
          { kind: "INTERNALDATE" },
          { kind: "RFC822.SIZE" },
          { kind: "ENVELOPE" },
          { kind: "BODYSTRUCTURE", extended: false },
        );
        break;
      case "UID":
      case "FLAGS":
      case "INTERNALDATE":
      case "RFC822.SIZE":
      case "ENVELOPE":
        out.push({ kind: name });
        break;
      case "BODY":
        out.push({ kind: "BODYSTRUCTURE", extended: false });
        break;
      case "BODYSTRUCTURE":
        out.push({ kind: "BODYSTRUCTURE", extended: true });
        break;
      case "RFC822":
        out.push({
          kind: "BODY[]",
          section: { path: [], kind: "", fields: [] },
          peek: false,
          partial: null,
          label: "RFC822",
        });
        break;
      case "RFC822.HEADER":
        out.push({
          kind: "BODY[]",
          section: { path: [], kind: "HEADER", fields: [] },
          peek: true,
          partial: null,
          label: "RFC822.HEADER",
        });
        break;
      case "RFC822.TEXT":
        out.push({
          kind: "BODY[]",
          section: { path: [], kind: "TEXT", fields: [] },
          peek: false,
          partial: null,
          label: "RFC822.TEXT",
        });
        break;
      case "MODSEQ":
        break;
      default:
        throw new ProtocolError(`Invalid fetch item ${name}`);
    }
  }
  return out;
}

// `[1,2,3,7]` → "1:3,7" for COPYUID.
function compressSet(nums: number[]): string {
  const sorted = nums.toSorted((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return out.join(",");
}
