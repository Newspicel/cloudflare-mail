# Deployment guide

This walks through deploying `cloudflare-mail` to your own Cloudflare account: DNS records, Email Routing, Email Sending domain verification, secrets, and the Worker itself.

The README has the high-level flow. This document is the long form: every step, in order, with copy-pasteable commands.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan. Email Sending requires it.
- A domain on Cloudflare (DNS managed by Cloudflare).
- Node 22+ and `pnpm` 10+ locally.
- `wrangler` is provided via the workspace — invoke it with `pnpm --filter @cfmail/worker exec wrangler …`.

## 1. Install and wire up the repo

```bash
git clone https://github.com/Newspicel/cloudflare-mail.git
cd cloudflare-mail
pnpm install
```

Authenticate Wrangler against your Cloudflare account:

```bash
pnpm --filter @cfmail/worker exec wrangler login
```

## 2. Provision D1 and R2

```bash
# D1
pnpm --filter @cfmail/worker exec wrangler d1 create cfmail

# R2
pnpm --filter @cfmail/worker exec wrangler r2 bucket create cfmail-blobs
```

Copy the `database_id` printed by the D1 command into `apps/worker/wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "cfmail",
    "database_id": "<paste-here>",
    "migrations_dir": "../../packages/db/drizzle"
  }
]
```

Update `vars.APP_URL` and `vars.TEMP_DOMAIN` in the same file to the hostnames you actually plan to use.

## 3. Run migrations

The schema lives in `packages/db/src/schema.ts`; SQL files are generated into `packages/db/drizzle/`.

```bash
# Local D1 (for `wrangler dev`)
pnpm --filter @cfmail/db migrate:local

# Production D1 (run once before first deploy, and every time the schema changes)
pnpm --filter @cfmail/db migrate
```

If you change `schema.ts` later, regenerate first:

```bash
pnpm db:generate
pnpm db:migrate
```

## 4. Secrets

Generate a Better Auth secret and store it as a Worker secret. `wrangler secret put` prompts for the value:

```bash
openssl rand -base64 32 | pbcopy   # or just copy the printed value
pnpm --filter @cfmail/worker exec wrangler secret put BETTER_AUTH_SECRET
```

For local dev, drop the same key into `apps/worker/.dev.vars` (gitignored):

```
BETTER_AUTH_SECRET=...
```

Never commit `.dev.vars` or paste a real secret into `wrangler.jsonc`.

## 5. DNS records

Set these on the domain you will send and receive on. All records are managed in the Cloudflare DNS dashboard for your zone.

### MX (inbound)

Email Routing manages these for you when you enable it (next step). You should see records like:

| Type | Name | Content                    | Priority |
| ---- | ---- | -------------------------- | -------- |
| MX   | `@`  | `route1.mx.cloudflare.net` | 13       |
| MX   | `@`  | `route2.mx.cloudflare.net` | 86       |
| MX   | `@`  | `route3.mx.cloudflare.net` | 24       |

Don't edit these by hand — toggle Email Routing on/off instead.

### SPF (outbound + inbound)

A single TXT record on the root (`@`) authorising Cloudflare to send and to forward:

```
v=spf1 include:_spf.mx.cloudflare.net ~all
```

If you already send from another provider, merge their `include:` directive into the same record — never publish two `v=spf1` records.

### DKIM (outbound)

Email Sending publishes the DKIM record for you when you verify a sending domain (step 7). Expect a CNAME like:

| Type  | Name                       | Content                                 |
| ----- | -------------------------- | --------------------------------------- |
| CNAME | `cf2024-1._domainkey.<zone>` | `cf2024-1._domainkey.cloudflare.net.` |

### DMARC (recommended)

Add a TXT record at `_dmarc`:

```
v=DMARC1; p=quarantine; rua=mailto:postmaster@<your-zone>; ruf=mailto:postmaster@<your-zone>; fo=1
```

Start with `p=none` if you want to monitor first, tighten to `quarantine` then `reject` once mail is flowing cleanly.

The admin page in the app shows live SPF/DKIM/DMARC status badges per domain — use it to verify after DNS propagates.

## 6. Email Routing (inbound)

1. In the Cloudflare dashboard: **Email → Email Routing** for the zone.
2. Click **Enable Email Routing**. Accept the MX records it offers.
3. Under **Routes**, add a **catch-all** action **Send to a Worker** and pick `cfmail` (the Worker name). If the Worker isn't deployed yet, do step 8 first and come back.
4. Optional: add individual address routes for special cases that should bypass the Worker (e.g. forwarding `postmaster@` to a human inbox).

The Worker rejects unknown local-parts in `apps/worker/src/mail/receive.ts`, so a catch-all route is safe — only addresses with a corresponding `mailbox` row in D1 will accept mail.

## 7. Email Sending (outbound)

1. In the dashboard: **Email → Email Sending → Domains**.
2. **Add domain**, pick the zone you'll send `From:` addresses on.
3. Cloudflare creates a DKIM CNAME and (if missing) prompts you to publish SPF. Both records go into the same zone you just selected. Wait for them to verify (usually <5 min).
4. Once the domain is **Verified**, the `EMAIL` binding in `wrangler.jsonc` (`"name": "EMAIL", "remote": true`) is good to go.

You can verify multiple sending domains; each mailbox in the app picks its `From:` from the domain attached to it.

## 8. Deploy the Worker

```bash
# Build the SPA (Worker serves it as static assets)
pnpm --filter @cfmail/web build

# Deploy
pnpm --filter @cfmail/worker deploy
```

Wrangler reads `apps/worker/wrangler.jsonc` for bindings, the cron trigger, and the static-asset directory. The first deploy creates the Durable Object class `UserHub` per the `migrations` block.

After deploying, go back to **Email Routing → Routes** and confirm the catch-all points to the now-deployed `cfmail` Worker.

## 9. First-run smoke test

1. Visit your `APP_URL` and sign up — the first account becomes the owner.
2. In **Admin**, add the verified sending domain.
3. Create a mailbox on that domain.
4. Send a message from outside (e.g. Gmail) to the new address. It should appear within seconds via SSE.
5. Reply from the app. Confirm the message lands at the original sender and that the archived copy is visible under the thread.
6. Check the **DNS health** badges on the admin page — SPF, DKIM, DMARC should all be green.

## Troubleshooting

- **Inbound bounces with "Address not found"** → the local-part has no `mailbox` row, or the domain has no `domain` row. Add them in Admin.
- **Inbound bounces with "Domain not routed"** → the `domain.name` in D1 doesn't match the zone Cloudflare forwarded from. Add the domain in Admin first.
- **Outbound `EMAIL.send` fails with "from domain not verified"** → finish step 7 for that specific zone. Each sending domain is verified independently.
- **`scheduled()` never runs locally** → cron triggers don't fire under `wrangler dev` by default. Use `pnpm --filter @cfmail/worker exec wrangler dev --test-scheduled` and POST to `/__scheduled`.
- **Schema changes don't show up** → regenerate (`pnpm db:generate`) and re-apply (`pnpm db:migrate` for prod, `migrate:local` for dev).
