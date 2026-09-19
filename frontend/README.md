# @swarmup/frontend

The supervision surface: a live crisis map, the agent's reasoning as it happens,
and the levers a human operator still holds. React 19 + TypeScript + MapLibre GL,
built with Vite.

It owns no crisis state of its own. `severity`, `status`, `attention` and
priority are all computed by the backend (`docs/CONTRACT.md`, golden rule 4);
this app renders a snapshot and sends commands back.

## Running it

From the repo root, `npm run dev` starts backend and frontend together — that is
the normal way in. On its own:

```bash
npm run dev --workspace @swarmup/frontend   # http://localhost:5173
```

Vite proxies `/api` to `http://localhost:3001` (`vite.config.ts`), so the backend
has to be up or every poll fails.

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b` then a production bundle |
| `npm run typecheck` | Strict typecheck, no emit |
| `npm run lint` | Oxlint |

## How data arrives

One 500 ms loop in `hooks/useCrisis.ts` (`POLL_MS = 500`) polls `/api/state`,
`/api/agent`, `/api/feed?since=<seq>` and `/api/chat`; `/api/topology` is
fetched once on load and **refetched when the tick goes backwards**, which is how
the app notices that a reset drew a different crisis. The feed is accumulated as
a `seq`-keyed map (merge + dedup), so moving from polling to SSE would not touch
a component.

## The screen

| Component | What it shows |
| --- | --- |
| `MapView` | MapLibre GL over Getafe (Stadia raster tiles, light and dark). A marker per site coloured by status, units drawn in their own colour and moving along the street polyline the backend routes them on (`resources[].route`). |
| `CommandBar` | **Launch**, pause/resume, reset, inject, the run clock, and the narrative thread — key moments appear on the track only once they have fired. |
| `SitesPanel` | Every site with its status, sensors and repair countdown. |
| `ResourcesDock` | The fleet: what each unit is, where it is and what it is committed to. |
| `AgentPanel` | Four tabs — **stream** (the append-only feed), **decisions**, **actions**, and **chat**, the operator channel. |
| `InjectionModal` | Fires a sensor event into a live run; crossing a threshold triggers a full re-plan on the next tick. |
| `StartOverlay` | Crisis type and duration before the run starts — never what is about to happen. |
| `RunSummaryOverlay` | The end-of-run report from `GET /api/summary`: activity totals, incidents resolved vs open, LLM usage and mean reaction time. |

The chat tab is not a transcript viewer: an operator turn can re-prioritize a
site or order a unit, the orders pass the same hard rules that veto the agent's
own proposals, and a refused one comes back naming the rule. See the README at
the repo root, *Talking to the agent*.

## Conventions

- Theme lives in `hooks/useTheme.ts`; colours and the unit palette in
  `lib/palette.ts`, formatting helpers in `lib/format.ts`. Icons are inline SVG
  paths (`components/iconPaths.ts`), no icon dependency.
- Types come from `@swarmup/shared`. If a payload changes, `shared` changes
  first, then `docs/CONTRACT.md`, then this app.
