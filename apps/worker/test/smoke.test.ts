import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";

const e = env as unknown as Env;

describe("workers-pool smoke", () => {
  it("exposes bindings from wrangler.jsonc", () => {
    expect(e.DB).toBeDefined();
    expect(e.BLOBS).toBeDefined();
    expect(e.USER_HUB).toBeDefined();
    expect(typeof e.APP_URL).toBe("string");
  });

  it("runs inside the Workers runtime", async () => {
    const key = `smoke/${crypto.randomUUID()}`;
    await e.BLOBS.put(key, "hello");
    const obj = await e.BLOBS.get(key);
    expect(await obj?.text()).toBe("hello");
  });
});
