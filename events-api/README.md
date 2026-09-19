# events-api

Events API on Cloudflare Workers + D1. It deploys on its own and is not part of
the monorepo build or its npm workspaces.

**URL:** https://events-api.hs540events.workers.dev

There is a single kind of event: the summary of a voice call. An event has
neither `type` nor `payload` — it is its summary, the mission it belongs to,
the prompt the call was launched with, and the timestamps.

## Getting started after cloning

```bash
cd events-api && npm install
cp .dev.vars.example .dev.vars   # development key, any value works
npm run db:local                 # create the local database
npm run dev                      # http://127.0.0.1:8787
```

Deploying or touching production needs a Cloudflare API token
(`./save-token.sh`) and the real API key: ask Miguel, neither is in the repo.
`.api-key`, `.cf-token` and `.dev.vars` are git-ignored on purpose — if you see
them in a `git status`, something is wrong.

## The API key

It lives as a worker **secret**, not in the code and not in the repo. Send it
with every request to `/api/*`, either way:

```
x-api-key: <the-key>
Authorization: Bearer <the-key>
```

Missing or wrong: `401 {"error":"unauthorized"}`. `GET /` is an open health
check, handy to confirm a deploy is live without handing out the key.

## Shape of an event

```json
{
  "id": "505becbc-2f4e-4a1b-9c3d-7e81f0a4b2d9",
  "summary": "The supplier offers four 1,000 kWh units, ready in 30 minutes.",
  "missionId": "MIS-20260919-PMI-6R8X",
  "context": "You are an autonomous emergency agent. You are calling a supplier...",
  "created_at": "2026-09-19T13:21:46.688Z",
  "updated_at": "2026-09-19T13:21:46.688Z"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `summary` | string | **Yes** | Non-empty |
| `missionId` | string \| null | No | Absent means `null` |
| `context` | string \| null | No | The hook's input prompt. Absent means `null` |
| `id` | string | No | A UUID is generated when omitted |

Timestamps are automatic. Any other key in the body is silently ignored.

In the database the columns are `mission_id` and `context`; the API speaks
`missionId`, which is how clients send it.

`context` is stored verbatim with no practical length limit and is
**deliberately unindexed**: it is long free text, so filtering on it by exact
match would be pointless.

## Endpoints

| Method | Path | Body / query |
|---|---|---|
| POST | `/api/post-event` | `{ "summary": "...", "missionId": "...", "context": "..." }` — only `summary` is required |
| GET | `/api/get-events` | `?missionId=<id>&since=<ISO>&limit=<n>&offset=<n>` |
| POST/PATCH | `/api/update-event` | `{ "id": "...", "summary": "...", "missionId": "...", "context": "..." }` |

`summary` must be a non-empty string: missing, blank or not a string answers
`400`. `missionId` and `context`, when present, must also be non-empty strings.
`limit` defaults to 50 and caps at 200. Events come back ordered by
`created_at` descending, newest first.

On `update-event` send `summary`, `missionId`, `context` or any combination —
what you leave out stays as it was, and at least one is required. To clear
either optional field, send it as `null`.

Every event of one mission:

```
GET /api/get-events?missionId=MIS-20260919-PMI-6R8X
```

### Known gap

Posting an `id` that already exists answers `500` in plain text rather than a
`409`: the insert hits the primary key and the error is not caught. It only
happens when you supply your own ids; generated UUIDs never collide.

## Trying it

```bash
API=https://events-api.hs540events.workers.dev
KEY=$(cat .api-key)

curl -X POST $API/api/post-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"summary":"The supplier confirms delivery.","missionId":"MIS-001","context":"You are an emergency agent..."}'

curl "$API/api/get-events?limit=10" -H "x-api-key: $KEY"

curl -X POST $API/api/update-event -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"id":"<the-id>","summary":"Corrected summary"}'
```

## Free-plan limits

100,000 worker requests/day, 5 GB of D1, 5M rows read/day. A hackathon does not
get close.
