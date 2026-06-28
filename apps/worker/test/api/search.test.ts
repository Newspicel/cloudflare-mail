import { message, thread } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchRoutes } from "../../src/api/search.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asOwner = () => mountApp(searchRoutes, owner);

let seq = 0;

// Insert a thread + message with explicit search-relevant fields. The FTS
// triggers index subject/snippet/body/from/to on insert, so the message becomes
// searchable immediately.
async function seedMessage(
  over: {
    mailboxId?: string;
    subject?: string;
    snippet?: string;
    bodyText?: string;
    fromAddr?: string;
    fromName?: string;
    toText?: string;
    direction?: "in" | "out";
    flags?: number;
    trashed?: boolean;
    spam?: boolean;
    receivedAt?: Date;
  } = {},
): Promise<{ threadId: string; messageId: string }> {
  const mailboxId = over.mailboxId ?? MAILBOX_ID;
  const threadId = `s-thread-${++seq}`;
  const messageId = `s-msg-${seq}`;
  await db()
    .insert(thread)
    .values({
      id: threadId,
      mailboxId,
      subjectNorm: over.subject ?? "subject",
      msgCount: 1,
      trashed: over.trashed ?? false,
      spam: over.spam ?? false,
    });
  await db()
    .insert(message)
    .values({
      id: messageId,
      mailboxId,
      threadId,
      direction: over.direction ?? "in",
      fromAddr: over.fromAddr ?? "sender@elsewhere.test",
      fromName: over.fromName ?? "Sender",
      toText: over.toText ?? "team@example.com",
      subject: over.subject ?? "subject",
      snippet: over.snippet ?? "snippet",
      bodyText: over.bodyText ?? "body",
      flags: over.flags ?? 0,
      receivedAt: over.receivedAt ?? new Date(),
    });
  return { threadId, messageId };
}

interface SearchBody {
  results: { messageId: string; mailboxId: string; mailboxAddress: string }[];
  hasMore: boolean;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("search", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(searchRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("400s invalid filters (malformed after date)", async () => {
    const res = await request(asOwner(), "GET", "/?after=notadate");
    expect(res.status).toBe(400);
  });

  it("400s invalid filters (limit out of range)", async () => {
    const res = await request(asOwner(), "GET", "/?limit=999");
    expect(res.status).toBe(400);
  });

  it("full-text matches a message by subject", async () => {
    await seedMessage({ subject: "Quarterly revenue report" });
    const res = await request(asOwner(), "GET", "/?q=quarterly");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.mailboxAddress).toBe("team@example.com");
    expect(body.hasMore).toBe(false);
  });

  it("runs a metadata-only query (no text) returning all readable messages", async () => {
    await seedMessage({ subject: "alpha" });
    await seedMessage({ subject: "beta" });
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(2);
  });

  it("returns empty (200) for a caller with no readable mailboxes", async () => {
    const res = await request(mountApp(searchRoutes, outsider), "GET", "/?q=anything");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it("403s when scoping to a mailbox the caller can't read", async () => {
    const res = await request(asOwner(), "GET", "/?mailboxId=does-not-exist");
    expect(res.status).toBe(403);
  });

  it("403s a member scoping to a mailbox outside their grant", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID);
    const res = await request(
      mountApp(searchRoutes, member),
      "GET",
      `/?mailboxId=${OTHER_MAILBOX_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it("scopes results to the requested mailbox", async () => {
    await seedMessage({ mailboxId: MAILBOX_ID, subject: "shared topic" });
    await seedMessage({ mailboxId: OTHER_MAILBOX_ID, subject: "shared topic" });
    const res = await request(asOwner(), "GET", `/?q=shared&mailboxId=${MAILBOX_ID}`);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.mailboxId).toBe(MAILBOX_ID);
  });

  it("lets a member with READ search their granted mailbox", async () => {
    await grantMember(db(), Perm.READ, MAILBOX_ID);
    await seedMessage({ mailboxId: MAILBOX_ID, subject: "grant visible" });
    const res = await request(mountApp(searchRoutes, member), "GET", "/?q=visible");
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(1);
  });

  it("paginates with a hasMore flag", async () => {
    await Promise.all([0, 1, 2].map((i) => seedMessage({ subject: `page item ${i}` })));
    const first = await request(asOwner(), "GET", "/?q=item&limit=2&page=0");
    const firstBody = (await first.json()) as SearchBody;
    expect(firstBody.results).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);

    const second = await request(asOwner(), "GET", "/?q=item&limit=2&page=1");
    const secondBody = (await second.json()) as SearchBody;
    expect(secondBody.results).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
  });

  it("filters by folder (spam excluded from the default 'any' view)", async () => {
    await seedMessage({ subject: "ham message" });
    await seedMessage({ subject: "spam message", spam: true });
    const any = await request(asOwner(), "GET", "/?q=message");
    expect(((await any.json()) as SearchBody).results).toHaveLength(1);

    const spam = await request(asOwner(), "GET", "/?q=message&folder=spam");
    expect(((await spam.json()) as SearchBody).results).toHaveLength(1);
  });

  it("filters by direction", async () => {
    await seedMessage({ subject: "inbound note", direction: "in" });
    await seedMessage({ subject: "outbound note", direction: "out" });
    const res = await request(asOwner(), "GET", "/?q=note&direction=out");
    const body = (await res.json()) as SearchBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.messageId).toBeDefined();
  });
});
