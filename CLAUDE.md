# CLAUDE.md

Guidance for AI assistants. Only rules and intent you *can't* recover by reading the code. Keep it small; point at code instead of restating it.

## Discover, don't memorize

- **Stack/versions** → `package.json` (root + per-app)
- **Data model** → `packages/db/src/schema.ts`
- **API** → `apps/worker/src/api/*`
- **Mail pipelines** → `apps/worker/src/mail/{receive,send,mime,threads,spam,dnsbl,pgp,push}.ts`
- **IMAP** → `apps/worker/src/imap/*` (`protocol` wire, `session` state machine, `store` mail semantics)
- **RBAC** → `apps/worker/src/permissions.ts`
- **Deploy/bindings** → `apps/worker/wrangler.jsonc`
- **Commands** → `package.json` scripts + `README.md`

## Invariants (don't break without approval)

1. **One Worker.** `apps/worker` is the only runtime (`fetch`, `email`, `scheduled`, `connect`, `UserHub` DO). Don't add a separate service — a new protocol is a new handler, not a new script.
2. **RBAC everywhere.** Mailbox routes go through `permissions.ts`. Don't reimplement the owner shortcut.
3. **Realtime is SSE** via `UserHub` DO — the web app and IMAP `IDLE` both ride it. No WebSockets, no polling (IMAP's slow re-reconcile timer is a backstop for peers' changes the hub can't see, not a substitute).
4. **Zero-config / secrets out of the repo.** No env-specific values or secrets in `wrangler.jsonc`; lazy-store them in `system_config` instead. Base URL is derived from the request. Dev secrets live in `.dev.vars` (gitignored).
5. **No open sign-up by design.** First run bootstraps an admin; everyone else comes via admin endpoints or invite tokens. Admin password reset is intentionally not self-service.
6. **R2 key layouts are a contract.** Other code parses these paths — change a scheme and you must migrate existing objects.
7. **Gateway PGP is not end-to-end.** The Worker holds the mailbox keypair so it can decrypt for search/spam/threading. Never reject mail on PGP failure; never return private keys from the API.
8. **Mail never hard-fails on best-effort steps** — spam scoring, PGP, and push must not block delivery.
9. **`HTTPException` lives in `api/` only.** Everything below it throws `AppError` (`errors.ts`) with a transport-neutral code, so one failure can be a JSON 4xx and a tagged IMAP `NO`. Transports translate; nothing else does.
10. **Spamhaus: who sent it can refuse, what's in it only scores.** DQS (`mail/dnsbl.ts`) runs only when an admin has stored a query key. A ZEN hit on the connecting host, or a DBL/ZRD hit on a name the sending side asserts (envelope/header From, EHLO), SMTP-rejects with the listing named so the sender can delist. Content — abused-legit DBL codes, link domains, HBL hashes — only scores, and no listing may reach `SPAM_AT` alone except an HBL malware-file hash, which is an exact match rather than a reputation guess. Lookups stay best-effort: a DNS failure or error code never blocks mail. Public DNSBL zones don't work here at all (a Worker resolves via DoH, i.e. a public resolver).
11. **A signature is not a character reference.** `dmarc=pass` retires the forgery signals and the connecting-IP check, nothing else: reputation and content checks run for authenticated mail too. Spam *phrasing* is the exception — it's too weak to outvote an aligned signature, so for authenticated mail it only decides whether the AI level takes a look.
12. **IMAP folders are derived, never stored.** `store.ts` computes membership from thread/message state on every load; `imap_folder`/`imap_uid` own only the UID space. A message that leaves a folder and returns gets a *new, higher* UID — never reuse one, and never let a mail pipeline write IMAP tables.
13. **A brand logo is decoration, not a credential.** BIMI (`mail/bimi.ts`) resolves a sender domain's logo and nothing more: the `a=` mark certificate is never verified, a result never feeds spam scoring or the auth banner, and a logo must never make a message *look* better authenticated than it is. Indicators go through the SSRF guard, are sanitized and size-capped, and are cached with a TTL — including misses, which are the common case.

## Migrations (the one workflow you can't infer)

Edit `schema.ts`, then `pnpm --filter @cfmail/db generate` to emit the `drizzle/NNNN_*.sql` + snapshot + journal entry; apply with `pnpm --filter @cfmail/db migrate` (runs in deploy). Keep the snapshot/journal chain intact and contiguous or `generate` silently diffs an old snapshot. Hand-writing a migration is fine for what `generate` can't express (FTS triggers), but keep snapshot + journal consistent. Production data exists — never drop/recreate tables.

## Tooling

- Typecheck: `pnpm typecheck` (`tsc` from `typescript@7`, the native compiler — no `composite: true`).
- Lint: `pnpm lint` (oxlint + Biome — keep both green).
- `apps/web/src/routeTree.gen.ts` is generated (`tsr generate`). Don't edit it.
- New deps must run on the Workers runtime (no Node-only APIs unless `nodejs_compat` covers them).

## Working style

- Terse updates, no speculative features, no comments restating code, no back-compat shims.
- Push directly to `main`.
- When a change touches an invariant above, ask before coding.
- New rule worth keeping? Add it here as a rule, never as a state snapshot.
- Always use Shadcn wherever possible for UI consistency. Don't invent new components or styles. (Also Search online for Components if missing before implementing new ones.)
- Ignore changes you didn't make. Because multiple parrallel agents can run. Only commit your changes.
