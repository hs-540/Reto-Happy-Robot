# Design — HappyRobot Challenge (HackSpain 2026)

> **How to read this document.** It is the design as it was decided, kept as a
> record. Where the build went another way, the original text stays and a
> **Superseded** note says what happened and why. A design doc that hides a
> reversal is worth less than one that explains it. Everything marked
> *Superseded* describes the past; everything else matches the code.
>
> Quick index of what changed: two AI gateways → one configurable provider; a
> human confirmation gate before real actions → removed; 3 element types → 6;
> 1 crew + 2 generators → a 10-unit fleet of crews, generators, tankers and
> police; 4-5 min of script → 1800 s; one curated timeline → a crisis drawn per
> run; simulated calls → a real mission hook behind an off-by-default switch;
> pause/reset as the only human lever → an operator chat that gives orders.

## Challenge context

Build an autonomous AI agent able to manage a crisis that **changes while the system runs**, continuously responding to:

- Which incoming information actually matters.
- Which action has priority.
- Who to notify and in which order.
- How to allocate limited resources.
- What the next concrete action is.
- When to abandon the current plan for a new one.

Evaluation in 3 blocks with equal weight: **Decision Quality**, **Execution**, **Supervision**.

## Scenario

- **Crisis type**: regional blackout (cascading) in the **Community of Madrid**.
- **Affected elements** (MVP): **datacenters, hospitals and substations/network nodes** — 1 site of each type for the MVP, scalable to more if time allows.
- **Possible future extensions** (not MVP): telecom towers, factories, public transport.
- **Script dynamics**: **fixed scripted timeline** for the MVP (baseline of scheduled, timed events). Future improvement if there is time: **hybrid mode** with a button for the presenter to inject extra events live.
- **Demo duration**: 4-5 minutes, with **5 key moments**:
  1. Initial blackout at the substation (origin) → the agent detects it and starts assessing.
  2. Datacenter starts overheating (UPS on limited battery) → first priority decision.
  3. Hospital loses its backup generator → resource conflict → **live voice call** to a team member.
  4. The dispatched crew misses its ETA / another site worsens → full re-plan.
  5. Resolution: the substation is repaired, power comes back, the incident is closed and its outcome recorded in the RAG history.

> **Superseded — the scenario grew (`data/scripts/madrid-blackout.json`).** The
> three types were not enough to make prioritization hard: with one hospital,
> one datacenter and one substation, type order alone decides everything and the
> agent has nothing to weigh. Three more were added, each one a different kind of
> constraint rather than another victim: a **telecom tower** (if its batteries
> die, no one can be reached at all), a **fuel station** (electric pumps: with no
> grid the tanker cannot refill), and a **road junction** (traffic lights out
> doubles every journey). Resources grew with them: a **tanker** and a **police
> unit** alongside the crew and the two generators. The live injection button —
> filed above as a future improvement — is built. The run's clock is compressed
> (`TIME_SCALE` in the `.env`; 15x is ~2 real minutes, the live-demo value is
> 6x so a deliberation does not outrun the crisis it is answering).
>
> The timeline is now **1800 s** with **54 entries** (18 sensor events, 35
> reports, 1 narrative). The five key moments survive, re-timed and with the
> tower taking moment 3: blackout (0 s), datacenter overheating (240 s), tower
> batteries draining (450 s), hospital loses its generator (540 s), crew misses
> its ETA (900 s). A demo run still fits in minutes; the extra clock is headroom
> for the resolution to play out, not 30 minutes of material.

> **Superseded — the scenario went city-wide (`data/scripts/madrid-blackout.json`).**
> Six places and five resources made triage trivial: almost every site could get
> something. The map is now **15 places** (3 substations, 3 hospitals,
> 2 datacenters, 3 towers, 2 fuel stations, 2 junctions) wired as **three
> dependency rings** — sub-01 in the centre, sub-02 in the north, sub-03 in the
> west — with **10 resources** (2 crews, 4 generators, 2 tankers, 2 police).
> Resources stay deliberately **fewer than the places with problems**, so at
> least five sites go unserved at any moment and the priority formula has real
> work to do. The timeline grew to **93 entries** (42 sensor events, 50 reports,
> 1 narrative); the five key moments keep their slots (0/240/450/540/900 s) and
> the new rings degrade around them. Capacity lives in `shared/src/rules.json`
> (`resources.capacity`); `docs/RULES.md` §4 records the trade-off.

