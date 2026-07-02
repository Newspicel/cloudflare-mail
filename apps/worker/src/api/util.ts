import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../env.ts";

// Type-only declaration of a route's expected query params so the RPC client
// (`hc` in apps/web) can pass a `query` object on routes that also take path
// params. Pure pass-through: the handler keeps reading/validating the query
// manually, exactly as before.
export function typedQuery<
  T extends Record<string, string | string[] | undefined>,
>(): MiddlewareHandler<AppBindings, string, { in: { query: T }; out: { query: T } }> {
  return (_c, next) => next();
}

type PatchField =
  // biome-ignore lint/suspicious/noExplicitAny: transforms run over heterogeneous body fields
  | ((value: any) => unknown)
  // biome-ignore lint/suspicious/noExplicitAny: same
  | { to?: string; map?: (value: any) => unknown }
  | true;

// Build a partial update set from a validated request body: for each spec key
// whose body value is defined, assign it — optionally renamed (`to`) and/or
// transformed (a fn, or `map`). Collapses the per-route conditional-assign
// dance; callers still guard the empty-patch case via Object.keys(patch).length.
export function buildPatch<Out extends Record<string, unknown> = Record<string, unknown>>(
  body: Record<string, unknown>,
  spec: Record<string, PatchField>,
): Partial<Out> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const field = spec[key];
    if (!field || body[key] === undefined) continue;
    const value = body[key];
    if (field === true) patch[key] = value;
    else if (typeof field === "function") patch[key] = field(value);
    else patch[field.to ?? key] = field.map ? field.map(value) : value;
  }
  return patch as Partial<Out>;
}

// Run an insert/update, mapping a SQLite UNIQUE violation to a 409 while letting
// every other error surface — so FK/schema bugs aren't masked as "already in use".
// Drizzle wraps the driver error ("Failed query: …") and stashes the original
// "UNIQUE constraint failed" text on `.cause`, so match the whole cause chain.
export async function wrapUnique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, { message });
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE/i.test(e.message)) return true;
  }
  return false;
}
