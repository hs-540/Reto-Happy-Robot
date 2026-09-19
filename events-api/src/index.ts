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

// Compare hashes rather than the raw keys: response time then does not depend
// on how many characters the caller guessed right, and it works even when the
// two strings differ in length.
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
    return c.json({ error: 'API_KEY is not configured on the worker' }, 500)
  }

  const header = c.req.header('x-api-key')
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const provided = header ?? bearer

  if (!provided || !(await safeEqual(provided, expected))) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  await next()
})

/* ------------------------------------------------------------- helpers --- */

// Columns are snake_case (SQLite convention) but the API speaks camelCase,
// which is how clients send it.
const toEvent = (row: EventRow) => ({
  id: row.id,
  summary: row.summary,
  missionId: row.mission_id,
  context: row.context,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

// `missionId` and `context` are optional: absent means null. When present they
// must be a non-empty string.
function readOptional(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !value.trim()) return { ok: false }
  return { ok: true, value }
}

/* ----------------------------------------------------------- endpoints --- */

// There is a single kind of event: the summary of a voice call. Hence no
// `type` and no `payload` — an event is its summary, its mission and the
// prompt the call was launched with.

app.get('/', (c) => c.json({ ok: true, service: 'events-api' }))

app.post('/api/post-event', async (c) => {
  const body = await c.req.json().catch(() => null)

  if (!body || typeof body.summary !== 'string' || !body.summary.trim()) {
    return c.json({ error: '`summary` is required and must be a non-empty string' }, 400)
  }

  const mission = readOptional(body.missionId)
  if (!mission.ok) {
    return c.json({ error: '`missionId`, when present, must be a non-empty string' }, 400)
  }

  const context = readOptional(body.context)
  if (!context.ok) {
    return c.json({ error: '`context`, when present, must be a non-empty string' }, 400)
  }

  const now = new Date().toISOString()
  const event: EventRow = {
    id: body.id ?? crypto.randomUUID(),
    summary: body.summary,
    mission_id: mission.value,
    context: context.value,
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

  if (!id) return c.json({ error: '`id` is required' }, 400)

  const sets: string[] = []
  const params: unknown[] = []

  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string' || !body.summary.trim()) {
      return c.json({ error: '`summary` must be a non-empty string' }, 400)
    }
    sets.push('summary = ?'); params.push(body.summary)
  }

  // null is allowed here: that is how either optional field gets cleared.
  for (const [field, column] of [['missionId', 'mission_id'], ['context', 'context']] as const) {
    const value = body[field]
    if (value === undefined) continue
    if (value !== null && (typeof value !== 'string' || !value.trim())) {
      return c.json({ error: `\`${field}\` must be a non-empty string or null` }, 400)
    }
    sets.push(`${column} = ?`); params.push(value)
  }

  if (!sets.length) {
    return c.json({ error: 'nothing to update: send summary, missionId and/or context' }, 400)
  }

  sets.push('updated_at = ?')
  params.push(new Date().toISOString())

  const row = await c.env.DB.prepare(
    `UPDATE events SET ${sets.join(', ')} WHERE id = ? RETURNING *`,
  )
    .bind(...params, id)
    .first<EventRow>()

  if (!row) return c.json({ error: 'event not found' }, 404)
  return c.json(toEvent(row))
})

export default app
