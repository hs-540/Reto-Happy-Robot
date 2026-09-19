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
2. **Deliberation** (LLM, 8-20 s measured) — receives the world, the rules catalog, the topology and remedies, the history of the affected site types, the untriaged reports and the plan in progress. Returns structured output: what it discards and why, objective, steps, communications and decisions with their reasoning. Each attempt is capped at 45 s and the whole deliberation at 75 s.
3. **Validation** (deterministic) — `validateAction` vetoes whatever violates the hard rules and hands the reason back to the model so it can fix it, with **one** retry (a second one ate the whole budget precisely when the agent was correcting itself). Rejections are published in the feed; whatever is still illegal after the retry is dropped and the rest of the plan goes ahead.

If the LLM does not answer in time, the engine **degrades to the deterministic priority formula** and the simulation keeps running. The demo never freezes.

- **LLM**: a provider with an OpenAI-compatible interface ([Helmcode](https://helmcode.com), model `deepseek-v4-flash`). The provider is configuration, not code: it changes in the `.env`. `createLlmClient` takes a list of gateways and fails over between them; `config.ts` currently builds exactly one, so today there is nothing to fail over to.
- **Real actions**: **built and wired end to end, running simulated for want of a credential.** `backend/src/happyrobot.ts` has a real client that `POST`s to `{HAPPYROBOT_BASE_URL}/api/v1/dial/outbound` with a Bearer key, the agent calls it for every communication it decides (`execute()` in `agent.ts`), and the return path is live: HappyRobot posts the hang-up to `POST /api/call/outcome`, the backend validates it and hands it to `agent.closeCall()`, where a refusal or a delay becomes a replanning trigger. What is missing is only `HAPPYROBOT_API_KEY`: without a usable one, `createHappyRobotClient()` picks the simulated client, which exercises that exact same chain with scripted answers. Setting the key switches to real phone calls with no code change.
- **Learning**: partly built. Local Chroma is started by the backend; `npm run rag:preload` vectorizes `data/history/<type>/` into a collection per element type, and every resolved incident is written back with `recordClosure()`. **Retrieval is not wired yet**: `HistoryRag.search()` exists in `backend/src/rag/history.ts` but nothing calls it, so what the agent actually receives each turn is the static JSON history filtered by the affected element types (`agent.ts`, `MAX_HISTORY_PER_TURN = 3`). The agent does cite the incidents it used by id (`historyCitation`); the selection is just not a vector search yet.

## Requirements

- Node 24 (see `.nvmrc`)
- A Helmcode key (or one from any OpenAI-compatible provider)

## Getting started

```bash
npm install
cp .env.example .env   # fill in LLM_BASE_URL, LLM_API_KEY, LLM_MODEL and HAPPYROBOT_API_KEY
npm run dev
```

Every variable in `.env.example` without a default must be set or the backend
exits on startup — `HAPPYROBOT_API_KEY` included, and an empty string counts as
missing. With no real HappyRobot credential, set it to the placeholder token
`credentialUsable()` recognises (`backend/src/happyrobot.ts`); communications
then run simulated and everything else behaves identically.

Then open **http://localhost:5173**. Three processes start:

| Port   | What                                                          |
| ------ | ------------------------------------------------------------- |
| `5173` | Frontend (Vite, proxies `/api` to the backend)                |
| `3001` | Backend: API, decision engine and simulation                  |
| `8000` | Chroma (RAG) — started by the backend, no need to touch it    |

If a Chroma is already listening on its port, it gets reused instead of starting another one.

## How to run the demo

Everything from the UI, no `curl`:

- **Start** the script — button in the header. It runs for 1800 s (30 min) of simulated clock: 54 scripted entries (18 sensor events, 35 citizen/press/field reports and 1 narrative event), of which five are the key moments — blackout at the substation (0 s), datacenter overheating (240 s), tower batteries draining (450 s), hospital loses its generator (540 s) and the crew missing its ETA (900 s). A demo run does not need all 30 minutes: the five moments are over by 900 s.
- **Pause / resume** — header.
- **Inject live events** — injection panel. Crossing a threshold triggers a full re-plan on the next tick.

`reset` exists in the API but has no button yet: the UI only wires start, pause
and resume.

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
| `/api/call/outcome` | POST | HappyRobot webhook: outcome of a call on hang-up |
| `/api/health`   | GET    | Backend healthcheck                                |

Full detail in [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Configuration

All variables go in `.env` (repo root, outside git). See [`.env.example`](.env.example): port, tick cadence, LLM provider (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`), HappyRobot key and Chroma settings.

The backend validates the `.env` on startup and does not start if something is missing, stating which variable failed without showing its value.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and design decisions
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — API and data contract
- [`docs/RULES.md`](docs/RULES.md) — hard rules catalog: thresholds, priority and blocking rules
- [`docs/Happy Robot Challenge Guide.md`](docs/Happy%20Robot%20Challenge%20Guide.md) — original challenge statement
- [`docs/Happy Robot Challenge Evaluation Checklist.md`](docs/Happy%20Robot%20Challenge%20Evaluation%20Checklist.md) — evaluation criteria

## CI

GitHub Actions runs `npm ci`, typecheck, build and lint on every push to `main` and on every PR (`.github/workflows/ci.yml`).
