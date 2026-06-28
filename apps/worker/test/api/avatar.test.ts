import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { avatarRoutes } from "../../src/api/avatar.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import { OWNER_ID, owner, seedBase } from "../support/seed.ts";

const asOwner = () => mountApp(avatarRoutes, owner);

function raw(
  app: ReturnType<typeof asOwner>,
  method: string,
  path: string,
  body?: BodyInit,
  headers?: Record<string, string>,
) {
  // biome-ignore lint/suspicious/noExplicitAny: env cast mirrors support/app.ts.
  return app.request(path, { method, body, headers }, e as any);
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("avatar", () => {
  describe("GET /:userId/:id", () => {
    it("401s an anonymous caller", async () => {
      const res = await request(mountApp(avatarRoutes, null), "GET", `/${OWNER_ID}/abc`);
      expect(res.status).toBe(401);
    });

    it("serves a stored avatar with caching + nosniff headers", async () => {
      const id = "abc123";
      await e.BLOBS.put(`avatar/${OWNER_ID}/${id}`, "IMGBYTES", {
        httpMetadata: { contentType: "image/png" },
      });
      const res = await request(asOwner(), "GET", `/${OWNER_ID}/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("IMGBYTES");
    });

    it("downgrades a non-allowed content-type to octet-stream", async () => {
      const id = "weird1";
      await e.BLOBS.put(`avatar/${OWNER_ID}/${id}`, "x", {
        httpMetadata: { contentType: "image/svg+xml" },
      });
      const res = await request(asOwner(), "GET", `/${OWNER_ID}/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
    });

    it("400s an unsafe key", async () => {
      const res = await request(asOwner(), "GET", `/${OWNER_ID}/bad.key`);
      expect(res.status).toBe(400);
    });

    it("404s a missing avatar", async () => {
      const res = await request(asOwner(), "GET", `/${OWNER_ID}/missing`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /", () => {
    it("401s an anonymous caller", async () => {
      const res = await raw(mountApp(avatarRoutes, null), "POST", "/", "x", {
        "content-type": "image/png",
      });
      expect(res.status).toBe(401);
    });

    it("uploads an avatar and returns its url", async () => {
      const res = await raw(asOwner(), "POST", "/", "PNGDATA", {
        "content-type": "image/png",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url.startsWith(`/api/avatar/${OWNER_ID}/`)).toBe(true);

      const key = body.url.replace("/api/avatar/", "avatar/");
      const obj = await e.BLOBS.get(key);
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe("PNGDATA");
    });

    it("replaces a prior avatar so only one blob remains", async () => {
      await e.BLOBS.put(`avatar/${OWNER_ID}/old`, "OLD", {
        httpMetadata: { contentType: "image/png" },
      });
      const res = await raw(asOwner(), "POST", "/", "NEW", {
        "content-type": "image/jpeg",
      });
      expect(res.status).toBe(200);
      const list = await e.BLOBS.list({ prefix: `avatar/${OWNER_ID}/` });
      expect(list.objects).toHaveLength(1);
      expect(list.objects[0]?.key).not.toBe(`avatar/${OWNER_ID}/old`);
    });

    it("415s an unsupported content-type", async () => {
      const res = await raw(asOwner(), "POST", "/", "x", {
        "content-type": "application/pdf",
      });
      expect(res.status).toBe(415);
    });

    it("400s an empty body", async () => {
      const res = await raw(asOwner(), "POST", "/", "", {
        "content-type": "image/png",
      });
      expect(res.status).toBe(400);
    });
  });
});
