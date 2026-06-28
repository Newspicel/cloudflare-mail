import { message } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contactsRoutes } from "../../src/api/contacts.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { MAILBOX_ID, outsider, owner, seedBase, seedThread } from "../support/seed.ts";

const asOwner = () => mountApp(contactsRoutes, owner);

type Contacts = { contacts: { address: string; name?: string }[] };

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

describe("contacts", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(mountApp(contactsRoutes, null), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("includes accessible mailbox directory addresses", async () => {
    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as Contacts;
    const addrs = body.contacts.map((c) => c.address);
    // Both owned mailboxes appear as directory entries.
    expect(addrs).toContain("team@example.com");
    expect(addrs).toContain("other@example.com");
  });

  it("harvests addresses from message history and dedupes case-insensitively", async () => {
    const d = db();
    const { messageId } = await seedThread(d);
    await d
      .update(message)
      .set({
        fromAddr: "Alice@Example.test",
        fromName: "Alice",
        toAddrs: [{ address: "bob@example.test", name: "Bob" }],
      })
      .where(eq(message.id, messageId));

    const res = await request(asOwner(), "GET", "/");
    const body = (await res.json()) as Contacts;
    const alice = body.contacts.find((c) => c.address === "alice@example.test");
    expect(alice).toBeDefined();
    expect(alice?.name).toBe("Alice");
    expect(body.contacts.find((c) => c.address === "bob@example.test")).toBeDefined();
  });

  it("does not leak addresses from mailboxes the caller can't access", async () => {
    await seedThread(db(), MAILBOX_ID);
    const res = await request(mountApp(contactsRoutes, outsider), "GET", "/");
    const body = (await res.json()) as Contacts;
    // Outsider owns/manages nothing, so no directory + no history.
    expect(body.contacts).toHaveLength(0);
  });
});
