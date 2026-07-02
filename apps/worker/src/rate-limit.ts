import type { DB } from "@cfmail/db";
import { rateLimitCounter } from "@cfmail/db/schema";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

// Fixed-window rate limiting for abuse-sensitive app endpoints, backed by the
// `rate_limit_counter` D1 table (Better Auth's own limiter covers /api/auth/*
// with its `rate_limit` table). One upsert per check keeps it a single atomic
// D1 statement: the row's windowStart marks the current window and the count
// resets when it lapses. Exceeding the limit throws 429; an internal storage
// failure logs and allows (limiting is best-effort, never an outage).
export async function enforceRateLimit(
  db: DB,
  name: string,
  id: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const key = `${name}:${id}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  let count: number;
  try {
    const rows = await db
      .insert(rateLimitCounter)
      .values({ key, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: rateLimitCounter.key,
        set: {
          count: sql`case when ${rateLimitCounter.windowStart} <= ${cutoff} then 1 else ${rateLimitCounter.count} + 1 end`,
          windowStart: sql`case when ${rateLimitCounter.windowStart} <= ${cutoff} then ${now} else ${rateLimitCounter.windowStart} end`,
        },
      })
      .returning({ count: rateLimitCounter.count });
    count = rows[0]?.count ?? 0;
  } catch (err) {
    console.error(`rate limit check failed for ${key}`, err);
    return;
  }
  if (count > max) throw new HTTPException(429, { message: "rate limit exceeded" });
}

// Client IP for keying unauthenticated limits. Cloudflare sets CF-Connecting-IP
// on every proxied request; the fallback bucket only applies off-platform.
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for") ?? "unknown";
}
