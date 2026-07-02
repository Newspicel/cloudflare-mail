import type { DB } from "@cfmail/db";
import { rateLimitCounter } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientIp, enforceRateLimit } from "../src/rate-limit.ts";
import { applyMigrationsOnce, db, resetDb } from "./support/app.ts";

const WINDOW = 60_000;
const KEY = "send:user-1";

// Counter checks are order-dependent by nature — run them strictly one at a time.
async function hit(name: string, id: string, max: number, times: number): Promise<void> {
  await Array.from({ length: times }).reduce(
    (p: Promise<void>) => p.then(() => enforceRateLimit(db(), name, id, max, WINDOW)),
    Promise.resolve(),
  );
}

beforeAll(applyMigrationsOnce);
beforeEach(resetDb);

describe("enforceRateLimit", () => {
  it("allows calls up to the limit", async () => {
    await hit("send", "user-1", 3, 3);
    const row = await db().query.rateLimitCounter.findFirst({
      where: eq(rateLimitCounter.key, KEY),
    });
    expect(row?.count).toBe(3);
  });

  it("throws 429 once the limit is exceeded", async () => {
    await hit("send", "user-1", 3, 3);
    const err = await enforceRateLimit(db(), "send", "user-1", 3, WINDOW).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(429);
  });

  it("keys are isolated per name and id", async () => {
    await hit("send", "user-1", 2, 2);
    // Same user, different endpoint bucket — unaffected.
    await expect(
      enforceRateLimit(db(), "proxy-image", "user-1", 2, WINDOW),
    ).resolves.toBeUndefined();
    // Same endpoint, different user — unaffected.
    await expect(enforceRateLimit(db(), "send", "user-2", 2, WINDOW)).resolves.toBeUndefined();
    // The exhausted bucket still 429s.
    await expect(enforceRateLimit(db(), "send", "user-1", 2, WINDOW)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("resets the count when the window lapses", async () => {
    await hit("send", "user-1", 2, 2);
    await expect(enforceRateLimit(db(), "send", "user-1", 2, WINDOW)).rejects.toMatchObject({
      status: 429,
    });

    // Age the window past the cutoff; the next check starts a fresh window.
    await db()
      .update(rateLimitCounter)
      .set({ windowStart: Date.now() - WINDOW - 1 })
      .where(eq(rateLimitCounter.key, KEY));

    await expect(enforceRateLimit(db(), "send", "user-1", 2, WINDOW)).resolves.toBeUndefined();
    const row = await db().query.rateLimitCounter.findFirst({
      where: eq(rateLimitCounter.key, KEY),
    });
    expect(row?.count).toBe(1);
  });

  it("fails open when the counter storage errors", async () => {
    const broken = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.reject(new Error("d1 unavailable")),
          }),
        }),
      }),
    } as unknown as DB;
    await expect(enforceRateLimit(broken, "send", "user-1", 1, WINDOW)).resolves.toBeUndefined();
  });
});

describe("clientIp", () => {
  it("prefers CF-Connecting-IP", () => {
    const h = new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" });
    expect(clientIp(h)).toBe("203.0.113.7");
  });

  it("falls back to X-Forwarded-For, then a shared bucket", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
