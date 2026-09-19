# SwarmUp

Autonomous AI agent managing a live crisis: a cascading blackout in the Community of Madrid. A hybrid decision engine (hard rules + LLM) triages the signals that matter, prioritizes with the remaining resources, deploys them on the ground and re-plans when the situation changes. Project for the HappyRobot challenge at HackSpain 2026 — *"Can AI manage a crisis?"*.

## Architecture

TypeScript monorepo (npm workspaces):

```
/backend   → Node server: REST API + decision engine + RAG
/frontend  → React + MapLibre GL app: crisis map, agent feed and manual control
/shared    → shared types, schemas and hard-rules catalog
/data      → event script (JSON) and RAG history pre-loaded per element type
/docs      → design, API contract and challenge documentation
```

### How the agent decides

Three layers per tick:

1. **Perception** (deterministic, ~1 ms) — filters the noise, derives `status` and `severity`, computes priority. It only wakes the LLM if something really changed: a threshold crossing, a missed ETA, an exceeded deadline or a manual injection. The remaining ticks cost no call.
2. **Deliberation** (LLM, 8-30 s) — receives the world, the rules catalog, the history of the affected site type and the plan in progress. Returns structured output: what it discards and why, objective, steps and decisions with their reasoning.
3. **Validation** (deterministic) — `validateAction` vetoes whatever violates the hard rules and hands the reason back to the model so it can fix it, up to two retries. Rejections are published in the feed.

If the LLM does not answer in time, the engine **degrades to the deterministic priority formula** and the simulation keeps running. The demo never freezes.

- **LLM**: a provider with an OpenAI-compatible interface ([Helmcode](https://helmcode.com), model `deepseek-v4-flash`). The provider is configuration, not code: it changes in the `.env`.
- **Learning**: RAG with local Chroma, started by the backend itself. The history is queried by element type and the agent cites the incidents that apply by their id.
- **Real actions**: ⚠️ pending. `contact` actions are decided, recorded and shown in the feed, but the integration with the HappyRobot API is not there yet.

## Requirements

- Node 24 (see `.nvmrc`)
- A Helmcode key (or one from any OpenAI-compatible provider)

## Getting started

```bash
npm install
cp .env.example .env   # fill in LLM_BASE_URL, LLM_API_KEY and LLM_MODEL
npm run dev
```

Then open **http://localhost:5173**. Three processes start:

| Port   | What                                                          |
| ------ | ------------------------------------------------------------- |
| `5173` | Frontend (Vite, proxies `/api` to the backend)                |
| `3001` | Backend: API, decision engine and simulation                  |
| `8000` | Chroma (RAG) — started by the backend, no need to touch it    |

If a Chroma is already listening on its port, it gets reused instead of starting another one.

## How to run the demo

Everything from the UI, no `curl`:

- **Start** the script — button in the header. It lasts 300 s with five key moments.
- **Pause / resume** — header.
- **Inject live events** — injection panel. Crossing a threshold triggers a full re-plan on the next tick.

The first deliberation **takes between 8 and 30 seconds**: alarms show up instantly in the feed and the agent's reasoning arrives later. It is not stuck, it is thinking.

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Backend and frontend in development mode |
| `npm run build`     | Build of the three workspaces            |
| `npm run typecheck` | Strict typecheck of the three workspaces |
| `npm run test`      | Tests of every workspace                 |
| `npm run lint`      | Lint of every workspace                  |

## API

| Endpoint        | Method | Description                                        |
| --------------- | ------ | -------------------------------------------------- |
| `/api/topology` | GET    | Affected elements and scenario resources           |
| `/api/state`    | GET    | Snapshot of the world: status, sensors, positions  |
| `/api/agent`    | GET    | Current plan, decisions and actions of the agent   |
| `/api/feed`     | GET    | Append-only log with `since` cursor                |
| `/api/control`  | POST   | Start, reset, pause, resume and inject             |
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
