# Contributing

Thanks for considering a contribution. The codebase is small and opinionated — please read this once before opening a PR so we stay aligned.

## Ground rules

- **Read `CLAUDE.md` first.** It captures the invariants (single Worker, RBAC on every route, R2 key namespaces, etc.) that keep the project safe to change. They apply to humans too.
- **One Worker.** Don't split `apps/worker` into multiple Workers or add a separate API service.
- **Discover, don't memorize.** `package.json`, `wrangler.jsonc`, and `packages/db/src/schema.ts` are the source of truth for stack, bindings, and data model. Don't duplicate those facts in prose.

## Branching and PRs

- Branch off `main`. Name branches `<type>/<short-slug>` (e.g. `feat/labels-ui`, `fix/thread-merge`, `docs/deploy-guide`).
- There is no protected `develop` branch — main is the trunk. Schema changes don't need a migration window: edit `packages/db/src/schema.ts`, regenerate (`pnpm db:generate`), and ship.
- Keep PRs focused. A bug fix doesn't need surrounding cleanup; a new feature doesn't need a refactor folded in.
- If your PR addresses an item in [issue #1](https://github.com/Newspicel/cloudflare-mail/issues/1), link it in the description so the tracker stays accurate.

### Required local checks

Run before opening the PR:

```bash
pnpm typecheck    # tsgo across all packages
pnpm lint         # oxlint + biome
pnpm build        # Vite + wrangler deploy --dry-run
pnpm test         # vitest (worker)
```

All four must be green. `pnpm lint` runs oxlint and Biome — both. Don't silence a rule in one without considering the other.

### Commit messages

Conventional Commits, scoped where it helps reviewers:

```
feat(worker): bounce-loop protection on inbound
fix(web): keep compose dock open after attachment upload
perf(worker): parallelize attachment fetch in send pipeline
docs: add deployment guide
```

Squash-merge is fine; the PR title becomes the commit on `main`.

## Running locally against a real Cloudflare account

`wrangler dev` against the real Workers runtime is the only way to exercise the email bindings end-to-end. Local-only D1/R2 is good for UI work; for mail flow you want both ends real.

### One-time setup

Follow [`docs/DEPLOY.md`](./docs/DEPLOY.md) against a **personal / staging zone** you control. You'll end up with:

- Wrangler logged in (`wrangler login`)
- A real D1 database and R2 bucket
- The zone's MX records pointed at Cloudflare Email Routing
- A verified Email Sending domain

No `BETTER_AUTH_SECRET` setup is required — the Worker lazy-generates one on first request and stores it in D1 (`system_config`). Per-domain config (which mailbox kinds a domain accepts, who can create what) lives in D1 too.

### Local dev loop

```bash
# Vite (:5173) proxies /api to Wrangler (:8787)
pnpm dev
```

Two important flags when developing against real bindings:

- **D1**: `wrangler dev` uses a local SQLite by default. To hit your real D1, run `pnpm --filter @cfmail/worker exec wrangler dev --remote` instead. Same for R2.
- **Email Sending**: the `EMAIL` binding is already `"remote": true` in `wrangler.jsonc`, so `env.EMAIL.send()` reaches Cloudflare Email Sending even under local `wrangler dev`. Use a test sending domain so you don't spam real users.
- **Inbound (`email()`)**: cannot be triggered by `wrangler dev`. Either deploy to a staging Worker and use Email Routing for real inbound, or write a `.eml` fixture and feed it through the integration test suite (`apps/worker/test/inbound.test.ts` shows the shape).
- **Cron (`scheduled()`)**: doesn't fire under `wrangler dev` automatically. Run `wrangler dev --test-scheduled` and POST to `/__scheduled` to trigger it.

### Testing your changes

- `pnpm test` runs the worker integration suite via `@cloudflare/vitest-pool-workers` — it spins up a real Workers runtime against a local D1 + R2, so inbound, RBAC, threading, and cron logic are all exercised without a real Cloudflare account.
- For UI changes, run `pnpm dev` and click through the affected flows in a browser. Type-checking does not catch UX regressions.

## Code style

- Follow the existing patterns. When in doubt, grep for similar code rather than introducing a new abstraction.
- No comments that restate the code; only comments that explain *why* a non-obvious decision was made.
- No backwards-compat shims or feature flags for code that doesn't exist yet. There's no production deployment to migrate from.
- Don't reintroduce `composite: true` project references — the workspace resolves via `paths`, not `tsc --build`.
- New runtime dependencies must work on the Workers runtime (no `fs`, no native modules, no Node-only APIs unless `nodejs_compat` covers them).

## Reporting bugs / requesting features

Open an issue with a minimal repro (or, for features, the user-visible behavior you want). If it's a sub-task of [the roadmap tracker](https://github.com/Newspicel/cloudflare-mail/issues/1), link back to it.

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE) that covers the project.
