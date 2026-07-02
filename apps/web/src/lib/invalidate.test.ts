import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadChangeCoalescer, invalidateThreadChange } from "./invalidate.ts";
import { keys } from "./query-keys.ts";

function harness() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const invalidatedKeys = () =>
    spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  return { qc, spy, invalidatedKeys };
}

describe("invalidateThreadChange — scope semantics", () => {
  it("a bare mailbox change refreshes only that mailbox's thread root (plus the All view)", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).toEqual([keys.threadsRoot("mb-1"), keys.threadsRoot("all")]);
  });

  it("threadId adds the open thread detail", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1", threadId: "t-1" });
    expect(invalidatedKeys()).toContainEqual(keys.thread("t-1"));
  });

  it("counts gates the mailbox badge refresh", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).not.toContainEqual(keys.mailboxes());

    invalidateThreadChange(qc, { mailboxId: "mb-1", counts: true });
    expect(invalidatedKeys()).toContainEqual(keys.mailboxes());
  });

  it("folders gates the folder list + folder-threads refresh", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).not.toContainEqual(keys.folders());
    expect(invalidatedKeys()).not.toContainEqual(keys.folderThreadsRoot());

    invalidateThreadChange(qc, { mailboxId: "mb-1", folders: true });
    expect(invalidatedKeys()).toContainEqual(keys.folders());
    expect(invalidatedKeys()).toContainEqual(keys.folderThreadsRoot());
  });

  it("a change already scoped to the All view does not double-invalidate it", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "all" });
    expect(invalidatedKeys()).toEqual([keys.threadsRoot("all")]);
  });
});

describe("createThreadChangeCoalescer — batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges a burst of pushes into one invalidation cycle with the union scope", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", threadId: "t-1" });
    co.push({ mailboxId: "mb-1", threadId: "t-2", counts: true });
    co.push({ mailboxId: "mb-2", folders: true });

    // Nothing fires inside the window.
    vi.advanceTimersByTime(1499);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    const got = invalidatedKeys();
    // One cycle: each root exactly once, with the merged flags applied.
    expect(got).toContainEqual(keys.threadsRoot("mb-1"));
    expect(got).toContainEqual(keys.threadsRoot("mb-2"));
    expect(got).toContainEqual(keys.threadsRoot("all"));
    expect(got).toContainEqual(keys.thread("t-1"));
    expect(got).toContainEqual(keys.thread("t-2"));
    expect(got).toContainEqual(keys.mailboxes());
    expect(got).toContainEqual(keys.folders());
    expect(got).toContainEqual(keys.folderThreadsRoot());
    expect(got).toHaveLength(8);
  });

  it("a push after a flush opens a fresh window with a clean scope", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", counts: true });
    vi.advanceTimersByTime(1500);
    spy.mockClear();

    co.push({ mailboxId: "mb-2" });
    vi.advanceTimersByTime(1500);
    const got = invalidatedKeys();
    // The earlier counts/mailbox scope must not bleed into the new cycle.
    expect(got).toEqual([keys.threadsRoot("mb-2"), keys.threadsRoot("all")]);
  });

  it("dispose flushes pending work immediately", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", threadId: "t-1" });
    co.dispose();
    expect(invalidatedKeys()).toContainEqual(keys.threadsRoot("mb-1"));
    expect(invalidatedKeys()).toContainEqual(keys.thread("t-1"));

    // And nothing fires again when the timer would have elapsed.
    spy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dispose with nothing pending is a no-op", () => {
    const { qc, spy } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);
    co.dispose();
    expect(spy).not.toHaveBeenCalled();
  });
});
