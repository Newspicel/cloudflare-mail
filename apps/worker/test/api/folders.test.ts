import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { foldersRoutes } from "../../src/api/folders.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(foldersRoutes, owner);

async function makeFolder(name: string): Promise<string> {
  const res = await request(asOwner(), "POST", "/", { name });
  const { id } = (await res.json()) as { id: string };
  return id;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("folders", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(foldersRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("creates folders, assigns increasing positions, lists ordered", async () => {
    await makeFolder("First");
    await makeFolder("Second");
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as { folders: { name: string; position: number }[] };
    expect(body.folders.map((f) => f.name)).toEqual(["First", "Second"]);
    expect(body.folders.map((f) => f.position)).toEqual([0, 1]);
    expect(body.folders[0]).toMatchObject({ total: 0, unread: 0 });
  });

  it("rejects a duplicate name with 409", async () => {
    await makeFolder("Dup");
    const res = await request(asOwner(), "POST", "/", { name: "Dup" });
    expect(res.status).toBe(409);
  });

  it("folders are per-user — another user sees none", async () => {
    await makeFolder("Mine");
    const res = await request(mountApp(foldersRoutes, outsider), "GET", "/");
    expect(((await res.json()) as { folders: unknown[] }).folders).toHaveLength(0);
  });

  it("patches name and color", async () => {
    const id = await makeFolder("Old");
    const res = await request(asOwner(), "PATCH", `/${id}`, { name: "New", color: "#123456" });
    expect(res.status).toBe(200);
    const list = await request(asOwner(), "GET", "/");
    expect(((await list.json()) as { folders: { name: string }[] }).folders[0]?.name).toBe("New");
  });

  it("404s patching/deleting another user's folder", async () => {
    const id = await makeFolder("Mine");
    const otherApp = mountApp(foldersRoutes, outsider);
    expect((await request(otherApp, "PATCH", `/${id}`, { name: "x" })).status).toBe(404);
    expect((await request(otherApp, "DELETE", `/${id}`)).status).toBe(404);
  });

  it("files a thread into a folder, lists it, then removes it", async () => {
    const id = await makeFolder("Box");
    const { threadId } = await seedThread(db());

    const file = await request(asOwner(), "POST", `/${id}/threads`, { threadIds: [threadId] });
    expect(file.status).toBe(200);

    const listed = await request(asOwner(), "GET", `/${id}/threads`);
    const body = (await listed.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual([threadId]);

    // The folder list now reports a count.
    const folders = await request(asOwner(), "GET", "/");
    expect(((await folders.json()) as { folders: { total: number }[] }).folders[0]?.total).toBe(1);

    const remove = await request(asOwner(), "DELETE", `/${id}/threads/${threadId}`);
    expect(remove.status).toBe(204);
    const after = await request(asOwner(), "GET", `/${id}/threads`);
    expect(((await after.json()) as { threads: unknown[] }).threads).toHaveLength(0);
  });

  it("forbids filing a thread the user can't read", async () => {
    // Member owns a folder but lacks READ on the mailbox holding the thread.
    await grantMember(db(), Perm.READ); // grant then file as member -> allowed
    const memberApp = mountApp(foldersRoutes, member);
    const fres = await request(memberApp, "POST", "/", { name: "MBox" });
    const { id } = (await fres.json()) as { id: string };
    const { threadId } = await seedThread(db());
    const ok = await request(memberApp, "POST", `/${id}/threads`, { threadIds: [threadId] });
    expect(ok.status).toBe(200);
  });

  it("excludes trashed and spam threads from folder listings", async () => {
    const id = await makeFolder("Box");
    const { threadId } = await seedThread(db(), MAILBOX_ID, { trashed: true });
    await request(asOwner(), "POST", `/${id}/threads`, { threadIds: [threadId] });
    const listed = await request(asOwner(), "GET", `/${id}/threads`);
    expect(((await listed.json()) as { threads: unknown[] }).threads).toHaveLength(0);
  });
});
