// MCP (Model Context Protocol) over Streamable HTTP. A new protocol gets a new
// handler on the same Worker, never a second script (invariant 1) — this is the
// HTTP sibling of imap/index.ts.
//
// Stateless: every request carries its own credential and is answered with a
// plain JSON body, so there is no session to park in a Durable Object and no
// server-initiated stream to keep open. Clients authenticate with a per-mailbox
// app password — the same credential an IMAP client uses, so one connection
// sees one mailbox and revoking it cuts both off at once.

import type { DB } from "@cfmail/db";
import { appPassword } from "@cfmail/db/schema";
import { has } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type LoginThrottle, loginWithAppPassword } from "../app-passwords.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings, Env } from "../env.ts";
import { AppError } from "../errors.ts";
import type { McpSession } from "../mcp/store.ts";
import { describeTools, TOOLS_BY_NAME } from "../mcp/tools.ts";
import { resolveAccess } from "../permissions.ts";

// The spec revision this server implements. A client that asks for a different
// one is answered with ours; per spec it then either adapts or disconnects.
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "cfmail";
const SERVER_VERSION = "1.0.0";

// Scrypt dominates the cost of verifying an app password, and a stateless
// transport re-authenticates on every call, so MCP gets a looser ceiling than
// IMAP's once-per-session login.
const MCP_THROTTLE: LoginThrottle = { scope: "mcp-login", max: 60, ipMax: 120 };

// Verified credentials, cached per isolate so a burst of tool calls pays for
// scrypt once. Safety doesn't rest on the cache: every request still re-reads
// the app_password row (so deleting it cuts the client off at once) and
// re-resolves mailbox access through permissions.ts (so a revoked membership
// stops working immediately). The TTL only bounds how long a credential that
// was changed in place could keep working, and `lastUsedAt` is correspondingly
// accurate to within one TTL.
const CRED_TTL_MS = 5 * 60 * 1000;
const CRED_CACHE_MAX = 256;

interface CachedLogin {
  appPasswordId: string;
  userId: string;
  mailboxId: string;
  address: string;
  at: number;
}

const credCache = new Map<string, CachedLogin>();

const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
type RpcRequest = z.infer<typeof rpcRequest>;

const Code = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export function mcpRoutes() {
  return (
    new Hono<AppBindings>()
      .post("/", async (c) => {
        const db = dbFromCtx(c);
        const session = await authenticate(db, c.req.raw);

        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json(errorFor(null, Code.parse, "invalid JSON"));
        }

        // Pre-2025-06-18 clients may still send a JSON-RPC batch; answer one with
        // an array and drop the notifications, which have no reply.
        if (Array.isArray(body)) {
          const out = await Promise.all(body.map((m) => handleMessage(c.env, db, session, m)));
          const replies = out.filter((r) => r !== null);
          return replies.length === 0 ? c.body(null, 202) : c.json(replies);
        }

        const reply = await handleMessage(c.env, db, session, body);
        return reply === null ? c.body(null, 202) : c.json(reply);
      })

      // Stateless: there is no long-lived stream to attach to and no session to
      // delete. Both are optional in the spec, so say so rather than 404.
      .get("/", () => {
        throw new HTTPException(405, { message: "this MCP server does not stream" });
      })
      .delete("/", () => {
        throw new HTTPException(405, { message: "this MCP server is stateless" });
      })
  );
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

type RpcReply = Record<string, unknown> | null;

async function handleMessage(
  env: Env,
  db: DB,
  session: McpSession,
  raw: unknown,
): Promise<RpcReply> {
  const parsed = rpcRequest.safeParse(raw);
  if (!parsed.success) {
    const id = idOf(raw);
    return id === undefined ? null : errorFor(id, Code.invalidRequest, "invalid JSON-RPC request");
  }
  const msg = parsed.data;
  // No id means a notification: act on it, answer nothing.
  const isNotification = msg.id === undefined;

  try {
    const result = await dispatch(env, db, session, msg);
    if (isNotification) return null;
    return { jsonrpc: "2.0", id: msg.id ?? null, result };
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcError) return errorFor(msg.id ?? null, err.code, err.message, err.data);
    console.error("mcp dispatch failed", err);
    return errorFor(msg.id ?? null, Code.internal, "internal error");
  }
}

async function dispatch(env: Env, db: DB, session: McpSession, msg: RpcRequest): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "cfmail", version: SERVER_VERSION },
        instructions: `You are connected to the mailbox ${session.address}. Tool calls only ever see this one mailbox. send_mail and reply_to_thread deliver real email immediately and cannot be recalled, so confirm recipients and wording with the user before calling them.`,
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return {};

    case "ping":
      return {};

    case "tools/list":
      return { tools: describeTools() };

    case "tools/call":
      return callTool(env, db, session, msg.params);

    default:
      throw new RpcError(Code.methodNotFound, `unknown method: ${msg.method}`);
  }
}

const callParams = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

