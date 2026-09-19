# Checklist — Happy Robot Challenge (HackSpain 2026)

> Objectives extracted from `Happy Robot Challenge Guide.md` (submission requirements and evaluation criteria).

## Mandatory submission requirements

- [x] **Agentic system** — decides and acts on its own (not a passive chatbot) *(hybrid rules+LLM engine, no human gate: `agent.ts` observes → deliberates → executes)*
- [x] **Dynamic scenario** — continuous changes during execution *(tick + event script + live injections with re-planning)*
- [x] **Multi-step response** — chain of actions with a cohesive objective *(plan with chained steps, `replanOf` links every re-plan)*
- [ ] **Real interaction** — integration with external systems (calls, APIs, tickets) *(⚠️ pending: `contact` is stamped as executed but does not call the HappyRobot API)*
- [x] **User interface** — panel with state, system actions and intervention *(map + feed + agent panel + injection panel + pause)*

## 🧠 Decision

- [x] Decides sensibly **without complete information** *(signal triage: only wakes the LLM if something really changes)*
- [x] Prioritizes correctly under **multiple urgencies** *(deterministic priority formula + hard-rules validation)*
- [x] **Adapts** to live situational changes *(threshold crossings, missed ETAs, injections → immediate replan)*

## ⚡ Action

- [x] Coordinates **simultaneously** people, information and resources *(assigns resources and contacts within the same deliberation, several decisions per plan)*
- [x] **Really executes** (not just proposes actions) *(`assign_resource` moves resources and changes the world; `contact` is recorded, without real execution)*

## 👁 Supervision

- [x] **Operational transparency** + possible human intervention *(append-only feed with reasoning, manual injection, pause/reset)*
- [x] **Original** scenario and management *(cascading blackout in the Community of Madrid)*
- [x] **Iterative learning** from previous runs *(RAG with Chroma: the agent cites applicable historical incidents by id; history pre-loaded, not generated from its own runs)*

## 🎁 Bonus / Presentation

- [x] **Learning** — analysis of previous runs for continuous improvement (bonus) *(RAG over `data/history` per element type, cited in the reasoning)*
- [ ] **Polished demo** — "the demo counts as much as the system" *(pending a full rehearsal; the HappyRobot integration affects the "real call" effect)*
