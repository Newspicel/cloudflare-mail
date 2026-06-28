# API route test harness

Integration tests for the Hono API handlers in `src/api/*`. They run the **real**
handlers, zod validators, and RBAC against a **real** D1 (the vitest-pool-workers
Miniflare DB), with Better Auth replaced by a one-line fixture.

## How it works

`mountApp(routesFactory, user)` builds a Hono app that:

- injects `db` + the given session `user` onto the context (what `sessionMiddleware`
  would set, minus the Better Auth round-trip), and
- mirrors the production `onError` shape so bodies are `{ error }` with the right status.

`request(app, method, path, body?)` fires a request; `body` is JSON-encoded when an
object. Returns a `Response`.

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fooRoutes } from "../../src/api/foo.ts";
import { applyMigrationsOnce, db, mountApp, request, resetDb } from "../support/app.ts";
import { MAILBOX_ID, owner, seedBase } from "../support/seed.ts";

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});

it("does the thing", async () => {
  const res = await request(mountApp(fooRoutes, owner), "GET", "/");
  expect(res.status).toBe(200);
});
```

## Fixtures (`support/seed.ts`)

`seedBase(db)` creates: users `admin`/`owner`/`member`/`outsider`, one `domain`, and
two mailboxes (`MAILBOX_ID`, `OTHER_MAILBOX_ID`) both owned by `owner`.

- The **owner shortcut** means `owner` can hit any route on those mailboxes.
- `member`/`outsider` hold no perms until you call `grantMember(db, perms, mailboxId?, userId?)`.
- `seedThread(db, mailboxId?, overrides?)` inserts a thread + one inbound message.
- `seedContactKey(...)` for PGP-contact rows.

## Conventions

- One test file per route module, in `test/api/<name>.test.ts`.
- Cover: happy path, the zod-validator 400, `requireUser` 401 (null user), RBAC 403
  (member without the perm), and 404 (missing entity / cross-mailbox).
- Keep extra per-suite seed helpers **inside the test file** — don't edit `support/seed.ts`
  from multiple suites in parallel.
