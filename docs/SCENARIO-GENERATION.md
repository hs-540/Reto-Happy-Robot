# Randomized scenario generation — design

> Status: **decided, not built**. This is the agreed design for replacing the
> single hand-written script with a seeded generator. Nothing in `backend/src`
> implements it yet; `data/scripts/madrid-blackout.json` is still the only
> scenario.

## Why

The demo has to survive the question *"is this scripted?"*. Today it is: one
fixed timeline, the same 93 entries in the same order every run, and a start
overlay that lists the five key moments **before** they happen. The goal of the
generator is **credibility with a safety net** — being able to hit reset in
front of the jury and get a different, coherent, playable crisis, while keeping
a known-good path for the live run.

Robustness testing (batch runs, metrics) is explicitly **not** the goal.

## What the current code assumes

Facts the design has to work around:

| Where | What it does today |
| --- | --- |
| `backend/src/index.ts:26` | `loadScript` runs once at boot |
| `backend/src/index.ts:29` | `loadTopology` runs once at boot |
| `backend/src/index.ts:44` | `createWorld(script, …)` captures the script |
| `backend/src/index.ts:101` | `toTopology(script)` computed once, served by `GET /api/topology` |
| `frontend/src/api.ts:16` | The frontend fetches topology once |
| `backend/src/sim.ts` | `createSimulation(script, …)` closes over the script; `reset()` rewinds it, never replaces it |
| 8 test files | Load `data/scripts/madrid-blackout.json` and assert on its content |

So "reset gives a new crisis" is not free: those objects have to become
rebuildable instead of module-level constants.

Two numbers that bound the design:

- **The problem space is 4 classes, not 40.** `remedies.json` defines
  `grid_failure` (substation), `power_loss` (hospital/datacenter/tower),
  `low_fuel` and `blocked_transit` (junction), over 6 element types and 8
  `SensorMetric` values. Forty hand-written incidents would be the same arc with
  different site names.
- **The ceiling is 15 concurrent problems, and scarcity bites at ~12.** There are
  15 sites and 10 resources (2 crew, 4 generators, 2 tankers, 2 police). A
  substation repair is 18 min against a 30 min crisis, so two crews cover ~3
  substations at best. Difficulty is therefore budgeted, not counted.

## Design

### Seeded generator, rebuilt on reset

`generateScenario(seed)` returns `{ script, topologyGraph, contacts }`.
`reset` calls it again. This requires pulling `script`, `world`, `sim`, `agent`
and `topology` out of module scope in `index.ts` into a factory, and having the
frontend refetch `/api/topology` after a reset.

### Unit of randomization: root causes + derived cascade

The catalog holds **10-14 templates parameterized by element type**, each one an
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
   are decorative for the whole run, which is 4 of the 10 resources.
3. **Contacts filtered to the subset** — `prompt.ts` only offers contacts whose
   `elementId` / `resourceId` is present, so the agent never dials someone who
   does not exist in the world.
4. **At least 2 hospitals and 2 substations** — preserves the dilemma that makes
   the demo interesting: more downed rings than crews, more lives at stake than
   generators.

### Difficulty: resource-minute budget

The generator sums the resource-minutes cost of what it draws (from
`remedies.json` `minutes` plus travel) and targets a band of roughly **130-180%
of the capacity available in the window**. Triage is always visible and
something is always closable. The band is two constants to tune.

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

`StartOverlay.tsx:43-47` currently lists "5 key moments" with their titles before
the run starts, and `CommandBar.tsx:142` tracks "M1…M5" as it advances. The
screen is announcing the script. It changes to:

- The start overlay states the crisis type and duration, not what will happen.
- The command bar shows moments **already** past, as a narrative thread.

Randomizing behind the scenes while the UI still previews the plot would be
counterproductive.

### RAG coverage

`data/history/` covers only `hospital`, `datacenter` and `substation`, and
`search()` queries the collection of the affected element type. A seed weighted
toward towers and junctions would leave the learning layer mute. Three synthetic
historical incidents are added for `tower`, `fuel_station` and `junction`, in the
same format.

`recordClosure()` writes resolved incidents into Chroma and `sim.reset()` does
not clear them. That accumulation stays: it is literally the agent learning from
the previous crisis, and it is worth saying out loud to the jury.

### Seed handling

Each reset draws a seed, shows it in the header and publishes it to the feed as a
`system` entry. `POST /api/control` accepts `{ action: "reset", seed }`. A seed
can therefore be pre-validated before the live run and an odd run reproduced
exactly.

### Escape hatch

`SCENARIO_MODE=curated|random` in `.env`, defaulting to `random`. In `curated`
mode the backend loads `data/scripts/madrid-blackout.json` unchanged — the path
the 8 existing tests already cover, and the same fallback the failed-retry branch
uses. One variable, no code change, minutes before presenting.

### Tests

`madrid-blackout.json` stays untouched: it is both the fixture for the 8 tests
that load it and the generator's fallback. The generator gets its own tests:

- fixed seed → expected output (catches unintended changes to the draw);
- property tests over ~100 seeds asserting the invariants (topological closure,
  no dangling contacts, resource coverage, budget band).

## Implementation order

1. **Rebuildable factory** in `index.ts` plus topology refetch on reset. Unblocks
   everything else and is the only step that touches architecture.
2. **The generator**: site subset, invariants, templates, budget, retry and
   fallback, with its tests.
3. **Seed surfacing** and `SCENARIO_MODE`.
4. **Moments UI**.
5. **RAG history** for the three missing element types.
