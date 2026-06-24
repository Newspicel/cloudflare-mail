import type { DB } from "@cfmail/db";
import type { RuleCondition } from "@cfmail/db/schema";
import { rule } from "@cfmail/db/schema";
import { and, asc, eq } from "drizzle-orm";

// Caps that keep matching on the inbound hot path bounded — the Workers runtime
// has no RE2, so a pathological user regex could otherwise hang receive. Pattern
// length is already capped at 512 by the zod schema; we also truncate haystacks.
const MAX_HAYSTACK = 16_000;

export interface RuleContext {
  fromAddr: string;
  fromName?: string;
  toAddrs: { name?: string; address: string }[];
  ccAddrs: { name?: string; address: string }[];
  subject: string;
  bodyText: string | null;
  deliveredTo: string;
}

export interface RuleOutcome {
  // Set by a hardBlock action — caller SMTP-rejects with this reason and stores nothing.
  reject?: string;
  // File the thread to Spam regardless of new/existing (explicit user intent).
  markSpam: boolean;
  // Mark the inbound message read (seeds Flag.SEEN, suppresses unread + push).
  markRead: boolean;
  // Labels to attach to the inserted message (per-mailbox label ids).
  labelIds: string[];
  // Last moveFolder wins; files into this user's thread_folder (invariant 17).
  folder?: { userId: string; folderId: string };
  // Best-effort outbound sends, executed after the message is stored (never
  // block delivery). `ruleId` ties each back to its rule for throttle/audit.
  forwards: { ruleId: string; to: string }[];
  autoReplies: { ruleId: string; subject?: string; body: string }[];
}

// Evaluate a mailbox's enabled rules against a parsed inbound message. Pure read
// + fold — all DB mutation stays with the caller so it's ordered relative to the
// message insert. Rules run priority asc; `stopProcessing` halts the rest and
// `hardBlock` short-circuits immediately.
export async function evaluateRules(
  db: DB,
  mailboxId: string,
  ctx: RuleContext,
): Promise<RuleOutcome> {
  const rows = await db
    .select()
    .from(rule)
    .where(and(eq(rule.mailboxId, mailboxId), eq(rule.enabled, true)))
    .orderBy(asc(rule.priority), asc(rule.createdAt));

  const outcome: RuleOutcome = {
    markSpam: false,
    markRead: false,
    labelIds: [],
    forwards: [],
    autoReplies: [],
  };

  for (const r of rows) {
    const conditions = r.conditions ?? [];
    // A rule with no conditions never matches — guards against accidental match-all.
    if (conditions.length === 0) continue;
    if (!ruleMatches(conditions, r.conditionMode, ctx)) continue;

    let stop = false;
    for (const action of r.actions ?? []) {
      switch (action.type) {
        case "applyLabel":
          if (!outcome.labelIds.includes(action.labelId)) outcome.labelIds.push(action.labelId);
          break;
        case "moveFolder":
          outcome.folder = { userId: r.createdBy, folderId: action.folderId };
          break;
        case "markRead":
          outcome.markRead = true;
          break;
        case "markSpam":
          outcome.markSpam = true;
          break;
        case "forward":
          outcome.forwards.push({ ruleId: r.id, to: action.to });
          break;
        case "autoReply":
          outcome.autoReplies.push({ ruleId: r.id, subject: action.subject, body: action.body });
          break;
        case "hardBlock":
          outcome.reject = "Address not found";
          return outcome;
        case "stopProcessing":
          stop = true;
          break;
      }
    }
    if (stop) break;
  }

  return outcome;
}

function ruleMatches(conditions: RuleCondition[], mode: "all" | "any", ctx: RuleContext): boolean {
  if (mode === "any") return conditions.some((c) => conditionMatches(c, ctx));
  return conditions.every((c) => conditionMatches(c, ctx));
}

function conditionMatches(cond: RuleCondition, ctx: RuleContext): boolean {
  const haystack = fieldValue(cond.field, ctx).slice(0, MAX_HAYSTACK);
  return matchOp(haystack, cond.op, cond.value);
}

function fieldValue(field: RuleCondition["field"], ctx: RuleContext): string {
  switch (field) {
    case "from":
      return joinAddr({ name: ctx.fromName, address: ctx.fromAddr });
    case "to":
      return ctx.toAddrs.map(joinAddr).join(", ");
    case "cc":
      return ctx.ccAddrs.map(joinAddr).join(", ");
    case "subject":
      return ctx.subject;
    case "body":
      return ctx.bodyText ?? "";
    case "deliveredTo":
      return ctx.deliveredTo;
  }
}

function joinAddr(a: { name?: string; address: string }): string {
  return a.name ? `${a.name} ${a.address}` : a.address;
}

function matchOp(haystack: string, op: RuleCondition["op"], value: string): boolean {
  if (op === "regex") {
    const re = safeRegex(value);
    return re ? re.test(haystack) : false;
  }
  const h = haystack.toLowerCase();
  const v = value.toLowerCase();
  switch (op) {
    case "contains":
      return h.includes(v);
    case "equals":
      return h === v;
    case "startsWith":
      return h.startsWith(v);
    case "endsWith":
      return h.endsWith(v);
    case "wildcard": {
      const re = wildcardRegex(v);
      return re ? re.test(h) : false;
    }
  }
}

// Compile a `*`/`?` glob to an anchored, linear regex (all other metacharacters
// escaped) — no backtracking blow-up. Returns null only if compilation throws.
function wildcardRegex(glob: string): RegExp | null {
  const body = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "*" ? ".*" : ch === "?" ? "." : `\\${ch}`,
  );
  try {
    return new RegExp(`^${body}$`);
  } catch {
    return null;
  }
}

// User regex is opt-in power matching; invalid patterns (or any throw) match
// nothing rather than crashing receive. Case-insensitive by default.
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}
