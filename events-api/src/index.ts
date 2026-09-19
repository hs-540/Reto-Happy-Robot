import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  API_KEY: string
}

type EventRow = {
  id: string
  summary: string
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

/* ------------------------------------------------------------ endpoints --- */

// Solo hay un tipo de evento: el resumen de una llamada de voz. Por eso no hay
// campo `type` ni `payload` — un evento es su resumen y poco mas.

app.get('/', (c) => c.json({ ok: true, service: 'events-api' }))

app.post('/api/post-event', async (c) => {
  const body = await c.req.json().catch(() => null)

  if (!body || typeof body.summary !== 'string' || !body.summary.trim()) {
    return c.json({ error: '`summary` es obligatorio y debe ser un string no vacio' }, 400)
  }

  const now = new Date().toISOString()
  const event: EventRow = {
    id: body.id ?? crypto.randomUUID(),
    summary: body.summary,
    created_at: now,
    updated_at: now,
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(event.id, event.summary, now, now)
    .run()

  return c.json(event, 201)
})

app.get('/api/get-events', async (c) => {
  const since = c.req.query('since')
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
  const offset = Number(c.req.query('offset') ?? 0) || 0

  const sql = `SELECT * FROM events
               ${since ? 'WHERE created_at >= ?' : ''}
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`

  const { results } = await c.env.DB.prepare(sql)
    .bind(...(since ? [since] : []), limit, offset)
    .all<EventRow>()

  return c.json({ count: results.length, events: results })
})

app.on(['POST', 'PATCH'], '/api/update-event', async (c) => {
  const body = await c.req.json().catch(() => null)
  const id = body?.id ?? c.req.query('id')

  if (!id) return c.json({ error: '`id` es obligatorio' }, 400)
  if (typeof body.summary !== 'string' || !body.summary.trim()) {
    return c.json({ error: '`summary` es obligatorio y debe ser un string no vacio' }, 400)
  }

  const row = await c.env.DB.prepare(
    `UPDATE events SET summary = ?, updated_at = ? WHERE id = ? RETURNING *`,
  )
    .bind(body.summary, new Date().toISOString(), id)
    .first<EventRow>()

  if (!row) return c.json({ error: 'evento no encontrado' }, 404)
  return c.json(row)
})

export default app
