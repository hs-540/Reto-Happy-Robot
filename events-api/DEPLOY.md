# Estado del despliegue

**URL publica:** https://events-api.hs540events.workers.dev

| Recurso | Valor |
|---|---|
| Worker | `events-api` |
| D1 | `eventos` — id `f4ef295f-53b2-459a-8f3f-41347a5c8e03`, region WEUR |
| Subdominio | `hs540events.workers.dev` |
| Secret | `API_KEY` (subido; valor en `.api-key` local) |
| Token de despliegue | `.cf-token` — Workers:Edit, D1:Edit, Account:Read. **Caduca el 21/09/2026** |

## Redesplegar tras tocar el codigo

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler deploy
```

## Ver la API key

```bash
cat .api-key
```

## Rotar la API key

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
openssl rand -hex 32 > .api-key && cat .api-key | npx wrangler secret put API_KEY
```

Efecto inmediato, sin redeploy.

## Logs en vivo

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler tail
```

## Consultar la BBDD de produccion

```bash
export CLOUDFLARE_API_TOKEN=$(cat .cf-token)
npx wrangler d1 execute eventos --remote --command "SELECT type, status, created_at FROM events ORDER BY created_at DESC LIMIT 10"
```

## Al acabar la hackathon

Revoca el token en https://dash.cloudflare.com/profile/api-tokens (o dejalo caducar el 21).
