# /data

Everything the scenario *is*, as JSON. These files describe **facts** — what
happened, what depends on what, what fixes what. They never contain priorities
or orders: put a judgement in here and the decision engine quietly moves into
the JSON, leaving the agent decorative.

| File | What it is | Loaded by |
| --- | --- | --- |
| `scripts/madrid-blackout.json` | The timed event script | `loadScript` (`backend/src/script.ts`) |
| `topology.json` | Dependency graph of the scenario | `loadTopology` (`shared/src/loaders.ts`) |
| `remedies.json` | What fixes what, and who to call | `loadRemedies` |
| `history/<type>/incidents.json` | Past incidents for the RAG | `loadHistory` |

## `topology.json` — what depends on what

A flat list of `edges` (`from`, `to`, `type`, `note`). `to` may be `"*"` when the
edge affects the whole scenario. This graph is what turns a set of failing sites
into an actual problem: without it, six incidents are six independent chores.

| Edge type | Meaning | Enforced by |
| --- | --- | --- |
| `supplies` | The source feeds grid power to the target | `world.ts` — repairing a node emits a `remedy_applied` for **every** dependent (`dependentsOf`) |
| `enables_comms` | While the source stands, calls and messages can go out | Prompt only (see below) |
| `enables_transit` | While the source is regulated, journeys take their normal time | `world.ts` — `trafficPenalised()` doubles every ETA while congestion is high and no police unit is assigned |
| `refuels` | The source is where the target replenishes its load | Prompt only |

What the current graph says, and why each edge earns its place:

- **`sub-01` supplies `hosp-01`, `dc-01`, `tower-01`, `fuel-01`, `junction-01`.**
  This is the whole shape of the scenario. Repairing the substation takes 18
  minutes and restores **five** dependents at once, while a generator takes 5
  minutes and saves one. The agent has to decide between the slow fix with the
  widest coverage and the fast patch it can afford right now — and the hospital
  clock (8 minutes) is shorter than the repair.
- **`tower-01` enables_comms `*`.** The tower runs on its own batteries while the
  grid is down. If it dies, the coordinator loses every channel to every person:
  the agent's only lever over humans is gone. That is why `tower` weighs almost
  as much as `substation` in the priority order (`docs/RULES.md` §5).
- **`junction-01` enables_transit `*`.** Traffic lights out and nobody directing:
  every journey takes twice as long. Sending the police unit there saves nobody
  directly and makes every other resource arrive on time.
- **`fuel-01` refuels `tanker-1`.** The pumps are electric. With the station
  down, once the tanker runs dry it can no longer refuel generators.

`enables_comms` and `refuels` are **not simulated**: `world.ts` does not cut
communications when the tower falls, and does not empty the tanker. Both edges
are rendered into the agent's prompt (`topologyLine` in `backend/src/prompt.ts`)
as facts it must reason about, and the tower has its own `tower_battery`
thresholds, but the consequence is narrative rather than mechanical. `supplies`
and `enables_transit` are the two the world actually applies.

## `remedies.json` — what fixes what, and who to call

Two lists.

**`remedies`**: one entry per (resource type → problem) pair, with
`appliesTo` (site types), `minutes` (how long it takes to take hold after
arrival), `effect`, `requires` (precondition without which it is useless) and a
`$note` explaining the trade-off.

| Resource | Solves | Minutes | Requires | The trade-off |
| --- | --- | --- | --- | --- |
| `crew` | `grid_failure` on `substation` | 18 | — | Slowest, highest coverage: the only action that returns the grid to every dependent at once. A generator is no substitute — a substation is repaired, not powered. |
| `generator` | `power_loss` on `hospital`/`datacenter`/`tower` | 5 | `fuel` | Fast, local, and does not fix the cause. Buys time. Occupies the resource while connected. |
| `tanker` | `low_fuel` on `hospital`/`datacenter`/`tower`/`fuel_station` | 10 | `operational_fuel_station` | +8 h of autonomy. With no load and no station to refill at, it stops being useful. |
| `police` | `blocked_transit` on `junction` | 8 | — | Saves nobody on its own. It is what lets every other resource arrive in time. |

`resource`, `appliesTo`, `minutes` and `effect` are executed by `world.ts`: once
a resource has been at its site for `minutes`, the remedy takes hold and the site
starts reporting healthy readings. `solves`, `requires` and `$note` go into the
prompt so the agent can reason about preconditions; the machine-enforced version
of `requires` for generators is the `generator-without-fuel` blocking rule in
`shared/src/rules.json`.

**`contacts`**: the seven people the agent can reach. Each has an `id` (the
handle the LLM uses), `name`, `role`, a `phone` HappyRobot dials, and either a
`resourceId` (they lead that resource) or an `elementId` (they answer for that
site). `$note` carries how they behave — the crew chief, for instance, can refuse
with good reason if asked to abandon a half-finished repair, and says how many
minutes the new task would slip.

Contacts are the whole point of the HappyRobot integration: the agent picks a
recipient from this list, `happyrobot.contact()` dials them, and their answer
comes back through `POST /api/call/outcome`. A refusal or a delay invalidates the
plan's ETA and forces a re-plan (`docs/RULES.md` §7). An unknown recipient is
dropped with a note in the feed rather than dialled.

## `scripts/` — the event script

`madrid-blackout.json` is the timed timeline of the Madrid regional blackout:
`title`, `durationSeconds` (1800) and 54 entries, each with `atSeconds`, a
`kind` and a `payload`.

- `sensor_event` (18) — a reading: `elementId`, `metric`, `value`, `severity`.
- `report` (35) — a raw signal from `social`, `press`, `emergency_call`, `field`
  or `faulty_sensor`, with a free-text `text` and a possibly `null` `elementId`.
  Most are noise. Triaging them is the agent's job, and the needle — a citizen
  reporting a relative on a home ventilator — will never show up in a sensor.
- `narrative` (1) — an event about a resource, not a site.

An entry with a `note` becomes a "key moment" in `GET /api/topology`
(`toTopology`). The five notes mark the blackout (0 s), the datacenter
overheating (240 s), the tower batteries draining (450 s), the hospital losing
its generator (540 s) and the crew missing its ETA (900 s).

## `history/<type>/` — pre-loaded RAG history

Three synthetic incidents per element type (`hospital`, `datacenter`,
`substation`), written before the event so the agent has historical context from
its very first tick. Several hard rules exist *because* of one of these records —
`hist-sub-002` (a partial restoration that looked like a fix) is why `resolved`
demands 60 s of stable voltage, and `hist-dc-002` (a UPS drained while waiting)
is why `critical-ups-act` forbids waiting.

`npm run rag:preload` vectorizes them into Chroma, one collection per type
(idempotent: upsert by incident id, re-running does not duplicate).

**Caveat, as of this writing:** the vectors are not what the agent reads.
`HistoryRag.search()` exists in `backend/src/rag/history.ts` and is never
called — the agent receives these JSON files directly, filtered by the affected
element types and capped at three per turn (`agent.ts`). Chroma is written to
(including every resolved incident, via `recordClosure`) and not read from.
Wiring retrieval in is the remaining step.
