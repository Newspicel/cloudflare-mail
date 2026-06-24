# cloudflare-mail

A self-hostable, Gmail-style mail client that runs entirely on Cloudflare — one Worker serves the React app, the REST API, inbound mail (`email()`), and scheduled cleanup (`scheduled()`).

- **Four mailbox types**, all first-class with RBAC from day one:
  - `personal` — individual inbox
  - `group` — shared inbox with per-user READ / WRITE / MANAGE bit flags
  - `service` — send-only (no-reply style); inbound to these addresses is rejected
  - `temp` — disposable, TTL-based, random local-part, auto-collected by cron
- **Multi-domain** across primary + sub-domains
- **Gmail-style UI** — 3-pane layout, compose dock, SSE-driven live updates
- **Full-text search** over subjects, bodies, and recipients (D1 FTS5)
- **Organization** — labels, folders, reminders, and per-mailbox automation rules
- **Inbound pipeline** — threading, spam scoring, gateway PGP decrypt, one-click unsubscribe, calendar (`.ics`) parsing, blocklist
- **Push notifications** and a tracking-pixel image proxy
- **Everything on Cloudflare** — no external database, no SMTP servers to run

> Status: actively developed. Auth, RBAC, inbound/outbound mail, threading, search, labels/folders/rules, spam, PGP, reminders, calendar, push, temp GC, and SSE are wired end-to-end, with a Vitest suite covering the worker pipelines. Contributions welcome.

## Stack