> **Superseded — the timeline is drawn, not written.** A fixed script answers
> the jury's first question ("is this scripted?") badly, and a start overlay
> listing the five key moments before they happened answered it worse.
> `backend/src/scenario.ts` now draws a crisis per seed on every boot and every
> reset: 8-15 of the 15 catalog sites, a fleet of 4-10 of the 10 units sized to
> the draw and always at least one unit short of the sites, and ~100-120
> timeline entries built from 14 failure-arc templates plus a noise pool. The
> needle — the citizen whose relative is on a home ventilator — is always
> planted, at a drawn moment. The curated `madrid-blackout.json` survives as the
> generator's catalog, its fallback when ~20 seeded attempts all fail
> validation, and the tests' fixture. Moments are revealed through the feed only
> once they fire. Full design in
> [`SCENARIO-GENERATION.md`](SCENARIO-GENERATION.md).

## Decision engine

- **Hybrid**: a **hard rules** layer (non-negotiable constraints, e.g. time limits without power at hospitals) + an **LLM** that reasons and decides within those rules, also generating the natural-language explanation of its prioritization.
- **Full re-planning** (abandon the current plan for a new one) is triggered by any of:
  - An event makes a critical element cross a **severity threshold**.
  - An action in progress (e.g. a dispatched crew) **fails or misses its ETA**.
  - The remaining ticks are only incremental adjustments (reordering queues, updating states), without regenerating the global strategy.
- **Limited shared resources** across the 3 element types: **1 mobile technical crew + 2 portable generators** (amounts scale if the number of sites grows).
- **Cadence**:
  - Decision engine tick: every **5-10 seconds**.
  - Frontend polling: every **2 seconds**.

> **Superseded — resources, cadence and replan triggers.** Capacity is now
> **2 crews + 4 generators + 2 tankers + 2 police units** (`shared/src/rules.json`,
> `resources.capacity`), the catalog a 15-site city needs; each run deploys a
> drawn subset of it. A fourth replan trigger was added: **a contact refuses an
> action or reports a delay** — the point of making real calls is that the
> answer can invalidate the plan, and until this existed a refusal changed
> nothing. Cadence tightened to match the compressed run: `TICK_MS` defaults to
> 2000 and the frontend polls every 500 ms (`useCrisis.ts`). While the UI is
> open, the poll — which advances the simulation server-side on every request —
> is the engine's effective cadence; `TICK_MS` only governs the headless
> interval.
>
> The deterministic layer also gained a floor the design did not anticipate: if
> the LLM does not answer inside `DELIBERATION_BUDGET_MS`, the contingency
> playbook (`decideByRules`) takes over with the priority formula, a coverage
> check and an escalation when no legal move is left, and the run continues. The
> budget is no longer a hand-written number: it is
> `max(ATTEMPT_TIMEOUT_MS + 5 s, staleness ceiling)`, where the ceiling is the
> hospital's 8-minute limit converted at `TIME_SCALE`. A hand-written 75 s once
> sat under 90 s of legally allowed retrying and killed deliberations at the
> exact moment they were correcting themselves. The demo degrades, it never
> freezes.

## LLM and AI infrastructure

- **OpenAI SDK** (OpenAI-compatible interface) pointing to:
  - **Primary**: **Vercel AI Gateway** → model **GLM 5.3 Flash**.
  - **Fallback**: **Cloudflare AI Gateway** → model **DeepSeek V4 Flash**.
  - Swappable order later on if convenient.
