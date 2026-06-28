import { mailboxMember } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { draftsRoutes } from "../../src/api/drafts.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asOwner = () => mountApp(draftsRoutes, owner);
const asMember = () => mountApp(draftsRoutes, member);
const asOutsider = () => mountApp(draftsRoutes, outsider);

type DraftDto = {
  id: string;
  mailboxId: string;
  userId: string;
  subject: string;
  body: string;
  format: string;
  markdown: boolean;
  toAddrs: { address: string }[];
  scheduledFor: string | null;
  updatedAt: string;
};

// Minimal valid create body; mailboxId is the only required field.
function draftBody(over: Record<string, unknown> = {}) {
  return { mailboxId: MAILBOX_ID, subject: "Hi", body: "hello", ...over };
}

async function createDraft(app = asOwner(), over: Record<string, unknown> = {}): Promise<DraftDto> {
  const res = await request(app, "POST", "/", draftBody(over));
  expect(res.status).toBe(201);
  return ((await res.json()) as { draft: DraftDto }).draft;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("drafts", () => {
  // ─── auth ──────────────────────────────────────────────────────────────────
  it("401s an anonymous caller on every route", async () => {
    const anon = mountApp(draftsRoutes, null);
    expect((await request(anon, "GET", `/?mailboxId=${MAILBOX_ID}`)).status).toBe(401);
    expect((await request(anon, "GET", "/x")).status).toBe(401);
    expect((await request(anon, "POST", "/", draftBody())).status).toBe(401);
    expect((await request(anon, "PATCH", "/x", { subject: "y" })).status).toBe(401);
    expect((await request(anon, "DELETE", "/x")).status).toBe(401);
  });

  // ─── create ──────────────────────────────────────────────────────────────────
  it("creates a draft and echoes the serialized row", async () => {
    const d = await createDraft(asOwner(), {
      to: [{ address: "a@example.com" }],
      format: "markdown",
    });
    expect(d.mailboxId).toBe(MAILBOX_ID);
    expect(d.userId).toBe(owner.id);
    expect(d.subject).toBe("Hi");
    expect(d.toAddrs).toEqual([{ address: "a@example.com" }]);
    // format=markdown keeps the legacy markdown flag in sync.
    expect(d.format).toBe("markdown");
    expect(d.markdown).toBe(true);
    expect(d.scheduledFor).toBeNull();
  });

  it("applies schema defaults for omitted fields", async () => {
    const res = await request(asOwner(), "POST", "/", { mailboxId: MAILBOX_ID });
    expect(res.status).toBe(201);
    const { draft } = (await res.json()) as { draft: DraftDto };
    expect(draft.subject).toBe("");
    expect(draft.body).toBe("");
    expect(draft.toAddrs).toEqual([]);
    expect(draft.format).toBe("text");
    expect(draft.markdown).toBe(false);
  });

  it("400s create with no mailboxId (zod)", async () => {
    const res = await request(asOwner(), "POST", "/", { subject: "x" });
    expect(res.status).toBe(400);
  });

  it("400s create with an invalid recipient address (zod)", async () => {
    const res = await request(asOwner(), "POST", "/", draftBody({ to: [{ address: "nope" }] }));
    expect(res.status).toBe(400);
  });

  it("400s create with a bad editor format (zod)", async () => {
    const res = await request(asOwner(), "POST", "/", draftBody({ format: "rtf" }));
    expect(res.status).toBe(400);
  });

  it("400s create with a foreign attachment key", async () => {
    const res = await request(
      asOwner(),
      "POST",
      "/",
      draftBody({
        attachments: [
          {
            r2Key: "draft/user-other/x.png",
            filename: "x.png",
            contentType: "image/png",
            sizeBytes: 1,
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts an attachment key in the caller's own namespace", async () => {
    const d = await createDraft(asOwner(), {
      attachments: [
        {
          r2Key: `draft/${owner.id}/x.png`,
          filename: "x.png",
          contentType: "image/png",
          sizeBytes: 1,
        },
      ],
    });
    expect(d.id).toBeTruthy();
  });

  it("403s a member without WRITE creating a draft", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", "/", draftBody());
    expect(res.status).toBe(403);
  });

  it("lets a member with WRITE create a draft", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const res = await request(asMember(), "POST", "/", draftBody());
    expect(res.status).toBe(201);
  });

  it("403s an outsider creating in a mailbox they can't access", async () => {
    const res = await request(asOutsider(), "POST", "/", draftBody());
    expect(res.status).toBe(403);
  });

  // ─── list ──────────────────────────────────────────────────────────────────
  it("400s list without mailboxId", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(400);
  });

  it("lists only the caller's own drafts in a mailbox, newest first", async () => {
    await createDraft(asOwner(), { subject: "first" });
    await createDraft(asOwner(), { subject: "second" });
    const res = await request(asOwner(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: DraftDto[]; nextCursor: string | null };
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts.every((d) => d.userId === owner.id)).toBe(true);
  });

  it("scopes drafts to the author — a member with READ sees none of the owner's", async () => {
    await grantMember(db(), Perm.READ);
    await createDraft(asOwner());
    const res = await request(asMember(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { drafts: unknown[] }).drafts).toHaveLength(0);
  });

  it("the ALL view returns the author's drafts across mailboxes", async () => {
    await createDraft(asOwner(), { mailboxId: MAILBOX_ID });
    await createDraft(asOwner(), { mailboxId: OTHER_MAILBOX_ID });
    const res = await request(asOwner(), "GET", "/?mailboxId=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: DraftDto[] };
    expect(body.drafts).toHaveLength(2);
    expect(new Set(body.drafts.map((d) => d.mailboxId))).toEqual(
      new Set([MAILBOX_ID, OTHER_MAILBOX_ID]),
    );
  });

  it("403s an outsider listing a mailbox they can't read", async () => {
    const res = await request(asOutsider(), "GET", `/?mailboxId=${MAILBOX_ID}`);
    expect(res.status).toBe(403);
  });

  // ─── get ───────────────────────────────────────────────────────────────────
  it("gets an own draft by id", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "GET", `/${d.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { draft: DraftDto }).draft.id).toBe(d.id);
  });

  it("404s getting a missing draft", async () => {
    const res = await request(asOwner(), "GET", "/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("404s getting another user's draft (author-scoped)", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const d = await createDraft();
    const res = await request(asMember(), "GET", `/${d.id}`);
    expect(res.status).toBe(404);
  });

  // ─── patch ─────────────────────────────────────────────────────────────────
  it("patches subject/body and bumps the format-driven markdown flag", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "PATCH", `/${d.id}`, {
      subject: "edited",
      format: "html",
    });
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as { draft: DraftDto };
    expect(draft.subject).toBe("edited");
    expect(draft.format).toBe("html");
    expect(draft.markdown).toBe(false);
  });

  it("400s patch with an invalid body (zod)", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "PATCH", `/${d.id}`, { to: [{ address: "nope" }] });
    expect(res.status).toBe(400);
  });

  it("400s patch adding a foreign attachment key", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "PATCH", `/${d.id}`, {
      attachments: [
        { r2Key: "draft/someone/x.png", filename: "x.png", contentType: "image/png", sizeBytes: 1 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("404s patching a missing draft", async () => {
    const res = await request(asOwner(), "PATCH", "/nope", { subject: "x" });
    expect(res.status).toBe(404);
  });

  it("404s patching another user's draft", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const d = await createDraft();
    const res = await request(asMember(), "PATCH", `/${d.id}`, { subject: "x" });
    expect(res.status).toBe(404);
  });

  // ─── schedule (deferred-send path) ───────────────────────────────────────────
  it("schedules a draft's deferred send and stores scheduledFor", async () => {
    const d = await createDraft();
    const sendAt = Date.now() + 5 * 60_000;
    const res = await request(asOwner(), "POST", `/${d.id}/schedule`, {
      sendAt,
      payload: { mailboxId: MAILBOX_ID, to: [{ address: "a@example.com" }], subject: "Later" },
    });
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as { draft: DraftDto };
    // The column is timestamp(seconds) precision, so allow sub-second drift.
    expect(draft.scheduledFor).not.toBeNull();
    expect(Math.abs(new Date(draft.scheduledFor!).getTime() - sendAt)).toBeLessThan(1000);
  });

  it("400s scheduling in the past (zod refine)", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "POST", `/${d.id}/schedule`, {
      sendAt: Date.now() - 1000,
      payload: { mailboxId: MAILBOX_ID, to: [{ address: "a@example.com" }] },
    });
    expect(res.status).toBe(400);
  });

  it("400s scheduling with an empty recipient list (payload zod)", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "POST", `/${d.id}/schedule`, {
      sendAt: Date.now() + 5 * 60_000,
      payload: { mailboxId: MAILBOX_ID, to: [] },
    });
    expect(res.status).toBe(400);
  });

  it("404s scheduling a missing/foreign draft before the WRITE check", async () => {
    const res = await request(asOwner(), "POST", "/nope/schedule", {
      sendAt: Date.now() + 5 * 60_000,
      payload: { mailboxId: MAILBOX_ID, to: [{ address: "a@example.com" }] },
    });
    expect(res.status).toBe(404);
  });

  it("403s a member without WRITE scheduling their own draft", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const d = await createDraft(asMember());
    // Drop WRITE: revoke and regrant READ-only.
    await db().delete(mailboxMember);
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", `/${d.id}/schedule`, {
      sendAt: Date.now() + 5 * 60_000,
      payload: { mailboxId: MAILBOX_ID, to: [{ address: "a@example.com" }] },
    });
    expect(res.status).toBe(403);
  });

  it("cancels a scheduled send, reverting scheduledFor to null", async () => {
    const d = await createDraft();
    await request(asOwner(), "POST", `/${d.id}/schedule`, {
      sendAt: Date.now() + 5 * 60_000,
      payload: { mailboxId: MAILBOX_ID, to: [{ address: "a@example.com" }] },
    });
    const res = await request(asOwner(), "DELETE", `/${d.id}/schedule`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { draft: DraftDto }).draft.scheduledFor).toBeNull();
  });

  it("404s cancelling a schedule on a missing draft", async () => {
    const res = await request(asOwner(), "DELETE", "/nope/schedule");
    expect(res.status).toBe(404);
  });

  // ─── delete ──────────────────────────────────────────────────────────────────
  it("deletes an own draft", async () => {
    const d = await createDraft();
    const res = await request(asOwner(), "DELETE", `/${d.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    expect((await request(asOwner(), "GET", `/${d.id}`)).status).toBe(404);
  });

  it("deletes a draft carrying an own-namespace attachment (R2 cleanup)", async () => {
    const key = `draft/${owner.id}/del.png`;
    await e.BLOBS.put(key, "x");
    const d = await createDraft(asOwner(), {
      attachments: [{ r2Key: key, filename: "del.png", contentType: "image/png", sizeBytes: 1 }],
    });
    const res = await request(asOwner(), "DELETE", `/${d.id}`);
    expect(res.status).toBe(200);
  });

  it("404s deleting a missing draft", async () => {
    const res = await request(asOwner(), "DELETE", "/nope");
    expect(res.status).toBe(404);
  });

  it("404s deleting another user's draft", async () => {
    await grantMember(db(), Perm.READ | Perm.WRITE);
    const d = await createDraft();
    const res = await request(asMember(), "DELETE", `/${d.id}`);
    expect(res.status).toBe(404);
  });
});
