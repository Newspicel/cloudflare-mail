// MCP (Model Context Protocol) over Streamable HTTP. A new protocol gets a new
// handler on the same Worker, never a second script (invariant 1) — this is the
// HTTP sibling of imap/index.ts.
//
// Stateless: every request carries its own credential and is answered with a
// plain JSON body, so there is no session to park in a Durable Object and no
// server-initiated stream to keep open. Clients sign in as the user through
// OAuth (Better Auth's mcp plugin: discovery, CIMD registration, consent) and
// present a JWT bound to this resource. One connection reaches every mailbox
// the user can; each tool call is checked against that user's perms on the
// mailbox it touches, re-resolved through permissions.ts on that request.

import { requireMcpAuth } from "@better-auth/mcp";
import type { DB } from "@cfmail/db";
import { oauthConsent, user } from "@cfmail/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { baseUrlFromRequest, mcpResource } from "../auth.ts";
import { authFromCtx } from "../auth-ctx.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings, Env } from "../env.ts";
import { AppError } from "../errors.ts";
import { type McpCaller, resolveTarget } from "../mcp/store.ts";
import { describeTools, TOOLS_BY_NAME } from "../mcp/tools.ts";

// The spec revision this server implements. A client that asks for a different
// one is answered with ours; per spec it then either adapts or disconnects.
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "cfmail";
const SERVER_VERSION = "1.0.0";

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
        const auth = await authFromCtx(c);
        const resource = mcpResource(baseUrlFromRequest(c.req.raw));

        // requireMcpAuth checks signature, issuer, audience (this resource) and
        // expiry, and answers a missing or bad token with the RFC 9728 challenge
        // that starts the client's OAuth flow.
        const handle = requireMcpAuth(
          auth,
          async (req, claims) => {
            const caller = await authorize(db, req, claims);

            let body: unknown;
            try {
              body = await req.json();
            } catch {
              return c.json(errorFor(null, Code.parse, "invalid JSON"));
            }

            // Pre-2025-06-18 clients may still send a JSON-RPC batch; answer one
            // with an array and drop the notifications, which have no reply.
            if (Array.isArray(body)) {
              const out = await Promise.all(body.map((m) => handleMessage(c.env, db, caller, m)));
              const replies = out.filter((r) => r !== null);
              return replies.length === 0 ? c.body(null, 202) : c.json(replies);
            }

            const reply = await handleMessage(c.env, db, caller, body);
            return reply === null ? c.body(null, 202) : c.json(reply);
          },
          { resource },
        );
        return handle(c.req.raw);
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

async function handleMessage(env: Env, db: DB, caller: McpCaller, raw: unknown): Promise<RpcReply> {
  const parsed = rpcRequest.safeParse(raw);
  if (!parsed.success) {
    const id = idOf(raw);
    return id === undefined ? null : errorFor(id, Code.invalidRequest, "invalid JSON-RPC request");
  }
  const msg = parsed.data;
  // No id means a notification: act on it, answer nothing.
  const isNotification = msg.id === undefined;

  try {
    const result = await dispatch(env, db, caller, msg);
    if (isNotification) return null;
    return { jsonrpc: "2.0", id: msg.id ?? null, result };
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcError) return errorFor(msg.id ?? null, err.code, err.message, err.data);
    console.error("mcp dispatch failed", err);
    return errorFor(msg.id ?? null, Code.internal, "internal error");
  }
}

async function dispatch(env: Env, db: DB, caller: McpCaller, msg: RpcRequest): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "cfmail", version: SERVER_VERSION },
        instructions:
          "You act as the signed-in user across every mailbox they can reach. Call list_mailboxes first to learn the addresses; send_mail and list_labels name a mailbox, tools that take a thread or message id act in that item's own mailbox. send_mail and reply_to_thread deliver real email immediately and cannot be recalled, so confirm the sending address, recipients and wording with the user before calling them.",
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return {};

    case "ping":
      return {};

    case "tools/list":
      return { tools: describeTools() };

    case "tools/call":
      return callTool(env, db, caller, msg.params);

    default:
      throw new RpcError(Code.methodNotFound, `unknown method: ${msg.method}`);
  }
}

const callParams = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

async function callTool(env: Env, db: DB, caller: McpCaller, params: unknown): Promise<unknown> {
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

  try {
    // RBAC for the whole surface, in one place: the target resolves to the
    // mailboxes this user holds tool.perm on, re-read for this request, so a
    // membership revoked a second ago already fails here.
    const mailboxes = await resolveTarget(
      db,
      caller.userId,
      tool.target(args.data as never),
      tool.perm,
    );
    const data = await tool.run(env, db, mailboxes, args.data as never);
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

type JWTPayload = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];

// The token proves who signed in and which client they handed it to; whether
// that still holds is read fresh on every call. A deleted or banned user, or a
// revoked consent (Settings → Connected apps), fails the next request even
// while the JWT is unexpired — a token caches authentication, never access.
async function authorize(db: DB, req: Request, claims: JWTPayload): Promise<McpCaller> {
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  const clientId = typeof claims.azp === "string" ? claims.azp : null;
  if (!userId || !clientId) throw unauthorized(req, "the access token names no user or client");

  const [row] = await db
    .select({ banned: user.banned, banExpires: user.banExpires, consentId: oauthConsent.id })
    .from(user)
    .leftJoin(
      oauthConsent,
      and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, clientId)),
    )
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) throw unauthorized(req, "this account no longer exists");
  if (row.banned && (!row.banExpires || row.banExpires > new Date())) {
    throw unauthorized(req, "this account is suspended");
  }
  if (!row.consentId) throw unauthorized(req, "access for this app has been revoked");
  return { userId, clientId };
}

// Same challenge requireMcpAuth sends for a bad token, so a client that loses
// its grant goes back through authorization instead of retrying forever.
function unauthorized(req: Request, message: string): HTTPException {
  const origin = new URL(req.url).origin;
  const metadata = `${origin}/.well-known/oauth-protected-resource${new URL(mcpResource(origin)).pathname}`;
  return new HTTPException(401, {
    res: Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
      {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="${message}"`,
        },
      },
    ),
  });
}
