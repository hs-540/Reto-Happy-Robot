import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  API_KEY: string
}

type EventRow = {
  id: string
  type: string
  payload: string
  status: string
  created_at: string
  updated_at: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

/* ---------------------------------------------------------------- auth --- */

// Comparamos hashes en vez de las claves en crudo: asi el tiempo de respuesta
// no depende de cuantos caracteres ha acertado quien lo intenta, y funciona
// aunque las dos cadenas midan distinto.
async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  return crypto.subtle.timingSafeEqual(ha, hb)
}

app.use('/api/*', async (c, next) => {
  const expected = c.env.API_KEY
  if (!expected) {
    return c.json({ error: 'API_KEY no configurada en el worker' }, 500)
  }

  const header = c.req.header('x-api-key')
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const provided = header ?? bearer

  if (!provided || !(await safeEqual(provided, expected))) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  await next()
})

/* ------------------------------------------------------------- payload --- */

// Campos reconocidos dentro de payload. Todos opcionales: cada tipo de evento
// usa los que le hagan falta. Cualquier otra clave se acepta y se guarda tal
// cual — esto valida los que conocemos, no cierra la puerta al resto.
const CAMPOS = {
  origin: 'string',
  dest: 'string',
  price: 'number',
  quantity: 'string',
} as const

function validarPayload(payload: unknown): { ok: true } | { ok: false; error: string } {
  if (payload === undefined || payload === null) return { ok: true }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '`payload` debe ser un objeto JSON' }
  }

  for (const [campo, tipo] of Object.entries(CAMPOS)) {
    const valor = (payload as Record<string, unknown>)[campo]
    if (valor === undefined || valor === null) continue // opcional

    if (tipo === 'string' && typeof valor !== 'string') {
      return { ok: false, error: `\`payload.${campo}\` debe ser string` }
    }
    if (tipo === 'number') {
      if (typeof valor !== 'number' || !Number.isFinite(valor)) {
        return { ok: false, error: `\`payload.${campo}\` debe ser un numero` }
      }
      if (valor < 0) {
        return { ok: false, error: `\`payload.${campo}\` no puede ser negativo` }
      }
    }
  }

  return { ok: true }
}

const toEvent = (row: EventRow) => ({
  id: row.id,
  type: row.type,
  payload: JSON.parse(row.payload),
  status: row.status,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

/* ------------------------------------------------------------ endpoints --- */

app.get('/', (c) => c.json({ ok: true, service: 'events-api' }))

app.post('/api/post-event', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.type !== 'string' || !body.type.trim()) {
    return c.json({ error: '`type` es obligatorio y debe ser string' }, 400)
  }

  const check = validarPayload(body.payload)
  if (!check.ok) return c.json({ error: check.error }, 400)

  const now = new Date().toISOString()
  const event = {
    id: body.id ?? crypto.randomUUID(),
    type: body.type,
    payload: JSON.stringify(body.payload ?? {}),
    status: body.status ?? 'new',
    created_at: now,
    updated_at: now,
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, type, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.id, event.type, event.payload, event.status, now, now)
    .run()

  return c.json(toEvent(event as EventRow), 201)
})

app.get('/api/get-events', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
  const offset = Number(q.offset ?? 0) || 0

  const where: string[] = []
  const params: unknown[] = []

  if (q.type) { where.push('type = ?'); params.push(q.type) }
  if (q.status) { where.push('status = ?'); params.push(q.status) }
  if (q.since) { where.push('created_at >= ?'); params.push(q.since) }

  // Filtros sobre los campos reconocidos de payload. json_extract lee dentro
  // del JSON guardado, asi que no hace falta duplicarlos en columnas.
  if (q.origin) { where.push("json_extract(payload, '$.origin') = ?"); params.push(q.origin) }
  if (q.dest) { where.push("json_extract(payload, '$.dest') = ?"); params.push(q.dest) }

  // price se guarda como numero y compara directo.
  //
  // quantity se guarda como string, asi que hay que castear o SQLite comparia
  // alfabeticamente ("9" > "12"). Ademas el GLOB deja fuera los valores que no
  // empiezan por digito: sin el, un "una docena" castea a 0 y se colaba en
  // cualquier filtro _max.
  const Q = "json_extract(payload, '$.quantity')"
  const cond = {
    price: (op: string) => `json_extract(payload, '$.price') ${op} ?`,
    quantity: (op: string) => `(${Q} GLOB '[0-9]*' AND CAST(${Q} AS REAL) ${op} ?)`,
  } as const

  for (const campo of ['price', 'quantity'] as const) {
    const min = q[`${campo}_min`]
    const max = q[`${campo}_max`]
    if (min !== undefined && min !== '') {
      where.push(cond[campo]('>=')); params.push(Number(min))
    }
    if (max !== undefined && max !== '') {
      where.push(cond[campo]('<=')); params.push(Number(max))
    }
  }

  const sql = `SELECT * FROM events
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`

  const { results } = await c.env.DB.prepare(sql)
    .bind(...params, limit, offset)
    .all<EventRow>()

  return c.json({ count: results.length, events: results.map(toEvent) })
})

app.on(['POST', 'PATCH'], '/api/update-event', async (c) => {
  const body = await c.req.json().catch(() => null)
  const id = body?.id ?? c.req.query('id')
  if (!id) return c.json({ error: '`id` es obligatorio' }, 400)

  const sets: string[] = []
  const params: unknown[] = []
  if (typeof body.type === 'string') { sets.push('type = ?'); params.push(body.type) }
  if (typeof body.status === 'string') { sets.push('status = ?'); params.push(body.status) }

  if (body.payload !== undefined) {
    const check = validarPayload(body.payload)
    if (!check.ok) return c.json({ error: check.error }, 400)

    if (body.merge === true) {
      // Fusiona con lo que ya habia: util para tocar solo price sin borrar
      // origin y dest. Sin `merge`, payload se reemplaza entero.
      sets.push(`payload = json_patch(payload, ?)`)
    } else {
      sets.push('payload = ?')
    }
    params.push(JSON.stringify(body.payload))
  }

  if (!sets.length) {
    return c.json({ error: 'nada que actualizar: manda type, status o payload' }, 400)
  }
  sets.push('updated_at = ?')
  params.push(new Date().toISOString())

  const row = await c.env.DB.prepare(
    `UPDATE events SET ${sets.join(', ')} WHERE id = ? RETURNING *`,
  )
    .bind(...params, id)
    .first<EventRow>()

  if (!row) return c.json({ error: 'evento no encontrado' }, 404)
  return c.json(toEvent(row))
})

export default app
