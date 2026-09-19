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
- [x] **Real interaction** — integration with external systems (calls, APIs, tickets) *(HappyRobot wired end to end and reaching a real phone: `happyrobot.ts` posts `{ prompt, missionId }` to the mission hook, the call queue rations it to one line, and on hang-up the hook posts a call summary to our own Cloudflare Worker (`events-api/`), which `outcome-poll.ts` polls and matches by mission → `agent.closeCall()` → replan. Real telephony sits behind `HAPPYROBOT_REAL_CALLS_ENABLED`, off by default; with the switch off the simulated client runs the identical chain with scripted answers)*
- [x] **User interface** — panel with state, system actions and intervention *(MapLibre crisis map with street-routed units, sites panel, resources dock, agent panel with feed, plan and chat, injection modal, command bar with the narrative thread, and an end-of-run report overlay)*

## 🧠 Decision

- [x] Decides sensibly **without complete information** *(signal triage: only wakes the LLM if something really changes)*
- [x] Prioritizes correctly under **multiple urgencies** *(deterministic priority formula + hard-rules validation)*
- [x] **Adapts** to live situational changes *(threshold crossings, missed ETAs, injections → immediate replan)*

## ⚡ Action

- [x] Coordinates **simultaneously** people, information and resources *(assigns resources and contacts within the same deliberation, several decisions per plan)*
- [x] **Really executes** (not just proposes actions) *(`assign_resource` moves resources and changes the world; `contact` is dispatched through the call queue with no human gate — `queued` while it waits for the line, `executed` when it dials — real when the switch is on, simulated otherwise)*

## 👁 Supervision

- [x] **Operational transparency** + possible human intervention *(append-only feed with reasoning, manual injection, pause/reset, and an operator **chat** that gives real orders: `prioritize`/`deprioritize` shift `World.priorities`, `assign`/`release` move the fleet through the same `validateAction` that vetoes the model's own proposals, and a refused order names the rule that refused it. Every turn and accepted order is published to the feed as a `chat` entry, so the intervention is readable back in the log)*
- [x] **Original** scenario and management *(cascading blackout in the Community of Madrid, and a different one every run: `scenario.ts` draws sites, fleet and timeline from a seed on every boot and reset, so "is this scripted?" can be answered by pressing reset — `docs/SCENARIO-GENERATION.md`)*
- [x] **Iterative learning** from previous runs *(Chroma is started, `data/history/` — 12 curated incidents for each of the six element types — is vectorized by `npm run rag:preload` and every resolved incident is written back by `recordClosure()`. **Retrieval is wired**: `tryRetrieveHistory()` calls `HistoryRag.search()` on every deliberation (`agent.ts`, 6 s timeout), with the static JSON filtered by element type (3 per turn) as fallback. Documents are tagged `source: curated | closure` and retrieval reserves half the per-turn budget for the curated lessons, so earlier runs' write-backs cannot crowd them out. Retrieved incidents appear in the prompt with a `Retrieved because...` line and the agent cites what it used by id (`historyCitation`))*

## 🎁 Bonus / Presentation

- [x] **Learning** — analysis of previous runs for continuous improvement (bonus) *(the loop is closed on both sides: writes via `rag:preload` + `recordClosure()`, reads via `tryRetrieveHistory()` on every deliberation, as above)*
- [ ] **Polished demo** — "the demo counts as much as the system" *(pending a full rehearsal. The pieces are in place: the real-call moment can now land as an actual phone call, key moments are revealed only once they fire, and the run closes on an end-of-run report (`GET /api/summary`) with totals, LLM usage and reaction time)*
