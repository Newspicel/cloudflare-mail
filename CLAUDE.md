# CLAUDE.md

Guidance for AI assistants. Only rules and intent you *can't* recover by reading the code. Keep it small; point at code instead of restating it.

## Discover, don't memorize

- **Stack/versions** → `package.json` (root + per-app)
- **Data model** → `packages/db/src/schema.ts`
- **API** → `apps/worker/src/api/*`
- **Mail pipelines** → `apps/worker/src/mail/{receive,send,mime,threads,spam,pgp,push}.ts`
- **RBAC** → `apps/worker/src/permissions.ts`
- **Deploy/bindings** → `apps/worker/wrangler.jsonc`
- **Commands** → `package.json` scripts + `README.md`

## Invariants (don't break without approval)

1. **One Worker.** `apps/worker` is the only runtime (`fetch`, `email`, `scheduled`, `UserHub` DO). Don't add a separate service.
2. **RBAC everywhere.** Mailbox routes go through `permissions.ts`. Don't reimplement the owner shortcut.
3. **Realtime is SSE** via `UserHub` DO. No WebSockets, no polling.
4. **Zero-config / secrets out of the repo.** No env-specific values or secrets in `wrangler.jsonc`; lazy-store them in `system_config` instead. Base URL is derived from the request. Dev secrets live in `.dev.vars` (gitignored).
5. **No open sign-up by design.** First run bootstraps an admin; everyone else comes via admin endpoints or invite tokens. Admin password reset is intentionally not self-service.
6. **R2 key layouts are a contract.** Other code parses these paths — change a scheme and you must migrate existing objects.
7. **Gateway PGP is not end-to-end.** The Worker holds the mailbox keypair so it can decrypt for search/spam/threading. Never reject mail on PGP failure; never return private keys from the API.
8. **Mail never hard-fails on best-effort steps** — spam scoring, PGP, and push must not block delivery.

## Migrations (the one workflow you can't infer)

Edit `schema.ts`, then `pnpm --filter @cfmail/db generate` to emit the `drizzle/NNNN_*.sql` + snapshot + journal entry; apply with `pnpm --filter @cfmail/db migrate` (runs in deploy). Keep the snapshot/journal chain intact and contiguous or `generate` silently diffs an old snapshot. Hand-writing a migration is fine for what `generate` can't express (FTS triggers), but keep snapshot + journal consistent. Production data exists — never drop/recreate tables.

## Tooling

- Typecheck: `pnpm typecheck` (tsgo — not `tsc`, no `composite: true`).
- Lint: `pnpm lint` (oxlint + Biome — keep both green).
- `apps/web/src/routeTree.gen.ts` is generated (`tsr generate`). Don't edit it.
- New deps must run on the Workers runtime (no Node-only APIs unless `nodejs_compat` covers them).

## Working style

- Terse updates, no speculative features, no comments restating code, no back-compat shims.
- Push directly to `main`.
- When a change touches an invariant above, ask before coding.
- New rule worth keeping? Add it here as a rule, never as a state snapshot.
