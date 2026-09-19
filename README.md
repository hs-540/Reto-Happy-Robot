# SwarmUp

Autonomous AI agent managing a live crisis: a cascading blackout in the Community of Madrid. A hybrid decision engine (hard rules + LLM) triages the signals that matter, prioritizes with the remaining resources, deploys them on the ground and re-plans when the situation changes. Project for the HappyRobot challenge at HackSpain 2026 — *"Can AI manage a crisis?"*.

## Architecture

TypeScript monorepo (npm workspaces):

```
/backend   → Node server: REST API + decision engine + RAG
/frontend  → React + MapLibre GL app: crisis map, agent feed and manual control
/shared    → shared types, schemas and hard-rules catalog
/data      → event script, scenario topology, remedies and RAG history
/docs      → design, API contract and challenge documentation
```

The scenario's facts live in `data/` as JSON, not in code: `topology.json` (what
depends on what) and `remedies.json` (what fixes what, at what cost, and who to
call). See [`data/README.md`](data/README.md).

### How the agent decides

Three layers per tick:

1. **Perception** (deterministic, ~1 ms) — filters the noise, derives `status` and `severity`, computes priority. It only wakes the LLM if something really changed: a threshold crossing, a missed ETA, an exceeded deadline, a signal from an emergency call or a field team, a backlog of eight low-signal reports, a call that came back refused or delayed, or a manual injection. The remaining ticks cost no call.
2. **Deliberation** (LLM, 8-20 s measured) — receives the world, the rules catalog, the topology and remedies, the history of the affected site types, the untriaged reports and the plan in progress. Returns structured output: what it discards and why, objective, steps, communications and decisions with their reasoning. Each attempt is capped by the gateway timeout (`ATTEMPT_TIMEOUT_MS`, 90 s) and the whole deliberation by a budget derived from the run's own clock — `max(attempt + 5 s, staleness ceiling)`, where the ceiling is the hospital's 8-minute limit converted at `TIME_SCALE`, so the budget can never drift past the deadline the answer is about.
3. **Validation** (deterministic) — `validateAction` vetoes whatever violates the hard rules and hands the reason back to the model so it can fix it, with **one** retry (a second one ate the whole budget precisely when the agent was correcting itself). Rejections are published in the feed; whatever is still illegal after the retry is dropped and the rest of the plan goes ahead.

If the LLM does not answer in time, the engine **degrades to the contingency playbook** (`decideByRules`): the same priority ranking the model is given, a coverage check that pairs uncovered sites with the remedy declared for their type, and an escalation to the responsible contact when no legal move exists. The hard rules still apply. The simulation keeps running — the demo never freezes.

