# Design — HappyRobot Challenge (HackSpain 2026)

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

## LLM and AI infrastructure

- **OpenAI SDK** (OpenAI-compatible interface) pointing to:
  - **Primary**: **Vercel AI Gateway** → model **GLM 5.3 Flash**.
  - **Fallback**: **Cloudflare AI Gateway** → model **DeepSeek V4 Flash**.
  - Swappable order later on if convenient.
- **Structured output**: the LLM picks from an action catalog (call, message, wait, reassign resource) via tool use / structured output, validated by the rules layer before executing.

## Learning between runs (bonus)

- **RAG with real embeddings**:
  - **Vector DB**: **local Chroma** (no external service, runs next to the backend).
  - **Embeddings**: generated via the same AI Gateway as the LLM.
  - **Organization**: history segmented into folders/collections per element type (`hospital/`, `datacenter/`, `substation/`). When the crisis affects a hospital, the historical records of the hospital collection are retrieved.
  - **Pre-load**: **3-5 synthetic incidents** per type, written before the event, so the agent already has historical context from the first live run.

## Real actions (HappyRobot)

- **MVP**: **voice call** + **message/chat**.
- **Future extension**: escalation tickets / email.
- **Recipients — mixed approach**:
  - Real voice call to a **team member acting a role** (technician/manager) at the script's moment of highest tension (point 3).
  - Background messages/chat to **fixed test contacts** for the rest of the secondary actions.

## Supervision and interface

- **Frontend stack**: **React + TypeScript + MapLibre GL**, polling every 2s.
- **Map**: marker per element (datacenter/hospital/substation) colored by status, over the Community of Madrid.
- **Panel**: log of the agent's decisions/actions, sensor states, available/assigned resources.
- **Human intervention** (MVP):
  - **Pause/resume** the decision engine.
  - **Confirmation before executing** any real action against HappyRobot (call/message).
  - Future extension: manually override a decision and force another priority.

## Project stack and infrastructure

- **Monorepo**, TypeScript on both sides:
  ```
  /backend   → Node server (REST API + decision engine + HappyRobot/gateways integration)
  /frontend  → React + MapLibre app
  /data      → event script (JSON), pre-loaded RAG history (folders per type)
  /shared    → shared TypeScript types (Element, SensorEvent, Decision, Action)
  ```
- **Execution during the demo**: everything **local** (team laptop), no cloud deployment, to minimize failure points from venue network. It still depends on internet for the AI Gateways and HappyRobot (unavoidable).

## Available sponsor credits

- **Vercel**: AI Gateway credits ($50).
- **Cloudflare**: AI Gateway ($100).
- Quiver AI, Fal AI: not used in this design (credits available if needed for extensions).
