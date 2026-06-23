# CLAUDE.md

Guidance for AI assistants. Keep it small and rule-focused — don't let it go stale.

## Discover, don't memorize

Read current state instead of trusting prose here:

- **Stack/versions** → `package.json` (root + per-app)
- **Data model** → `packages/db/src/schema.ts`
- **API** → `apps/worker/src/api/*`
- **Mail pipelines** → `apps/worker/src/mail/{receive,send,mime,threads}.ts`
- **RBAC** → `apps/worker/src/permissions.ts`
- **Deploy/bindings** → `apps/worker/wrangler.jsonc`
- **Commands** → `package.json` scripts + `README.md`

## Invariants (don't break without approval)

1. **One Worker.** `apps/worker` is the only runtime (`fetch`, `email`, `scheduled`, `UserHub` DO). Don't add a separate service.
2. **RBAC everywhere.** Mailbox routes go through `permissions.ts` (`requirePerm` / `resolveAccess`). Don't reimplement the owner shortcut.
3. **Mailbox types:** `service` = key-driven, no owner/members in the UI (see invariant 16); `temp` = must have `expiresAt` (cron deletes); `group` = perms from `mailbox_member.perms` bits.
4. **Mail:** inbound parsed with postal-mime; outbound via `env.EMAIL.send()` with structured fields (not `raw`); sent copy built with mimetext and archived to R2. *Exception:* PGP-enabled sends build RFC 3156 PGP/MIME and go out raw via `env.EMAIL.send(new EmailMessage(from, to, raw))` (invariant 18).
5. **R2 keys** (downstream depends on these): `raw/<mailboxId>/<uuid>.eml`, `raw/<mailboxId>/sent/<messageId>.eml`, `att/<messageId>/<idx>-<file>`, `draft/<userId>/<uuid>-<file>`, `plain/<mailboxId>/<uuid>.eml` (decrypted copy of inbound PGP mail; invariant 18).
6. **Realtime is SSE** via `UserHub` DO. No WebSockets/polling.
7. **Zero-config init.** No env-specific values or secrets in `wrangler.jsonc`. Base URL from request, auth secret lazy-stored in `system_config`, per-domain config in `domain` table.
8. **Admin-controlled signup.** Public sign-up disabled. First run = `/api/bootstrap`; others via admin endpoints or invite tokens. No open sign-up path.
9. **Admin password reset is not self-service** (`sendResetPassword` no-ops for admins). Recovery via 2FA backup codes or CLI.
10. **Mailbox creation** goes through `mailbox-access.ts#authorizeMailboxCreate` (checks `domain.allowedKinds` + `domain_grant`; admins bypass grant).
11. **Secrets stay out of the repo.** Dev uses `.dev.vars` (gitignored).
12. **Redirects are inbound-only aliases** (`redirect` table). Used only when no mailbox matches; a real mailbox always wins. A `localPart` of `*` is the per-domain catch-all, which fires only when no mailbox and no specific redirect match (exact > catch-all). Envelope recipient stored in `message.deliveredTo`.
13. **Migrations via `drizzle-kit generate`.** Edit `schema.ts`, then `pnpm --filter @cfmail/db generate` to emit `drizzle/NNNN_*.sql` + snapshot + `_journal.json` entry. Apply with `pnpm --filter @cfmail/db migrate` (wrangler D1; runs in deploy). Keep the snapshot chain intact — every `meta/NNNN_snapshot.json` must be present with `idx` aligned to filenames, or `generate` falls back to diffing an old snapshot and prompts interactively. Hand-writing a migration is fine for things `generate` can't express (e.g. FTS triggers, `0001_message_fts`), but then keep the snapshot/journal consistent.
14. **PWA + Web Push.** The web app is an installable PWA (`apps/web/public/manifest.webmanifest` + `sw.js`, registered prod-only from `lib/pwa.ts`). New mail push is best-effort and never fails delivery: VAPID keys lazy-stored in `system_config` (like invariant 7), devices in `push_subscription`, per-user/per-mailbox opt-in in `mailbox_notify`. Fan-out lives in `apps/worker/src/mail/push.ts`; dead subscriptions (404/410) are pruned.
15. **Spam filtering** (`apps/worker/src/mail/spam.ts`, `evaluateSpam`) runs in `receive.ts` after parse, before insert. Per-mailbox `mailbox.spamFilter` level (`off`/`auth`/`standard`/`ai`); result stored on the message (`spamVerdict`/`spamScore`/`spamReasons`/`spamAuth`). Rules: DMARC `pass` is trusted (short-circuit clean); only a brand-new thread is auto-filed to Spam (never hijack an existing one); DNSBL is a best-effort soft signal that can't mark spam alone; AI (`@cf/meta/llama-3.1-8b-instruct-fast` via `AI` binding) runs only in the gray zone, respects the per-mailbox monthly token cap, and logs usage to `mailbox_spam_usage`.
16. **Service mailboxes are key-driven** (`apps/worker/src/api/svc.ts`). Auth is a bearer API key (UUID), not a session — only its SHA-256 hash is stored in `mailbox.serviceKeyHash`; the plaintext is shown once on create/rotate. Single key, instant cutover. They never appear in `/api/mailboxes` or the sidebar; create/rotate/delete is admin-only via `/api/admin/service`. `mailbox.serviceMode` = `duplex` (accept inbound, poll via `GET /api/svc/messages`) or `send` (hard-bounce inbound). Inbound is retained 30 days then purged by the cron (`cron.ts`, thread-level by `lastMsgAt`).
17. **Custom folders are user-level, not per-mailbox** (`apps/worker/src/api/folders.ts`, `/api/folders`). The `folder` table is owned by a user; filing a thread is a per-user assignment in `thread_folder` (PK `userId+threadId` → one folder per thread per user). Filing is a true *move*: filed threads are hidden from that user's active mailbox views (inbox/sent/marked, counts, mailbox unread badge) via the `notFiledBy` `NOT EXISTS` guard, but trash/spam still win (folder views exclude trashed/spam). Owner-checked (`requireOwnFolder`); filing only needs `Perm.READ`. Web: sidebar `FoldersNav`, `/app/folder/$folderId` routes, native HTML5 drag-and-drop (`lib/dnd.ts`) plus the toolbar "Move to folder" menu for touch. Don't confuse with `label` (per-mailbox tags, many-per-message).
18. **Gateway PGP is opt-in per mailbox** (`apps/worker/src/mail/pgp.ts`, openpgp v6). `mailbox.pgpMode` = `off`/`sign`/`sign_encrypt`. **Not end-to-end** — the Worker holds the mailbox keypair (`pgpPublicKey` clear; `pgpPrivateKeyWrapped` + `pgpPassphraseWrapped` AES-GCM-wrapped at rest under the lazy `pgp_master_key` in `system_config`, like invariant 7) so it can decrypt inbound for search/spam/threading and sign/encrypt outbound. Outbound (`send.ts`): build RFC 3156 PGP/MIME, encrypt to every recipient key in `contact_key` + self; if any recipient lacks a key, fall back to **signed-only** + warn (never block); send raw per recipient; archive **plaintext** at `raw/.../sent/...` so local search works. Inbound (`receive.ts` → `ingestRaw`): decrypt/verify before spam+index, keep ciphertext at `rawR2Key` and the decrypted `.eml` at `plainR2Key` (the body endpoint reads `plainR2Key ?? rawR2Key`); TOFU-capture attached sender keys into `contact_key`; never reject on PGP failure (`pgpVerify` = `good`/`bad`/`unknown`). All key/contact management is owner-facing (`Perm.MANAGE`) on `/api/mailboxes/:id` — surfaced in user settings, not admin. Private key/passphrase are never returned by the API.

## Tooling

- Typecheck: `pnpm typecheck` (tsgo). Don't use `tsc` or `composite: true`.
- Lint: `pnpm lint` (oxlint + Biome — keep both passing).
- `apps/web/src/routeTree.gen.ts` is generated by `tsr generate`. Don't edit it.
- New deps must run on the Workers runtime (no `fs`/native/Node-only unless `nodejs_compat` covers it).

## Working style

- Terse updates, no speculative features, no comments restating code, no back-compat shims.
- Push directly to `main`.
- **There is now a production deployment.** Schema changes need a migration (invariant 13) — don't assume you can drop/recreate tables.
- When two approaches both touch an invariant above, ask before coding.
- New invariant worth keeping? Add it here as a rule, never as a state snapshot.