- **LLM**: a provider with an OpenAI-compatible interface ([Helmcode](https://helmcode.com), model `deepseek-v4-flash`). The provider is configuration, not code: it changes in the `.env`. `createLlmClient` takes a list of gateways and fails over between them; `config.ts` currently builds exactly one, so today there is nothing to fail over to.
- **Real actions**: built and wired end to end, behind an explicit switch. `backend/src/happyrobot.ts` has a real client that `POST`s `{ "prompt": ..., "missionId": ..., "contact": ... }` to the HappyRobot mission hook (`HAPPYROBOT_WEBHOOK_URL`, with the hook's key as `x-api-key` when it is guarded), where `missionId` is the id of the action the agent decided — a call is traceable end to end — and `contact` is the one the call queue assigned from the pool. No phone number travels: the mission resolves the contact it is given into someone to ring. The return path is the events API: when the voice agent hangs up, the hook posts a call-summary event to the worker and `backend/src/outcome-poll.ts` polls it (`EVENTS_POLL_MS`, default 10 s), matches each summary by mission and hands it to `agent.closeCall()`, where a refusal or a delay becomes a replanning trigger. **Real telephony is off by default**: `HAPPYROBOT_REAL_CALLS_ENABLED` is checked before anything else, so no leftover hook URL in an `.env` can make somebody's phone ring. With the switch off, or with an empty `CONTACTS` pool, `createHappyRobotClient()` picks the simulated client, which exercises that exact same chain with scripted answers.
- **Call queue and balancer**: real phone capacity is the list of people who can be reached, not eight simultaneous calls. `backend/src/call-queue.ts` wraps the HappyRobot client and balances over the contact pool (`CONTACTS`): one live call per contact, assigned round-robin so the load spreads instead of piling on the first. With every contact busy the rest wait in a bounded queue (`HAPPYROBOT_MAX_QUEUED_CALLS`, default `3`) ordered by the urgency of the target site, and a call that is stale by the time a contact frees is discarded. Shrinking the pool narrows the whole system, and a single contact serialises it: nothing else goes out until that call is answered. A contact held with no closure for `HAPPYROBOT_CALL_SLOT_TIMEOUT_MS` (default `240000` — it has to clear the whole real round trip: call, summary, poll cadence and the classification of the summary) is released and the call closes as `no_answer`, so a lost webhook cannot retire it from the pool. Chat messages pass straight through: they take no contact. Once the run is over the queue is closed: nothing is dialled after the end of the script — not a fresh call, not one that was waiting for a contact, on either channel — so a deliberation still in flight when the clock froze cannot ring anybody about a crisis that is over. A reset opens the phones again on the new crisis.
- **Learning**: built. Local Chroma is started by the backend and seeded at boot; `npm run rag:preload` vectorizes `data/history/<type>/` into a collection per element type, and every resolved incident is written back with `recordClosure()`. Retrieval is wired into every deliberation: `tryRetrieveHistory()` (`agent.ts`) calls `rag.search()` per affected element type behind a 6 s timeout, falling back to the static JSON history (`MAX_HISTORY_PER_TURN = 3`) if the search fails or times out. Retrieved incidents reach the prompt with a "Retrieved because..." line and the agent cites the incidents it used by id (`historyCitation`). Documents are tagged `source: curated | closure` and retrieval reserves half the per-turn budget for the curated lessons, so the write-backs of earlier runs cannot crowd out the actionable outcomes. `backend/chroma-data` is kept across runs on purpose; delete it (`rm -rf backend/chroma-data`) before a clean demo — boot re-seeds the curated history.

## Requirements

- Node 24 (see `.nvmrc`)
- A Helmcode key (or one from any OpenAI-compatible provider)

## Getting started

```bash
npm install
cp .env.example .env   # fill in LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run dev
```

Every variable in `.env.example` without a default must be set or the backend
exits on startup, and an empty string counts as missing. Only the LLM provider
is required: with `HAPPYROBOT_REAL_CALLS_ENABLED=false` (the default)
communications run simulated and everything else behaves identically. Placing
real calls takes four variables together — the switch set to `true`,
`HAPPYROBOT_WEBHOOK_URL` pointing at the mission hook, `CONTACTS` listing who
can be reached, and `EVENTS_API_KEY` so the closures can be polled back.

Then open **http://localhost:5173**. Three processes start:

| Port   | What                                                          |
| ------ | ------------------------------------------------------------- |
| `5173` | Frontend (Vite, proxies `/api` to the backend)                |
| `3001` | Backend: API, decision engine and simulation                  |
| `8000` | Chroma (RAG) — started by the backend, no need to touch it    |

If a Chroma is already listening on its port, it gets reused instead of starting another one.

## How to run the demo

Everything from the UI, no `curl`:

- **Launch** the run — button in the command bar. Each run draws a random crisis from a seed (`backend/src/scenario.ts`): ~50 of the 100 catalog sites, and a fleet sized to be tight against them (~12-23 of the 90 resources, demand at 110-140% of capacity, always at least one unit fewer than the drawn sites, so prioritizing is never optional) — and ~250-300 timeline entries spaced across the two-hour window, most of them noise the agent must triage. The clock runs for 7200 s (2 h) of simulated time; a demo run does not need all of it.
- **Pause / resume** — command bar.
- **Inject live events** — injection panel. Crossing a threshold triggers a full re-plan on the next tick.
- **How fast the clock runs** is `TIME_SCALE` (crisis seconds per real second). The default `15` compresses the 30 crisis-minutes into ~2 real minutes; a live demo usually wants `6`, so a deliberation (8-20 s) does not outrun the crisis it is answering.
- **When the script plays out**, the run finishes on an end-of-run report: activity totals, incidents resolved vs still open, LLM calls, latency and tokens, and the mean trigger-to-decision reaction time (`GET /api/summary`).

### Talking to the agent

The **Chat** tab of the agent panel is a direct channel to it: ask what it is
doing and why, change a priority ("the hospital on Calle de Atocha comes
first"), or order a unit somewhere ("send generator-2 to sub-01"). The turn is
read by the LLM, which returns a reply plus the orders it understood.

Those orders are **real and bounded**:

- `prioritize` / `deprioritize` shift the site in `World.priorities`, the single
  ranking the prompt, the contingency playbook, the idle-resource pairing and
  the call queue all read — so nothing downstream can disagree about what comes
  first. They **stand**: every later deliberation sees them, until a reset.
- `assign` / `release` move the fleet through the same `world.assign` /
  `world.release` the agent uses, after passing `validateAction` — the same hard
  rules that veto the model's own proposals. A refused order comes back naming
  the rule that refused it (`✕ Not done — [no-double-assignment] …`) and moves
  nothing. The operator is a human in the loop, not an exception to the rules.
- `note` commits nothing; it adds context the agent carries into its next
  deliberations ("the ICU is already on a private generator").

Orders are validated against the world as it is when they execute, not the
snapshot the model read while thinking, and every turn — and every accepted
order — is published to the feed, so a human intervention is readable back in
the log the run is judged on. The reply costs a model call: `POST /api/chat`
returns as soon as the turn is accepted and the answer arrives through the
normal poll.

`reset` draws a **new** scenario — a fresh seed, a different map, a different
fleet — it does not rewind the current one. The CommandBar wires start, pause,
resume and reset.

The first deliberation **takes between 8 and 20 seconds** (measured against `deepseek-v4-flash` with the real prompt): alarms show up instantly in the feed and the agent's reasoning arrives later. It is not stuck, it is thinking.

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Backend and frontend in development mode |
| `npm run build`     | Build of the three workspaces            |
| `npm run typecheck` | Strict typecheck of the three workspaces |
| `npm run test`      | Tests of every workspace                 |
| `npm run lint`      | Lint of every workspace                  |
| `npm run rag:preload` | Vectorizes `data/history/` into Chroma (idempotent) |

## API

| Endpoint        | Method | Description                                        |
| --------------- | ------ | -------------------------------------------------- |
| `/api/topology` | GET    | Affected elements and scenario resources           |
| `/api/state`    | GET    | Snapshot of the world: status, sensors, positions  |
| `/api/agent`    | GET    | Current plan, decisions and actions of the agent   |
| `/api/feed`     | GET    | Append-only log with `since` cursor                |
| `/api/control`  | POST   | Start, reset, pause, resume and inject             |
| `/api/chat`     | GET    | Operator channel: conversation and standing orders |
| `/api/chat`     | POST   | Sends an operator turn to the agent                |
| `/api/call/outcome` | POST | HappyRobot webhook: outcome of a call on hang-up |
| `/api/health`   | GET    | Backend healthcheck                                |
| `/api/summary`  | GET    | End-of-run report: totals, LLM usage, reaction time |

Full detail in [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Configuration

All variables go in `.env` (repo root, outside git). See [`.env.example`](.env.example): port, tick cadence and time scale, LLM provider (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`), the real-telephony switch (`HAPPYROBOT_REAL_CALLS_ENABLED`) with the mission hook, the contact pool (`CONTACTS`) and the call queue behind it, the events API that closes real calls, and Chroma settings.

The backend validates the `.env` on startup and does not start if something is missing, stating which variable failed without showing its value.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and design decisions
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — API and data contract
- [`docs/RULES.md`](docs/RULES.md) — hard rules catalog: thresholds, priority and blocking rules
- [`docs/SCENARIO-GENERATION.md`](docs/SCENARIO-GENERATION.md) — how each run draws its own crisis
- [`data/README.md`](data/README.md) — the scenario's facts: topology, remedies, roads and RAG history
- [`events-api/README.md`](events-api/README.md) — the Cloudflare worker that receives call summaries
- [`docs/Happy Robot Challenge Guide.md`](docs/Happy%20Robot%20Challenge%20Guide.md) — original challenge statement
- [`docs/Happy Robot Challenge Evaluation Checklist.md`](docs/Happy%20Robot%20Challenge%20Evaluation%20Checklist.md) — evaluation criteria

## CI

GitHub Actions runs `npm ci`, typecheck, build and lint on every push to `main` and on every PR (`.github/workflows/ci.yml`).
