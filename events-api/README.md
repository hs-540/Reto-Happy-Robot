# events-api

API de eventos sobre Cloudflare Workers + D1. Se despliega sola, no forma parte
del build del monorepo ni de sus workspaces.

**URL:** https://events-api.hs540events.workers.dev

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

## Desplegar (5 min, sin tarjeta)

```bash
npx wrangler login                    # abre el navegador
npx wrangler d1 create eventos        # copia el database_id que devuelve
```

Pega ese uuid en `wrangler.jsonc` (campo `database_id`, ahora pone `PENDIENTE`).

```bash
npx wrangler d1 execute eventos --remote --file=./schema.sql
openssl rand -hex 32 | npx wrangler secret put API_KEY   # guardatela, no se vuelve a ver
npx wrangler deploy
```

Te queda `https://events-api.hs540events.workers.dev`.

## La API key

Vive como **secret** del worker, no en el codigo ni en el repo. En local la lee de
`.dev.vars` (gitignoreado); en produccion de lo que guardaste con `wrangler secret put`.

Se manda en cada peticion a `/api/*`, en cualquiera de las dos formas:

```
x-api-key: <la-key>
Authorization: Bearer <la-key>
```

Sin ella o con una mala: `401 {"error":"unauthorized"}`. `GET /` queda abierto como
health check, util para comprobar que el deploy vive sin repartir la key.

## Forma de un evento

```json
{
  "id": "d1e1b444-a4c9-4da7-9d8a-e88addaef1df",
  "type": "load.created",
  "payload": { "origin": "Madrid", "dest": "Valencia", "price": 420, "quantity": "3" },
  "status": "new",
  "created_at": "2026-09-19T10:16:51.601Z",
  "updated_at": "2026-09-19T10:16:51.601Z"
}
```

`type` es el unico campo obligatorio. `id` se genera solo si no lo mandas,
`status` arranca en `new` y las fechas son automaticas.

### Campos reconocidos de payload

Los cuatro son **opcionales**: cada tipo de evento usa los que necesite. Si
vienen, se validan; si no, no pasa nada.

| Campo | Tipo | Regla |
|---|---|---|
| `origin` | string | — |
| `dest` | string | — |
| `price` | number | no negativo |
| `quantity` | **string** | cualquier texto |

Cualquier otra clave se acepta y se guarda tal cual: `payload` sigue siendo
JSON libre, esto solo valida los cuatro que conocemos. Un tipo de evento puede
traer `{"quantity": "12"}` y otro `{"outcome": "booked", "agent": "ana"}`.

Si un campo no cuadra, `400` diciendo cual:

```json
{"error": "`payload.price` debe ser un numero"}
```

## Endpoints

| Metodo | Ruta | Que hace |
|---|---|---|
| POST | `/api/post-event` | Crea. Body: `type` (obligatorio), `payload`, `status`, `id` opcionales |
| GET | `/api/get-events` | Lista y filtra (ver abajo) |
| POST/PATCH | `/api/update-event` | Actualiza por `id`. Cambia `type`, `status` y/o `payload` |

### Filtros de get-events

| Parametro | Ejemplo |
|---|---|
| `type` | `?type=load.created` |
| `status` | `?status=new` |
| `since` | `?since=2026-09-19T00:00:00Z` |
| `origin` | `?origin=Madrid` |
| `dest` | `?dest=Valencia` |
| `price_min` / `price_max` | `?price_min=100&price_max=500` |
| `quantity_min` / `quantity_max` | `?quantity_min=10` (ver nota) |
| `limit` / `offset` | `?limit=20&offset=40` (limit tope 200) |

Se combinan con AND: `?dest=Valencia&price_max=500&status=new`.

Los cuatro campos de payload tienen indice, asi que filtrar por ellos no
escanea la tabla entera.

**Nota sobre quantity.** Se guarda como string, asi que los filtros de rango
lo castean a numero antes de comparar — si no, SQLite ordenaria alfabeticamente
y "9" saldria mayor que "12". Un quantity que no empiece por digito (por
ejemplo `"una docena"`) se guarda sin problema y se lee con normalidad, pero
queda fuera de `quantity_min` / `quantity_max`: no hay forma sensata de
ordenarlo. Si vas a filtrar por cantidad, manda el numero escrito como texto:
`"12"`, no `"doce"`.

### Actualizar payload: reemplazar o fusionar

Por defecto `payload` se **reemplaza entero**:

```bash
-d '{"id":"...","payload":{"price":650}}'
# resultado: {"price":650}  <- origin, dest y quantity desaparecen
```

Con `"merge": true` se **fusiona** con lo que ya habia:

```bash
-d '{"id":"...","merge":true,"payload":{"price":650}}'
# resultado: {"origin":"Sevilla","dest":"Bilbao","price":650,"quantity":"2"}
```

Para tocar un solo campo, usa `merge`.

## Probar

```bash
API=https://events-api.hs540events.workers.dev
KEY=$(cat .api-key)

curl -X POST $API/api/post-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"type":"load.created","payload":{"origin":"Madrid","dest":"Valencia"}}'

curl "$API/api/get-events?type=load.created&limit=10" -H "x-api-key: $KEY"

curl -X POST $API/api/update-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"id":"<el-id>","status":"processed"}'
```

## En local

```bash
npm run db:local   # crea la BBDD local y aplica el esquema
npm run dev        # http://127.0.0.1:8787, key en .dev.vars
```

## Limites del plan gratis

100.000 peticiones/dia al worker, 5 GB de D1, 5M filas leidas/dia. Para una
hackathon no lo rozas.
