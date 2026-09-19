# events-api

API de eventos sobre Cloudflare Workers + D1. Se despliega sola, no forma parte
del build del monorepo ni de sus workspaces.

**URL:** https://events-api.hs540events.workers.dev

Solo existe **un tipo de evento**: el resumen de una llamada de voz. Por eso un
evento no tiene ni `type` ni `payload` — es su `summary` y las marcas de tiempo.

## Primeros pasos tras clonar

```bash
cd events-api && npm install
cp .dev.vars.example .dev.vars   # key de desarrollo, cualquier valor vale
npm run db:local                 # crea la BBDD local
npm run dev                      # http://127.0.0.1:8787
```

Para desplegar o tocar produccion hace falta un API token de Cloudflare
(`./guardar-token.sh`) y la API key real: pidesela a Miguel, no esta en el repo.
Los ficheros `.api-key`, `.cf-token` y `.dev.vars` estan gitignoreados a
proposito — si los ves en un `git status`, algo va mal.

## La API key

Vive como **secret** del worker, no en el codigo ni en el repo. Se manda en cada
peticion a `/api/*`, en cualquiera de las dos formas:

```
x-api-key: <la-key>
Authorization: Bearer <la-key>
```

Sin ella o con una mala: `401 {"error":"unauthorized"}`. `GET /` queda abierto
como health check, util para comprobar que el deploy vive sin repartir la key.

## Forma de un evento

```json
{
  "id": "3ed7d553-a4f0-4fcd-8ac3-2eec740be0c5",
  "summary": "El transportista acepta la carga Madrid-Valencia a 420 EUR, recoge manana a las 8.",
  "created_at": "2026-09-19T11:45:13.289Z",
  "updated_at": "2026-09-19T11:45:13.289Z"
}
```

`summary` es el unico campo que mandas. `id` se genera solo si no lo pasas, y
las fechas son automaticas. Cualquier otra clave del body se ignora en silencio.

## Endpoints

| Metodo | Ruta | Body / query |
|---|---|---|
| POST | `/api/post-event` | `{ "summary": "..." }` — `id` opcional |
| GET | `/api/get-events` | `?since=<ISO>&limit=<n>&offset=<n>` |
| POST/PATCH | `/api/update-event` | `{ "id": "...", "summary": "..." }` |

`summary` tiene que ser un string no vacio: si falta, viene en blanco o no es
string, responde `400`. `limit` por defecto 50, tope 200. Los eventos salen
ordenados por `created_at` descendente, el mas reciente primero.

## Probar

```bash
API=https://events-api.hs540events.workers.dev
KEY=$(cat .api-key)

curl -X POST $API/api/post-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"summary":"El transportista acepta la carga, recoge manana a las 8."}'

curl "$API/api/get-events?limit=10" -H "x-api-key: $KEY"

curl -X POST $API/api/update-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"id":"<el-id>","summary":"Corregido: acepta a 390 EUR"}'
```

## En local

```bash
npm run db:local   # crea la BBDD local y aplica el esquema
npm run dev        # http://127.0.0.1:8787, key en .dev.vars
```

## Limites del plan gratis

100.000 peticiones/dia al worker, 5 GB de D1, 5M filas leidas/dia. Para una
hackathon no lo rozas.
