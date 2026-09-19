# Deployment status

**Public URL:** https://events-api.hs540events.workers.dev

| Resource | Value |
|---|---|
| Worker | `events-api` |
| D1 | `eventos`, region WEUR (the id is in your local `wrangler.jsonc`) |
| Subdomain | `hs540events.workers.dev` |
| Secret | `API_KEY` (uploaded; the value is in the local `.api-key`) |
| Deploy token | `.cf-token` — Workers:Edit, D1:Edit, Account:Read. **Expires 2026-09-21** |

## Redeploy after changing the code

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler deploy
```

## Read the API key

```bash
cat .api-key
```

## Rotate the API key

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
openssl rand -hex 32 > .api-key && cat .api-key | npx wrangler secret put API_KEY
```

Takes effect immediately, no redeploy needed.

## Live logs

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler tail
```

## Query the production database

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler d1 execute eventos --remote --command "SELECT id, mission_id, summary, created_at FROM events ORDER BY created_at DESC LIMIT 10"
```

## Migrations

Run them in order against production; each one says whether it drops data.

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler d1 execute eventos --remote --file=./migrations/00X_name.sql
```

`schema.sql` is idempotent and safe to run against production; `reset-local.sql`
drops the table and is meant for local use only.

## When the hackathon is over

Revoke the token at https://dash.cloudflare.com/profile/api-tokens (or let it
expire on the 21st).