- **Structured output**: the LLM picks from an action catalog (call, message, wait, reassign resource) via tool use / structured output, validated by the rules layer before executing.

> **Superseded — one provider, not two gateways.** `backend/src/config.ts` builds
> a **single** provider out of `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
> (label in `LLM_PROVIDER`, embeddings in `LLM_EMBEDDING_MODEL`). The sponsor
> gateways were dropped in favour of one OpenAI-compatible endpoint — in
> practice Helmcode serving `deepseek-v4-flash` — because a second gateway is
> only worth its configuration if it serves the same model, and keeping two
> credentials alive during a hackathon is a failure mode of its own.
>
> The failover **code** survives and is deliberate: `createLlmClient` still takes
> a list of gateways and walks it on connection errors, 401/403/404/429 and 5xx
> (`backend/src/llm.ts`, `failureReason`). It currently has exactly one entry to
> try, so it never actually fails over. Adding a backup is appending an object in
> `config.ts`, not rewriting the client. If the single provider goes down the
> engine drops to the deterministic fallback instead.
>
> Structured output landed as described: a Zod schema (`AgentOutputSchema` in
> `prompt.ts`) via `zodResponseFormat`, with `validateAction` vetoing illegal
> actions and handing the rejection back for one retry.

## Learning between runs (bonus)

- **RAG with real embeddings**:
  - **Vector DB**: **local Chroma** (no external service, runs next to the backend).
  - **Embeddings**: generated via the same AI Gateway as the LLM.
  - **Organization**: history segmented into folders/collections per element type (`hospital/`, `datacenter/`, `substation/`). When the crisis affects a hospital, the historical records of the hospital collection are retrieved.
  - **Pre-load**: **3-5 synthetic incidents** per type, written before the event, so the agent already has historical context from the first live run.

> **Built — the loop is closed on both sides.** Chroma starts with the backend
> and is seeded at boot, `npm run rag:preload` vectorizes `data/history/<type>/`
> into a collection per element type (idempotent upsert by id), and
> `recordClosure()` writes every resolved incident back. On the read side,
> `tryRetrieveHistory()` (`agent.ts`) calls `rag.search()` per affected element
> type on every deliberation with a 6 s timeout, falling back to the static JSON
> filtered by element types, three per turn, if the search fails. Retrieved
> incidents reach the prompt with a `Retrieved because...` line and the agent
> cites what it used by id (`historyCitation`).
>
> The corpus outgrew the planned 3-5 records: it is **12 curated incidents for
> each of the six element types**, 72 in all. Three per type left the nearest
> neighbours of any live situation being the whole type, which is retrieval in
> name only; twelve, each a distinct failure mode, make the neighbours a real
> subset. Coverage of all six types also matters now that the scenario is
> drawn — a seed weighted toward towers and junctions would otherwise leave the
> learning layer mute.

> **`backend/chroma-data` is kept across runs on purpose.** The write-back loop
> is the demo's "learning between runs": the second run retrieves the closures
> of the first, and `sim.reset()` deliberately does not clear the collections.
> A demo session therefore accumulates closures — the feature, not a leak. To
> keep the generic write-backs from crowding out the hand-written lessons, every
> document carries a `source` (`curated` for `data/history`, `closure` for a
> write-back) and retrieval reserves half the per-turn budget for `curated`
> (`backend/src/rag/retrieval.ts`). For a clean slate before a presentation,
> stop the backend and remove the directory: `rm -rf backend/chroma-data`. The
> next boot recreates it and re-seeds the curated history (idempotent upsert by
> id), so the run starts with no closures.

## Real actions (HappyRobot)

- **MVP**: **voice call** + **message/chat**.
- **Future extension**: escalation tickets / email.
- **Recipients — mixed approach**:
  - Real voice call to a **team member acting a role** (technician/manager) at the script's moment of highest tension (point 3).
  - Background messages/chat to **fixed test contacts** for the rest of the secondary actions.

> **Built, and reaching a real phone — behind a switch that is off by default.**
> `backend/src/happyrobot.ts` holds both clients behind one interface.
> `createRealClient` `POST`s `{ prompt, missionId }` to a **HappyRobot mission
> hook** (`HAPPYROBOT_WEBHOOK_URL`, with the hook's key as `x-api-key` when it is
> guarded) and the mission's voice agent places the call: no phone number
> travels, the mission knows who it calls. `missionId` is the `actionId` of the
> decision that ordered the call, so dispatch, summary and closure all carry the
> same id and a call is traceable end to end. `buildPrompt` writes the brief the
> voice agent improvises from — role, recipient, situation and an explicit ask;
> measured against the live hook, a bare two-sentence prompt produced a run with
> no transcript at all.
>
> This replaced the earlier design of dialling
> `{HAPPYROBOT_BASE_URL}/api/v1/dial/outbound` with a Bearer key and a phone
> number from the contact list.
>
> **The return path is asynchronous.** On hang-up the hook posts a call-summary
> event to the events API (a Cloudflare worker with D1, `events-api/`), and
> `backend/src/outcome-poll.ts` polls it every `EVENTS_POLL_MS`, matches each
> summary to a dispatched mission and hands it to `agent.closeCall()`, where
> `refused` or `accepted_with_delay` becomes a replan trigger.
> `POST /api/call/outcome` remains as the direct path for a hook configured to
> call straight back into the backend. A platform error closes the call as
> `no_answer` rather than stalling the crisis.
>
> **Real telephony is off unless someone turns it on.**
> `HAPPYROBOT_REAL_CALLS_ENABLED` is checked before anything else: a call
> reaches a person and cannot be taken back, so no combination of leftover
> variables can make a phone ring on its own. With the switch off the simulated
> client answers with scripted replies and runs the identical chain — queue,
> closure, replan — so the return path is never untested.
>
> **The line is one line.** `backend/src/call-queue.ts` wraps the client with
> bounded concurrency (`HAPPYROBOT_MAX_CONCURRENT_CALLS`, default 1) and a
> bounded queue ordered by the urgency of the target site; a call that is stale
> by the time a slot frees is discarded, and a slot held with no closure for
> `HAPPYROBOT_CALL_SLOT_TIMEOUT_MS` is released as `no_answer` so a lost webhook
> cannot deadlock the line. Chat messages consume no line.
>
> **When the run ends, the phones close.** Past the end of the script the queue
> dials nothing at all: a call decided now is dropped, and so are the ones still
> waiting for a contact. The engine goes on running as it did — what stops is
> the outbound line, because a call placed after the end rings a real person
> about a crisis that is already over and that nobody is watching the screen
> for. A reset draws a new crisis and opens the phones again on it.
>
> The contact list lives in `data/remedies.json` (`contacts`), filtered per
> generation to the sites and units actually drawn. One veto applies to calling:
> contacts marked `emergencyService` are never dialled
> (`no-emergency-services-calls`, `RULES.md` §6).

## Supervision and interface

- **Frontend stack**: **React + TypeScript + MapLibre GL**, polling every 2s.
- **Map**: marker per element (datacenter/hospital/substation) colored by status, over the Community of Madrid.
- **Panel**: log of the agent's decisions/actions, sensor states, available/assigned resources.
- **Human intervention** (MVP):
  - **Pause/resume** the decision engine.
  - **Confirmation before executing** any real action against HappyRobot (call/message).
  - Future extension: manually override a decision and force another priority.

> **Superseded — the confirmation gate was removed** (commit `403b744`,
> "feat: remove confirm/reject gate for agent actions", #43). The challenge asks
> for an *agentic* system, and a gate that stops every call until a human clicks
> makes the operator the agent and the model a suggestion box. It also broke the
> demo's own premise: an autonomous crisis manager that cannot dial without
> permission is not managing the crisis.
>
> What replaced it: `ActionRegistry.record()` stamps actions as `executed` on
> creation and publishes them to the feed, so supervision is **after the fact and
> total** rather than a checkpoint — every action, its reasoning and its outcome
> are in the append-only feed. The human controls that remain are pause/resume,
> reset and live event injection. The markers are in the code
> (`#43, no human gate` in `agent.ts` and `control.ts`) and in `CONTRACT.md`
> (`Action.status` is born `executed`).
>
> The frontend ships map, feed, agent panel, injection panel and an end-of-run
> report overlay; start, pause/resume and reset are wired — reset has a button
> in the CommandBar, and it draws a **new** scenario rather than rewinding the
> current one.

