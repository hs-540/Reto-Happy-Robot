# Randomized scenario generation — design

> Status: **built** (branch `feat/scenario-generator`, fleet sizing fixed in
> `fix/scenario-difficulty-band`). The generator is the only scenario source:
> every boot and every reset draws a seed. The moments UI (#101) and the RAG
> history for `tower`, `fuel_station` and `junction` (#104, deepened to 12
> incidents per type in #117) are done. Still pending: surfacing the seed
> (header, feed, `POST /api/control { action: "reset", seed }`) and the
> `SCENARIO_MODE` escape hatch.

## Why

The demo has to survive the question *"is this scripted?"*. Before the generator
it was: one fixed timeline, the same 93 entries in the same order every run, and
a start overlay that listed the five key moments **before** they happened. The
generator delivers **credibility with a safety net** — reset in front of the
jury and get a different, coherent, playable crisis, while keeping a known-good
path (the curated script) for the live run.

Robustness testing (batch runs, metrics) is explicitly **not** the goal.

## What the code assumed before the generator

Facts the design had to work around; the rebuildable factory in `index.ts`
resolved all of them:

| Where | What it did before |
| --- | --- |
| `backend/src/index.ts` | `loadScript`/`loadTopology` ran once at boot |
| `backend/src/index.ts` | `world`, `sim`, `agent` and `topology` were module constants |
| `frontend/src/api.ts` | The frontend fetched topology once |
| `backend/src/sim.ts` | `createSimulation(script, …)` closed over the script; `reset()` rewound it, never replaced it |
| 8 test files | Load `data/scripts/madrid-blackout.json` and assert on its content |

So "reset gives a new crisis" was not free: those objects had to become
rebuildable instead of module-level constants. They are: `createRuntime()`
rebuilds world, sim, agent and topology per generation, and the frontend
refetches `/api/topology` when the tick goes backwards (`useCrisis.ts`).

Two numbers that bound the design:

- **The problem space is 4 classes, not 40.** `remedies.json` defines
  `grid_failure` (substation), `power_loss` (hospital/datacenter/tower),
  `low_fuel` and `blocked_transit` (junction), over 6 element types and 8
  `SensorMetric` values. Forty hand-written incidents would be the same arc with
  different site names.
- **The catalog is 15 sites and 10 resources (2 crew, 4 generators, 2 tankers,
  2 police) — but a generated scenario deploys a drawn fleet of 4-10, always
  smaller than the world: at most one unit fewer than the drawn sites.** A
  substation repair is 18 min against a 30 min crisis, so scarcity has to
  survive at every world size; the fleet shrinks with the world (see
  Difficulty), and covering every site at once is never an option.

## Design

### Seeded generator, rebuilt on reset

`generateScenario(seed)` returns `{ script, topologyGraph, contacts }`, and
`createRuntime()` in `index.ts` rebuilds world, sim, agent and topology from it
on every boot and every reset; the frontend refetches `/api/topology` when the
tick goes backwards (`useCrisis.ts`).

### Unit of randomization: root causes + derived cascade

The catalog holds **14 templates parameterized by element type** (3 for
hospitals and datacenters, 2 for the other site types), each one an
arc (a series of escalating `sensor_event`s plus its own reports, with
placeholders such as `{site}` / `{street}`), instantiated onto whichever sites
the seed activated.

Only root causes and genuinely independent local failures are drawn. Dependents
are derived by the simulation from the topology graph. This is what keeps the
world from contradicting the graph the agent reads in its prompt: a hospital can
never lose grid power while its substation is healthy.

Adding a new failure mode is one template, not one entry per site.

### Active sites: 8-15 of the 15, with invariants

The seed picks a subset of sites. Four invariants make the subset playable:

1. **Topological upward closure** — if a dependent is in, its substation is in.
   The `crew` remedy (widest coverage) always has a root cause to repair.
2. **At least one `fuel_station` and one `junction`** — otherwise `tanker`
   (`requires: operational_fuel_station`) and `police` (only acts on junctions)
   are decorative for the whole run.
3. **Contacts filtered to the subset** — `prompt.ts` only offers contacts whose
   `elementId` / `resourceId` is present, so the agent never dials someone who
   does not exist in this generation of the world.
4. **At least 2 hospitals and 2 substations** — preserves the dilemma that makes
   the demo interesting: more downed rings than crews, more lives at stake than
   generators.

Validation also rejects a fleet without one unit of every class: a template's
fix resource must have a base in the world. It also rejects a fleet as large as
the drawn sites: with at most one unit fewer than the site count, ranking sites
and leaving something unattended is always part of the job.

### Difficulty: the fleet is sized to the draw

The generator sums the resource-minutes cost of what it drew (from
`remedies.json` `minutes` plus travel) and then **draws the fleet that keeps
that demand inside the band of roughly 110-140% of the capacity available in
the window** (`BAND_MIN` / `BAND_MAX` in `scenario.ts`, applied by `drawFleet`).
The band was lowered from 1.3-1.8: the fleet starved for units of every class in
every shape, and a demand at ~110-140% of capacity still forces ranking sites,
because demand is above capacity and the fleet can never match the site count.
Capacity is the scarce side: a smaller world deploys fewer units instead of
drifting under the band. One unit of every class always
stays (`MIN_FLEET_SIZE = 4`), so every remedy keeps a base to travel from and
`tanker`/`police` never lose their site. Contacts and topology edges pointing at
dropped units are filtered out with them. On top of the band, the fleet is
capped at **one unit fewer than the drawn sites**: a full 15-site world can
field all 10 units, but an 8-site world fields at most 7 — the world always has
more problems than units to send. Triage is always visible and something is
always closable. The band and the cap are constants to tune.

This was the fix for the first calibration: with the fleet fixed at 10, only
full 15-site worlds could reach the band, so validation rejected every smaller
draw and the retry loop funnelled every seed into the same map. With the fleet
drawn, ~95% of seeds pass validation across shapes of 9-15 sites and 5-10
units.

### Pacing: fixed opening, spaced arrivals

- A root blackout always fires at `t = 0`: it opens the demo with force and
  gives the run a coherent frame.
- Every later incident keeps a minimum spacing of ~120 simulated seconds.

The spacing is not cosmetic. With `TIME_SCALE = 6`, a deliberation measured at
8-20 real seconds occupies **48-120 seconds of crisis clock**. Incidents packed
tighter than that collapse into a single re-plan, and what the jury sees is one
monolithic decision instead of adaptation.

### Validation: reject and retry, with fallback

Generate → check invariants and budget band → on failure, retry with a derived
seed (~20 attempts) → if none passes, load the curated script. The demo never
starts on a broken world and never starts with no scenario.

### Noise and the needle

Each template carries its own reports; a background noise pool is drawn on top.
The **needle** — the citizen whose relative is on a home ventilator, the signal
no sensor would ever produce — always appears, reassigned to whichever hospital
is in crisis in that seed, at a drawn moment. The best moment of the demo is
never lost to a dice roll, and is still not predictable.

### UI: reveal only what has happened

`GET /api/topology` serves no key moments: the plot never travels in the
topology. Every incident opening carries a `note` (roots and locals; grid
cascades are covered by their root's moment), and `applyEvent` publishes each
note as a `system` feed entry marked `moment: true` the moment it fires — the
needle's report carries one too. The command bar accumulates those entries into
its narrative thread: marks appear on the track as the run passes them, the
latest moment is titled, and nothing that has not happened is ever rendered.
The start overlay states the crisis type and duration, not what will happen.

### RAG coverage

`data/history/` now covers **all six element types** — `hospital`, `datacenter`,
`substation`, `tower`, `fuel_station` and `junction` — with **12 curated
incidents each** (72 in total), so no seed can leave the learning layer mute
whichever shape it draws. `search()` queries the collection of the affected
element type; each type's incidents span several distinct failure modes, so the
nearest neighbours of a live situation are a real subset rather than the whole
type (`data/README.md`).

`recordClosure()` writes resolved incidents into Chroma and `sim.reset()` does
not clear them. That accumulation stays: it is literally the agent learning from
the previous crisis, and it is worth saying out loud to the jury.

### Seed handling (planned)

Each reset will draw a seed, show it in the header and publish it to the feed as
a `system` entry; `POST /api/control` will accept `{ action: "reset", seed }`.
A seed can then be pre-validated before the live run and an odd run reproduced
exactly. Today the seed is drawn in `createRuntime()` and discarded.

### Escape hatch (planned)

`SCENARIO_MODE=curated|random` in `.env`, defaulting to `random`. In `curated`
mode the backend would load `data/scripts/madrid-blackout.json` unchanged — the
same fallback the failed-retry branch uses. One variable, no code change,
minutes before presenting.

### Tests

`madrid-blackout.json` stays untouched: it is both the fixture for the tests
that load it and the generator's fallback. The generator has its own tests in
`backend/test/scenario.test.ts`:

- fixed seed → expected output (`scenario.golden.json`; regenerate with
  `UPDATE_GOLDEN=1` when the draw intentionally changes);
- property tests over 100 seeds asserting the invariants (topological closure,
  no dangling contacts, fleet shape, budget band).

## Implementation order

1. ~~**Rebuildable factory** in `index.ts` plus topology refetch on reset.~~ Done.
2. ~~**The generator**: site subset, invariants, templates, budget, retry and
   fallback, with its tests.~~ Done; the budget became fleet sizing after the
   first calibration (see Difficulty).
3. ~~**Moments UI**: notes published as `moment` feed entries, accumulated by the
   command bar.~~ Done (#101).
4. ~~**RAG history** for the three missing element types.~~ Done (#104), deepened
   to 12 incidents per type (#117).
5. **Seed surfacing** and `SCENARIO_MODE`. Pending — the only two items left.
