import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  API_KEY: string
}

type EventRow = {
  id: string
  summary: string
  mission_id: string | null
  context: string | null
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

/* ------------------------------------------------------------ helpers --- */

// Las columnas van en snake_case (convencion de SQLite) pero la API habla
// camelCase, que es como lo manda el cliente.
const toEvent = (row: EventRow) => ({
  id: row.id,
  summary: row.summary,
  missionId: row.mission_id,
  context: row.context,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

// `missionId` y `context` son opcionales: si no vienen se guardan null. Si
// vienen, tienen que ser un string no vacio.
function leerOpcional(valor: unknown): { ok: true; valor: string | null } | { ok: false } {
  if (valor === undefined || valor === null) return { ok: true, valor: null }
  if (typeof valor !== 'string' || !valor.trim()) return { ok: false }
  return { ok: true, valor }
}

/* ------------------------------------------------------------ endpoints --- */

// Solo hay un tipo de evento: el resumen de una llamada de voz. Por eso no hay
// campo `type` ni `payload` — un evento es su resumen, su mision y poco mas.

app.get('/', (c) => c.json({ ok: true, service: 'events-api' }))

app.post('/api/post-event', async (c) => {
  const body = await c.req.json().catch(() => null)

  if (!body || typeof body.summary !== 'string' || !body.summary.trim()) {
    return c.json({ error: '`summary` es obligatorio y debe ser un string no vacio' }, 400)
  }

  const mission = leerOpcional(body.missionId)
  if (!mission.ok) {
    return c.json({ error: '`missionId`, si viene, debe ser un string no vacio' }, 400)
  }

  const context = leerOpcional(body.context)
  if (!context.ok) {
    return c.json({ error: '`context`, si viene, debe ser un string no vacio' }, 400)
  }

  const now = new Date().toISOString()
  const event: EventRow = {
    id: body.id ?? crypto.randomUUID(),
    summary: body.summary,
    mission_id: mission.valor,
    context: context.valor,
    created_at: now,
    updated_at: now,
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, summary, mission_id, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.id, event.summary, event.mission_id, event.context, now, now)
    .run()

  return c.json(toEvent(event), 201)
})

app.get('/api/get-events', async (c) => {
  const since = c.req.query('since')
  const missionId = c.req.query('missionId')
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
  const offset = Number(c.req.query('offset') ?? 0) || 0

  const where: string[] = []
  const params: unknown[] = []
  if (since) { where.push('created_at >= ?'); params.push(since) }
  if (missionId) { where.push('mission_id = ?'); params.push(missionId) }

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

  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string' || !body.summary.trim()) {
      return c.json({ error: '`summary` debe ser un string no vacio' }, 400)
    }
    sets.push('summary = ?'); params.push(body.summary)
  }

  // Aqui null si vale: es como se vacia uno de los dos campos opcionales.
  for (const [campo, columna] of [['missionId', 'mission_id'], ['context', 'context']] as const) {
    const valor = body[campo]
    if (valor === undefined) continue
    if (valor !== null && (typeof valor !== 'string' || !valor.trim())) {
      return c.json({ error: `\`${campo}\` debe ser un string no vacio o null` }, 400)
    }
    sets.push(`${columna} = ?`); params.push(valor)
  }

  if (!sets.length) {
    return c.json({ error: 'nada que actualizar: manda summary, missionId y/o context' }, 400)
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