| Layer         | Choice                                                             |
| ------------- | ------------------------------------------------------------------ |
| Runtime       | Cloudflare Workers (single Worker: `fetch` + `email` + `scheduled` + Durable Objects) |
| Storage       | D1 (SQLite, metadata), R2 (raw MIME + attachments), DO (SSE fan-out) |
| Inbound       | Cloudflare Email Routing → Worker `email()` handler                |
| Outbound      | Cloudflare Email Service (`env.EMAIL.send()`)                      |
| Auth          | [Better Auth](https://better-auth.com) on D1                       |
| MIME          | [postal-mime](https://github.com/postalsys/postal-mime) (parse), [mimetext](https://github.com/muratgozel/MIMEText) (build for archived copy) |
| API           | [Hono](https://hono.dev) + [Drizzle ORM](https://orm.drizzle.team) |
| Frontend      | React 19, Vite, Tailwind v4, shadcn/ui, TanStack Router + Query    |
| Tooling       | pnpm · Turborepo · Biome v2 · oxlint · tsgo (TypeScript 7)         |

## Architecture

One Worker owns every code path. There is no separate API service, no message queue worker, no static-asset host — just `apps/worker` with the bindings declared in `apps/worker/wrangler.jsonc`.

```mermaid
flowchart LR
  Browser["Browser SPA<br/>(apps/web)"]
  Inbound["Cloudflare<br/>Email Routing"]
  Cron["Cloudflare<br/>Cron Trigger"]
  Sender["Outbound recipient<br/>(env.EMAIL.send)"]

  subgraph Worker["apps/worker (single Worker)"]
    direction TB
    Fetch["fetch()<br/>Hono API + SPA assets"]
    Email["email()<br/>inbound handler"]
    Scheduled["scheduled()<br/>temp-mailbox GC"]
    Hub["UserHub<br/>(Durable Object, SSE fan-out)"]
  end

  D1[("D1<br/>metadata")]
  R2[("R2<br/>raw MIME + attachments")]
  Assets[("ASSETS<br/>Vite build")]

  Browser -- "/api/* (fetch + SSE)" --> Fetch
  Browser -- "/ (static)" --> Assets
  Assets --> Fetch
  Inbound --> Email
  Cron --> Scheduled
  Fetch --> D1
  Fetch --> R2
  Fetch --> Hub
  Email --> D1
  Email --> R2
  Email --> Hub
  Scheduled --> D1
  Scheduled --> R2
  Fetch -- "compose / reply" --> Sender
  Hub -- "SSE events" --> Browser
```

Bindings the Worker depends on (see `wrangler.jsonc`):

| Binding     | Type            | Purpose                                                          |
| ----------- | --------------- | ---------------------------------------------------------------- |
| `DB`        | D1              | Mailboxes, threads, messages, RBAC, FTS5 search                  |
| `BLOBS`     | R2              | Raw inbound `.eml`, archived sent copies, attachments, drafts    |
| `EMAIL`     | Send Email      | Outbound `env.EMAIL.send()` via Cloudflare Email Sending         |
| `USER_HUB`  | Durable Object  | Per-user SSE fan-out (`message_*`, `mailbox_*` events)           |
| `ASSETS`    | Static Assets   | Vite-built SPA, SPA fallback, `/api/*` routed to Worker first    |
| Cron        | `*/1 * * * *`   | `scheduled()` deletes expired temp mailboxes + their R2 keys     |
| Email route | Email Routing   | `email()` parses inbound, stores in R2/D1, broadcasts via DO     |

## Structure

```
apps/
  web/       # Vite + React 19 SPA (served as Static Assets from the Worker)
  worker/    # Cloudflare Worker — fetch + email + scheduled + UserHub DO
packages/
  db/        # Drizzle schema + D1 migrations
  shared/    # Zod schemas, permission bits, event types
```

Key files to orient from:

- `apps/worker/src/index.ts` — handler exports
- `apps/worker/src/mail/receive.ts`, `apps/worker/src/mail/send.ts` — mail pipelines
- `apps/worker/src/permissions.ts` — single RBAC checker
- `apps/worker/src/hub.ts` — SSE fan-out Durable Object
- `packages/db/src/schema.ts` — data model

## Quick start

The goal: fork, connect the repo to Cloudflare, open the URL, create the admin account in the browser. Deploys happen automatically on every push to `main` via Workers Builds — no `wrangler deploy`, no `wrangler secret put`, no editing env vars in `wrangler.jsonc`. Per-domain config (which mailbox kinds, who can create what) is configured in the in-app admin panel.

### 1. Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Email Sending requires it)
- A domain on Cloudflare with **Email Routing** enabled (per email-domain DNS still needs the standard MX + SPF/DKIM/DMARC records — the admin UI shows you what to paste)
- Node 22+, pnpm 10+

### 2. Install

```bash
git clone https://github.com/Newspicel/cloudflare-mail.git
cd cloudflare-mail
pnpm install
```

### 3. Provision resources (one time)

```bash
# D1 database — copy the printed database_id into apps/worker/wrangler.jsonc
pnpm --filter @cfmail/worker exec wrangler d1 create cfmail

# R2 bucket (name is referenced from wrangler.jsonc)
pnpm --filter @cfmail/worker exec wrangler r2 bucket create cfmail-blobs
```

Commit the updated `wrangler.jsonc` (with the new `database_id`) and push.

### 4. Connect the repo to Workers Builds

Deploys are handled by Cloudflare Workers Builds — connect once and every push to `main` builds and ships automatically.

1. Cloudflare dashboard → **Workers & Pages** → your worker → **Settings → Build**.
2. **Connect** your fork of the repo.
3. Set:
   - **Build command:** `pnpm run build`
   - **Deploy command:** `pnpm run deploy`
   - **Root directory:** `/`
   - **Production branch:** `main`
4. Save. The next push to `main` (or a manual "Retry build") builds the web app and Worker, runs the production D1 migrations, and deploys.

That's the whole deploy. The `deploy` script applies pending migrations (`@cfmail/db migrate --remote`) before `wrangler deploy`, so schema changes ship with the code. No secrets to set: the auth secret is lazy-generated on first request and stored in D1 (`system_config`). The app URL is derived from the request `Host` header, so whatever custom domain you bind to the Worker in the Cloudflare dashboard becomes your app URL automatically.

> Prefer the CLI? You can still deploy by hand with `pnpm run deploy` from a checkout authenticated via `wrangler login`.

### 5. First-run setup (in the browser)

1. Bind a custom domain to the deployed Worker (Cloudflare dashboard → Workers → your worker → Custom Domains).
2. Open that URL. The first visit shows a **Create administrator** form — this becomes the system admin.
3. Sign in. From the admin panel:
   - **Domains** tab → add the email domains you'll use, and tick which mailbox kinds each allows (`personal`, `group`, `service`, `temp`). The DNS-health badges and DNS records you need are shown inline.
   - **Users** tab → invite teammates (email link) or create accounts directly. Per-user, per-domain mailbox-kind grants live here.
   - Set the **Transactional email** from-address (must be on a verified Email Sending domain) so password reset and invite emails can go out.
4. In Cloudflare: enable **Email Routing** per zone, route catch-all → this Worker, and verify the zone under **Email Sending**.

### 6. Local dev

```bash
pnpm --filter @cfmail/db migrate:local
pnpm dev          # Vite (:5173) + Wrangler (:8787), Vite proxies /api
```

## Verification commands

```bash
pnpm typecheck    # tsgo across all packages
pnpm lint         # oxlint + biome check
pnpm test         # Vitest (worker pipelines)
pnpm build        # Vite + Wrangler dry-run
```

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branching, required checks, and how to run locally against a real Cloudflare account. TL;DR:

- Keep the toolchain (tsgo / Biome / oxlint / pnpm / Turborepo) — don't swap pieces without discussion.
- Run `pnpm typecheck && pnpm lint && pnpm build && pnpm test` before opening a PR.
- If you use Claude Code or similar AI tooling, read `CLAUDE.md` first — it captures the invariants that make the project safe to change.

## License

[MIT](./LICENSE)
