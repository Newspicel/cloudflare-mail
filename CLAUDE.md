# CLAUDE.md

Guidance for AI assistants (Claude Code, Cursor, etc.) contributing to this repo. Keep this file small and rule-focused — it must not go stale as code evolves.

## Discover, don't memorize

Prefer reading current state over facts in prose:

- **Stack and versions** → `package.json` files (root + per-app). Use `npm view <pkg> version` before changing a version.
- **Data model** → `packages/db/src/schema.ts` (single source of truth).
- **API surface** → `apps/worker/src/api/*`.
- **Mail pipelines** → `apps/worker/src/mail/{receive,send,mime,threads}.ts`.
- **RBAC** → `apps/worker/src/permissions.ts`.
- **Deploy shape and bindings** → `apps/worker/wrangler.jsonc`.
- **Run/verify commands** → `package.json` scripts and `README.md`.

Do not paste stack details into this file or any other doc. If `package.json` says Hono, don't also say "we use Hono" somewhere else — it will drift.

## Invariants (don't violate without explicit approval)

1. **One Worker.** `apps/worker` is the only runtime. It exports `fetch`, `email`, `scheduled`, and the `UserHub` Durable Object. Don't split into multiple Workers or add a separate API service.
2. **RBAC on every authenticated route.** Any route that touches a mailbox MUST go through `permissions.ts#requirePerm(db, userId, mailboxId, bit)` or call `resolveAccess` and check the bit. The owner shortcut lives inside that helper — don't reimplement it.
3. **Mailbox-type semantics:**
   - `service` → reject inbound in `mail/receive.ts`; send-only.
   - `temp` → MUST have `expiresAt` set; `cron.ts` deletes expired rows and their R2 blobs.
   - `group` → permissions come from `mailbox_member.perms` bits, not from hard-coded role strings.
4. **Inbound parsing is postal-mime.** Outbound send uses `env.EMAIL.send()` with *structured fields* (`from/to/cc/bcc/subject/text/html/headers/attachments`), not the `raw` field. A copy of the sent message is built with mimetext and archived to R2.
5. **R2 key namespaces** (keep them; downstream code depends on them):
   - `raw/<mailboxId>/<uuid>.eml` — inbound raw
   - `raw/<mailboxId>/sent/<messageId>.eml` — sent copy
   - `att/<messageId>/<idx>-<sanitized-filename>` — extracted attachments
   - `draft/<userId>/<uuid>-<sanitized-filename>` — user uploads pending send
6. **Realtime uses SSE.** Per-user `UserHub` Durable Object fans out. Don't add WebSockets or polling alongside it.
7. **Zero-config init.** `wrangler.jsonc` must not contain env-specific values (no `APP_URL`, no `TEMP_DOMAIN`, no secrets). The base URL is derived from the incoming request, the auth secret is lazy-generated and stored in `system_config` (see `apps/worker/src/config.ts`), and per-domain config lives in the `domain` table. A fresh deploy should require no manual secret setup.
8. **Admin-controlled signup.** Public sign-up is disabled (`disableSignUp: true` in Better Auth). First-run goes through `/api/bootstrap`; subsequent accounts are created via admin endpoints in `apps/worker/src/api/users.ts` or invite-token redemption. Don't reintroduce an open `/api/auth/sign-up/email` path.
9. **Admin password reset is intentionally not self-service.** `sendResetPassword` in `auth.ts` no-ops for users with `role === "admin"`. Recovery is via 2FA backup codes or a CLI `wrangler d1 execute` reset. Don't add a UI flow that bypasses this.
10. **Mailbox creation goes through `mailbox-access.ts#authorizeMailboxCreate`.** That helper checks both `domain.allowedKinds` (does the domain permit this kind?) and `domain_grant` (is this user permitted?). Admins bypass the grant check. Don't duplicate this logic in route handlers.
11. **Secrets stay out of the repo.** No `.env`, no real tokens in `wrangler.jsonc`. Development is `.dev.vars` (gitignored, but no longer required for `BETTER_AUTH_SECRET` since it's DB-stored).

## Tooling rules

- Typecheck via **tsgo** (`pnpm typecheck`). Do not invoke `tsc` directly or re-introduce `composite: true` project references — the current setup resolves across workspaces via `paths`, not `tsc --build`.
- Lint via **oxlint + Biome** (`pnpm lint`). Both must pass; keep them in sync — don't silence a rule in one without considering the other.
- Route tree is generated: `apps/web/src/routeTree.gen.ts` is produced by `tsr generate`. The `typecheck` script runs it first; do not edit the generated file.
- When adding a runtime dependency, verify it works on the Workers runtime (no `fs`, no native modules, no Node-only APIs unless `nodejs_compat` covers it).

## Working style

- Follow the global rules (see the main Claude Code system prompt): terse updates, no speculative features, no comments that restate the code, no backwards-compat shims when you can just change the code.
- When unsure between two approaches that touch the invariants above, ask before coding.
- If you add a new invariant worth preserving, add it to this file — but only as a rule, never as a snapshot of current state.
- Push directly to `main`; there is no production deployment yet, so schema changes don't need migrations — edit `packages/db/src/schema.ts` and regenerate.
