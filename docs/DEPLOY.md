# Deployment guide

The shape of deployment: clone, provision Cloudflare resources, deploy the Worker, bind a custom domain, open the URL, create the admin account in the browser. All env-specific config (URLs, domains, secrets) lives in D1 — there is nothing to edit in `wrangler.jsonc` beyond pointing the bindings at your D1/R2 IDs.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan. Email Sending requires it.
- A domain on Cloudflare (DNS managed by Cloudflare) for receiving mail.
- Node 22+ and `pnpm` 10+ locally.
- `wrangler` is provided via the workspace — invoke it with `pnpm --filter @cfmail/worker exec wrangler …`.

## 1. Install

```bash
git clone https://github.com/Newspicel/cloudflare-mail.git
cd cloudflare-mail
pnpm install
pnpm --filter @cfmail/worker exec wrangler login
```

## 2. Provision D1 and R2

```bash
pnpm --filter @cfmail/worker exec wrangler d1 create cfmail
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

That's the only `wrangler.jsonc` edit. There are no `vars` to set, no secrets to push.

## 3. Run migrations

```bash
# Production D1 (run once before first deploy, and every time the schema changes)
pnpm --filter @cfmail/db migrate

# Local D1 for dev
pnpm --filter @cfmail/db migrate:local
```

If you change `schema.ts` later, regenerate first:

```bash
pnpm db:generate
pnpm db:migrate
```

## 4. Deploy the Worker

```bash
pnpm --filter @cfmail/web build
pnpm --filter @cfmail/worker deploy
```

Wrangler reads `apps/worker/wrangler.jsonc` for bindings, the cron trigger, and the static-asset directory. The first deploy creates the Durable Object class `UserHub` per the `migrations` block.

## 5. Bind a custom domain to the Worker

In the Cloudflare dashboard: **Workers & Pages → cfmail → Settings → Domains & Routes → Add Custom Domain**.

Whatever hostname you bind here becomes your app URL automatically. The Worker derives its base URL from the incoming request `Host` header, so there is no `APP_URL` to set. CSRF / cookie scope follow the bound hostname.

## 6. First-run setup (in the app)

1. Open the custom-domain URL. With zero users in D1 the SPA shows a **Create administrator** form.
2. Submit it. You're now signed in as the admin.
3. From **Admin → Domains**:
   - Add each email domain you'll use (e.g. `example.com`, `tmp.example.com`).
   - Tick which mailbox kinds each domain accepts: `personal`, `group`, `service`, `temp`. A domain with no kinds ticked won't host any mailboxes; one with only `temp` ticked becomes a disposable-mailbox zone.
   - The SPF / DKIM / DMARC badges show DNS-health for each domain (re-run cron or hit *Recheck*).
4. Set the **Transactional email** from-address (e.g. `noreply@example.com`) on the same page. This must be on a verified Email Sending domain — it's used for password-reset and invite emails.
5. From **Admin → Users**:
   - Invite teammates by email (one-time link, 7-day TTL). Or create accounts directly with a password you share out-of-band.
   - Per user, per domain: tick which mailbox kinds that user may create. Admins bypass this check.

## 7. DNS records (per email domain)

Email Routing handles the MX records when you enable it on a zone. Add SPF/DMARC yourself; DKIM is auto-published when you verify the zone under Email Sending.

### MX (inbound, managed by Email Routing)

| Type | Name | Content                    | Priority |
| ---- | ---- | -------------------------- | -------- |
| MX   | `@`  | `route1.mx.cloudflare.net` | 13       |
| MX   | `@`  | `route2.mx.cloudflare.net` | 86       |
| MX   | `@`  | `route3.mx.cloudflare.net` | 24       |

### SPF

```
v=spf1 include:_spf.mx.cloudflare.net ~all
```

If you already send from another provider, merge their `include:` into the same record — never publish two `v=spf1` records.

### DKIM

A CNAME like `cf2024-1._domainkey.<zone>` → `cf2024-1._domainkey.cloudflare.net.` — auto-published by Email Sending verification.

### DMARC

```
v=DMARC1; p=quarantine; rua=mailto:postmaster@<zone>; ruf=mailto:postmaster@<zone>; fo=1
```

Start with `p=none` if you want to monitor first.

The admin page in the app shows live SPF/DKIM/DMARC status badges per domain. Use it to verify after DNS propagates.

## 8. Email Routing (inbound)

1. In Cloudflare: **Email → Email Routing** for the zone.
2. Click **Enable Email Routing**. Accept the MX records.
3. Under **Routes**, add a **catch-all** action **Send to a Worker** and pick `cfmail`. If the Worker isn't deployed yet, deploy first and come back.
4. Optional: individual address routes that bypass the Worker (e.g. forwarding `postmaster@` to a human inbox).

The Worker rejects unknown local-parts in `apps/worker/src/mail/receive.ts`, so a catch-all is safe — only addresses with a corresponding `mailbox` row in D1 accept mail.

## 9. Email Sending (outbound)

1. **Email → Email Sending → Domains**.
2. **Add domain**, pick the zone.
3. Cloudflare creates the DKIM CNAME and (if missing) prompts for SPF. Wait for verification (usually <5 min).
4. Once verified, the `EMAIL` binding can send `From:` addresses on that zone. Each mailbox uses its own domain's `From:`.

You can verify multiple sending domains; mailboxes pick their `From:` based on their attached domain.

## 10. Smoke test

1. Send mail from outside (e.g. Gmail) to an address that has a `mailbox` row. It should appear in the SPA within a few seconds via SSE.
2. Reply from the app. Confirm the message lands at the original sender and that the archived copy is visible under the thread.
3. Check the DNS-health badges in **Admin → Domains** — SPF, DKIM, DMARC should all be green.

## Recovery & troubleshooting

- **Lost admin password.** The admin account intentionally cannot use the self-service reset link (`sendResetPassword` no-ops for `role === "admin"`). Recover via either 2FA backup codes (if enrolled), or a direct password reset against D1:

  ```bash
  # Generate a new hash and replace the admin's account.password row.
  # See better-auth/crypto#hashPassword for the format used.
  pnpm --filter @cfmail/worker exec wrangler d1 execute cfmail --command \
    "UPDATE account SET password = '<new-hash>' WHERE user_id = (SELECT id FROM user WHERE role = 'admin')"
  ```

  Or wipe and re-bootstrap by deleting all users (`DELETE FROM user`) — the next visit will show the bootstrap form again.

- **Inbound bounces with "Address not found"** → no `mailbox` row for that local-part. Add it under **Admin → Mailboxes**.
- **Inbound bounces with "Domain not routed"** → no `domain` row. Add it under **Admin → Domains** first.
- **Outbound `EMAIL.send` fails with "from domain not verified"** → finish step 9 for that zone.
- **Password reset / invite email never arrives** → the transactional from-address isn't set, or it's not on a verified Email Sending domain. Set it under **Admin → Domains → Transactional email**.
- **`scheduled()` never runs locally** → cron doesn't fire under `wrangler dev`. Use `--test-scheduled` and POST `/__scheduled`.
- **Schema changes don't show up** → regenerate (`pnpm db:generate`) and re-apply (`pnpm db:migrate` for prod, `migrate:local` for dev).
