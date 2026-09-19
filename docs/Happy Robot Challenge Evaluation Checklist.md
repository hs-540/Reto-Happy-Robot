# Checklist — Happy Robot Challenge (HackSpain 2026)

> Objectives extracted from `Happy Robot Challenge Guide.md` (submission requirements and evaluation criteria).
>
> Every item names the file it can be checked against. A box is only ticked when
> the code does the thing; where something is half built, the box stays empty and
> the note says exactly which half.

## Mandatory submission requirements

- [x] **Agentic system** — decides and acts on its own (not a passive chatbot) *(hybrid rules+LLM engine, no human gate: `agent.ts` observes → deliberates → executes)*
- [x] **Dynamic scenario** — continuous changes during execution *(tick + event script + live injections with re-planning)*
- [x] **Multi-step response** — chain of actions with a cohesive objective *(plan with chained steps, `replanOf` links every re-plan)*
- [x] **Real interaction** — integration with external systems (calls, APIs, tickets) *(HappyRobot client built and wired end to end: `happyrobot.ts` posts to `/api/v1/dial/outbound`, `agent.execute()` fires it for every communication, and the hang-up comes back through `POST /api/call/outcome` → `agent.closeCall()` → replan. **Caveat: no credential yet**, so `createHappyRobotClient()` falls back to the simulated client and the same chain runs with scripted answers; setting `HAPPYROBOT_API_KEY` switches it to real calls with no code change)*
- [x] **User interface** — panel with state, system actions and intervention *(map + feed + agent panel + injection panel + pause)*

## 🧠 Decision

- [x] Decides sensibly **without complete information** *(signal triage: only wakes the LLM if something really changes)*
- [x] Prioritizes correctly under **multiple urgencies** *(deterministic priority formula + hard-rules validation)*
- [x] **Adapts** to live situational changes *(threshold crossings, missed ETAs, injections → immediate replan)*

## ⚡ Action

- [x] Coordinates **simultaneously** people, information and resources *(assigns resources and contacts within the same deliberation, several decisions per plan)*
- [x] **Really executes** (not just proposes actions) *(`assign_resource` moves resources and changes the world; `contact` is recorded as `executed` with no human gate and dispatched through the HappyRobot client — real when a credential is set, simulated otherwise)*

## 👁 Supervision

- [x] **Operational transparency** + possible human intervention *(append-only feed with reasoning, manual injection, pause/reset)*
- [x] **Original** scenario and management *(cascading blackout in the Community of Madrid)*
- [x] **Iterative learning** from previous runs *(Chroma is started, `data/history/` is vectorized per element type by `npm run rag:preload` and every resolved incident is written back by `recordClosure()`. **Retrieval is wired**: `tryRetrieveHistory()` calls `HistoryRag.search()` on every deliberation (`agent.ts`, 6 s timeout), with the static JSON filtered by element type (3 per turn) as fallback. Retrieved incidents appear in the prompt with a `Retrieved because...` line and the agent cites what it used by id (`historyCitation`))*

## 🎁 Bonus / Presentation

- [x] **Learning** — analysis of previous runs for continuous improvement (bonus) *(the loop is closed on both sides: writes via `rag:preload` + `recordClosure()`, reads via `tryRetrieveHistory()` on every deliberation, as above)*
- [ ] **Polished demo** — "the demo counts as much as the system" *(pending a full rehearsal; without a HappyRobot credential the "real call" moment lands as a simulated one)*