> **Built — overriding a decision is no longer a future extension.** The
> **Chat** tab of the agent panel (`POST /api/chat`, `backend/src/chat.ts`) is a
> direct channel to the agent: ask what it is doing and why, re-prioritize a
> site, order a unit somewhere, or leave a note it carries into later
> deliberations. The orders are real and bounded:
>
> - `prioritize` / `deprioritize` shift the site inside `World.priorities`, the
>   single ranking the prompt, the contingency playbook, the idle-resource
>   pairing and the call queue all read, so nothing downstream can disagree
>   about what comes first. They stand until a reset.
> - `assign` / `release` move the fleet through the same `world.assign` /
>   `world.release` the agent uses, **after passing `validateAction`** — the same
>   hard rules that veto the model's own proposals. A refused order names the
>   rule that refused it and moves nothing.
>
> Orders execute against the world as it is, not the snapshot the model read
> while thinking, and every turn and accepted order is published to the feed as
> a `chat` entry: a human intervention that left no trace could not be read back
> in the log the run is judged on. The operator is a human in the loop, not an
> exception to the rules — which is the shape the removed confirmation gate was
> reaching for, without making the model a suggestion box.

## Project stack and infrastructure

- **Monorepo**, TypeScript on both sides:
  ```
  /backend   → Node server (REST API + decision engine + HappyRobot/gateways integration)
  /frontend  → React + MapLibre app
  /data      → event script (JSON), pre-loaded RAG history (folders per type)
  /shared    → shared TypeScript types (Element, SensorEvent, Decision, Action)
  ```

