import { attachment } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachmentsRoutes } from "../../src/api/attachments.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  member,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(attachmentsRoutes, owner);

let aseq = 0;
async function seedAttachment(
  messageId: string,
  overrides: Partial<typeof attachment.$inferInsert> = {},
): Promise<{ id: string; r2Key: string }> {
  const id = `att-${++aseq}`;
  const r2Key = `att/${id}/file.bin`;
  await db()
    .insert(attachment)
    .values({
      id,
      messageId,
      filename: "file.bin",
      contentType: "application/pdf",
      sizeBytes: 4,
      r2Key,
      ...overrides,
    });
  return { id, r2Key };
}

// Fire a raw (non-JSON) request so we can set arbitrary headers + binary bodies.
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

describe("attachments", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(attachmentsRoutes, null), "GET", "/att-x");
    expect(res.status).toBe(401);
  });

  describe("POST /upload", () => {
    it("stores a draft blob and echoes its metadata", async () => {
      const res = await raw(asOwner(), "POST", "/upload", "hello bytes", {
        "content-type": "text/plain",
        "x-filename": "note.txt",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        r2Key: string;
        filename: string;
        contentType: string;
        sizeBytes: number;
      };
      expect(body.filename).toBe("note.txt");
      expect(body.contentType).toBe("text/plain");
      expect(body.sizeBytes).toBe(11);
      expect(body.r2Key.startsWith(`draft/${OWNER_ID}/`)).toBe(true);

      const obj = await e.BLOBS.get(body.r2Key);
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe("hello bytes");
    });

    it("400s an empty upload", async () => {
      const res = await raw(asOwner(), "POST", "/upload", "", {
        "content-type": "application/octet-stream",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /draft-blob", () => {
    it("serves the caller's own image blob inline", async () => {
      const key = `draft/${OWNER_ID}/pic.png`;
      await e.BLOBS.put(key, "PNGDATA", { httpMetadata: { contentType: "image/png" } });
      const res = await raw(asOwner(), "GET", `/draft-blob?key=${encodeURIComponent(key)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("PNGDATA");
    });

    it("403s a key outside the caller's draft prefix", async () => {
      const key = "draft/someone-else/pic.png";
      await e.BLOBS.put(key, "x", { httpMetadata: { contentType: "image/png" } });
      const res = await raw(asOwner(), "GET", `/draft-blob?key=${encodeURIComponent(key)}`);
      expect(res.status).toBe(403);
    });

    it("404s a missing blob", async () => {
      const key = `draft/${OWNER_ID}/gone.png`;
      const res = await raw(asOwner(), "GET", `/draft-blob?key=${encodeURIComponent(key)}`);
      expect(res.status).toBe(404);
    });

    it("415s a non-image blob", async () => {
      const key = `draft/${OWNER_ID}/doc.pdf`;
      await e.BLOBS.put(key, "x", { httpMetadata: { contentType: "application/pdf" } });
      const res = await raw(asOwner(), "GET", `/draft-blob?key=${encodeURIComponent(key)}`);
      expect(res.status).toBe(415);
    });
  });

  describe("GET /:id", () => {
    it("streams the attachment bytes with download headers", async () => {
      const { messageId } = await seedThread(db());
      const { id, r2Key } = await seedAttachment(messageId, {
        filename: "report.pdf",
        contentType: "application/pdf",
      });
      await e.BLOBS.put(r2Key, "PDFBYTES");

      const res = await request(asOwner(), "GET", `/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("PDFBYTES");
    });

    it("downgrades a renderable content-type to octet-stream", async () => {
      const { messageId } = await seedThread(db());
      const { id, r2Key } = await seedAttachment(messageId, {
        filename: "evil.html",
        contentType: "text/html",
      });
      await e.BLOBS.put(r2Key, "<script>");

      const res = await request(asOwner(), "GET", `/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
    });

    it("404s a missing attachment row", async () => {
      const res = await request(asOwner(), "GET", "/nope");
      expect(res.status).toBe(404);
    });

    it("404s when the row exists but the blob is gone", async () => {
      const { messageId } = await seedThread(db());
      const { id } = await seedAttachment(messageId);
      const res = await request(asOwner(), "GET", `/${id}`);
      expect(res.status).toBe(404);
    });

    it("403s an outsider without READ on the mailbox", async () => {
      const { messageId } = await seedThread(db());
      const { id, r2Key } = await seedAttachment(messageId);
      await e.BLOBS.put(r2Key, "data");
      const res = await request(mountApp(attachmentsRoutes, outsider), "GET", `/${id}`);
      expect(res.status).toBe(403);
    });

    it("lets a member with READ download", async () => {
      await grantMember(db(), Perm.READ);
      const { messageId } = await seedThread(db());
      const { id, r2Key } = await seedAttachment(messageId);
      await e.BLOBS.put(r2Key, "data");
      const res = await request(mountApp(attachmentsRoutes, member), "GET", `/${id}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("data");
    });
  });
});