async function callTool(env: Env, db: DB, session: McpSession, params: unknown): Promise<unknown> {
  const p = callParams.safeParse(params);
  if (!p.success) throw new RpcError(Code.invalidParams, "tools/call needs a tool name");

  const tool = TOOLS_BY_NAME.get(p.data.name);
  if (!tool) throw new RpcError(Code.invalidParams, `unknown tool: ${p.data.name}`);

  const args = tool.schema.safeParse(p.data.arguments ?? {});
  if (!args.success) {
    throw new RpcError(Code.invalidParams, `invalid arguments for ${tool.name}`, {
      issues: args.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  // RBAC for the whole surface, in one place: perms were re-resolved for this
  // request, so a membership revoked a second ago already fails here.
  if (!has(session.perms, tool.perm)) {
    return toolError(`forbidden: this connection may not ${tool.name}`);
  }

  try {
    const data = await tool.run(env, db, session, args.data as never);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    // A failure inside a tool is the model's problem to work around, not a
    // transport fault — report it in the result so it can read and retry
    // (invariant 9: AppError carries the transport-neutral code, we translate).
    if (err instanceof AppError) return toolError(`${err.code}: ${err.message}`);
    console.error("mcp tool failed", tool.name, err);
    return toolError("internal: the tool failed unexpectedly");
  }
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function errorFor(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

// Best-effort id recovery from a message that failed validation, so a malformed
// request still gets a correlatable reply instead of a dropped one.
function idOf(raw: unknown): string | number | null | undefined {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { id?: unknown }).id;
  if (id === undefined) return undefined;
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return null;
}

// ─── auth ───────────────────────────────────────────────────────────────────

// Credentials arrive as a mailbox address plus an app password. Basic carries
// the pair natively; Bearer is accepted as `address:password` for clients that
// can only send a single opaque token.
function parseCredential(req: Request): { username: string; password: string } | null {
  const header = req.headers.get("authorization") ?? "";
  const basic = header.match(/^Basic\s+(.+)$/i);
  if (basic?.[1]) {
    let decoded: string;
    try {
      decoded = atob(basic[1].trim());
    } catch {
      return null;
    }
    return split(decoded);
  }
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return split(bearer[1].trim());
  return null;
}

// The password alphabet excludes ':', so the first colon always separates.
function split(pair: string): { username: string; password: string } | null {
  const i = pair.indexOf(":");
  if (i <= 0) return null;
  const username = pair.slice(0, i);
  const password = pair.slice(i + 1);
  return username && password ? { username, password } : null;
}

async function authenticate(db: DB, req: Request): Promise<McpSession> {
  const cred = parseCredential(req);
  if (!cred) throw unauthorized("send a mailbox address and app password");

  const key = await sha256Hex(`${cred.username}\u0000${cred.password}`);
  const login = await verifiedLogin(db, req, key, cred);

  // Re-resolved per request through permissions.ts, never cached: losing access
  // to a shared mailbox has to stop the next tool call, not the next isolate.
  const access = await resolveAccess(db, login.userId, login.mailboxId);
  if (!access) {
    credCache.delete(key);
    throw unauthorized("mailbox access has been revoked");
  }

  return {
    appPasswordId: login.appPasswordId,
    userId: login.userId,
    mailboxId: login.mailboxId,
    address: login.address,
    perms: access.perms,
  };
}

async function verifiedLogin(
  db: DB,
  req: Request,
  key: string,
  cred: { username: string; password: string },
): Promise<CachedLogin> {
  const hit = credCache.get(key);
  if (hit && Date.now() - hit.at < CRED_TTL_MS) {
    // Cheap indexed read instead of scrypt — but still a read, so a deleted app
    // password stops working on the very next call.
    const row = await db.query.appPassword.findFirst({
      where: eq(appPassword.id, hit.appPasswordId),
      columns: { id: true },
    });
    if (row) return hit;
    credCache.delete(key);
  }

  const clientIp = req.headers.get("cf-connecting-ip");
  let login: Awaited<ReturnType<typeof loginWithAppPassword>>;
  try {
    login = await loginWithAppPassword(db, cred.username, cred.password, clientIp, MCP_THROTTLE);
  } catch (err) {
    // Rate limit / AuthBL / revoked access all surface as AppError; at the
    // transport edge they become an HTTP status, not a JSON-RPC body.
    if (err instanceof AppError) {
      throw new HTTPException(err.code === "rate_limited" ? 429 : 403, { message: err.message });
    }
    throw err;
  }
  if (!login) throw unauthorized("invalid mailbox address or app password");

  const entry: CachedLogin = {
    appPasswordId: login.id,
    userId: login.userId,
    mailboxId: login.mailboxId,
    address: login.address,
    at: Date.now(),
  };
  if (credCache.size >= CRED_CACHE_MAX) {
    const oldest = credCache.keys().next();
    if (!oldest.done) credCache.delete(oldest.value);
  }
  credCache.set(key, entry);
  return entry;
}

function unauthorized(message: string): HTTPException {
  return new HTTPException(401, {
    res: Response.json(
      { error: message },
      { status: 401, headers: { "www-authenticate": 'Basic realm="cfmail MCP", charset="UTF-8"' } },
    ),
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