> **Amended — `/data` also holds the scenario's facts.** Two files the design did
> not foresee: `topology.json` (what depends on what: `supplies`,
> `enables_comms`, `enables_transit`, `refuels`) and `remedies.json` (which
> resource fixes what, in how many minutes, with what prerequisite, plus the
> contact list). They are facts, never priorities — the judgement stays in the
> agent. Documented in `data/README.md`. A third arrived with street-level
> routing: `roads.json`, the real Getafe road graph from OpenStreetMap, so a
> dispatched unit drives streets instead of a straight line. `/shared` also
> carries the hard-rules catalog (`rules.json` + `rules.ts`), documented in
> `RULES.md`.
>
> There is also a fourth workspace-shaped directory the design did not foresee:
> `/events-api`, a Cloudflare Worker with D1 that receives the voice agent's
> call summaries. It deploys on its own and is deliberately **outside** the npm
> workspaces and the monorepo build — see `events-api/README.md`.
- **Execution during the demo**: everything **local** (team laptop), no cloud deployment, to minimize failure points from venue network. It still depends on internet for the AI Gateways and HappyRobot (unavoidable).

> **Amended — one piece is deployed.** The events API runs on Cloudflare
> Workers, because the return path of a real call is a webhook HappyRobot has to
> be able to reach, and a laptop behind a venue network is not reachable. It is
> the only deployed component; everything the demo shows still runs locally, and
> with real calls switched off nothing outside the laptop is contacted at all.

## Available sponsor credits

- **Vercel**: AI Gateway credits ($50).
- **Cloudflare**: AI Gateway ($100).
- Quiver AI, Fal AI: not used in this design (credits available if needed for extensions).

> **Superseded — none of these are used.** The single provider is configured
> through `.env`; no sponsor gateway ended up in the build. Kept here because the
> credit inventory is why the two-gateway design existed in the first place.
