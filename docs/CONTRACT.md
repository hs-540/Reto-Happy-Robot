# API and data contract — HappyRobot Challenge

Source of truth for backend ↔ frontend communication. The types live in
`shared/src/index.ts`; this document illustrates them with example payloads.

Rule: if a route or a payload changes, `shared` changes first, it compiles, and
then this document gets updated. The issue tracker does not rule.

## Endpoints

| Route | Method | Purpose | Poll |
|---|---|---|---|
| `/api/topology` | GET | Elements + base resources + script metadata | once on load |
| `/api/state` | GET | World + resources (current snapshot) | 500ms |
| `/api/agent` | GET | Current plan, live decisions, actions | 500ms |
| `/api/feed?since=<seq>` | GET | Append-only log (`alarm`/`report`/`decision`/`action`/`outcome`/`chat`/`system`) | 500ms |
| `/api/control` | POST | `start`/`reset`/`pause`/`resume`/`inject` | — |
| `/api/chat` | GET | Operator channel: messages, standing orders, `thinking` | 500ms |
| `/api/chat` | POST | An operator turn: talk, re-prioritize, order a unit | — |
| `/api/call/outcome` | POST | HappyRobot webhook: what the person answered, on hang-up | — |
| `/api/health` | GET | Connection status | — |
| `/api/summary` | GET | End-of-run report (totals, LLM tokens, reaction time) | when finished |

`/api/state`, `/api/agent`, `/api/feed` and `/api/chat` are polled by a single
500 ms loop in the frontend (`useCrisis.ts`, `POLL_MS = 500`). That poll also
advances the simulation server-side on every request, so while the UI is open it
— not `TICK_MS` — is the engine's effective cadence. `/api/health` is served but
the UI does not poll it; it is there for a healthcheck from outside.

## Golden rules

1. Monotonic `seq` cursor, **never timestamps** for `since`. Avoids duplicates and gaps.
2. Every feed item carries `elementId` and, when applicable, `decisionId`/`actionId`. It allows correlating map ↔ agent.
3. `/api/topology` and `/api/state` return a **full snapshot**, never diffs.
4. `severity`, `status` and `attention` are computed by the **backend**. The frontend does not derive critical state.
5. `attention.state` is derived (live action or assigned resource), the LLM does not set it.
6. The feed is consumed as a **`seq`-keyed accumulator** (merge + dedup). That way it can move from polling to SSE without touching the UI.

## GET /api/topology

Each boot and each reset draws its own crisis (`backend/src/scenario.ts`, see
[`SCENARIO-GENERATION.md`](SCENARIO-GENERATION.md)), so the element and resource
lists below are one generation, not a fixed roster: a run carries 8-15 sites and
4-10 resources. The frontend refetches this route when the tick goes backwards.

`crisis` carries only the title and the duration: the plot never travels in the
topology. Key moments reach the UI through the **feed** — each timeline event
with a `note` publishes a `system` entry marked `moment: true` the moment it
fires (`applyEvent` in `backend/src/sim.ts`), and the command bar accumulates
those into its narrative thread.

```json
{
  "crisis": {
    "title": "Cascading blackout — Getafe, Community of Madrid",
    "durationSeconds": 1800
  },
  "elements": [
    { "id": "sub-01", "type": "substation", "name": "Getafe-Sur Substation", "lat": 40.3057, "lng": -3.7327, "criticality": 70 },
    { "id": "hosp-01", "type": "hospital", "name": "Getafe-Sur Regional Hospital", "lat": 40.31, "lng": -3.71, "criticality": 95 },
    { "id": "dc-01", "type": "datacenter", "name": "Getafe Metropolitan Datacenter", "lat": 40.295, "lng": -3.72, "criticality": 60 },
    { "id": "tower-01", "type": "tower", "name": "Getafe Norte Telecoms Tower", "lat": 40.3125, "lng": -3.7285, "criticality": 75 },
    { "id": "fuel-01", "type": "fuel_station", "name": "A-42 Service Station", "lat": 40.2998, "lng": -3.7352, "criticality": 40 },
    { "id": "junction-01", "type": "junction", "name": "Av. Juan Carlos I Junction", "lat": 40.3082, "lng": -3.7156, "criticality": 35 }
  ],
  "resources": [
    { "id": "crew-1", "type": "crew", "lat": 40.302, "lng": -3.722 },
    { "id": "generator-1", "type": "generator", "lat": 40.302, "lng": -3.722 },
    { "id": "generator-2", "type": "generator", "lat": 40.302, "lng": -3.722 },
    { "id": "tanker-1", "type": "tanker", "lat": 40.2985, "lng": -3.7312 },
    { "id": "police-1", "type": "police", "lat": 40.3062, "lng": -3.7191 }
  ]
}
```

`type`: `substation` | `hospital` | `datacenter` | `tower` | `fuel_station` | `junction`.
Resource `type`: `crew` | `generator` | `tanker` | `police`.
The scenario's dependencies and remedies are **not** in this payload: they live in
`data/topology.json` and `data/remedies.json` and are handed to the agent, not to
the frontend. See [`../data/README.md`](../data/README.md).

## GET /api/state

Full snapshot of the world. Replaced entirely on every poll.

```json
{
  "tick": 42,
  "paused": false,
  "started": true,
  "finished": false,
  "simulationClock": "2026-09-18T10:03:30.000Z",
  "lastSeq": 17,
  "elements": [
    {
      "id": "hosp-01",
      "type": "hospital",
      "name": "Getafe-Sur Regional Hospital",
      "lat": 40.31,
      "lng": -3.71,
      "status": "critical",
      "severity": 85,
      "sensors": { "generator_battery": 18, "grid_voltage": 12 },
      "attention": {
        "state": "resource_assigned",
        "resourceId": "generator-2",
        "activeDecisionId": "dec-004"
      },
      "repair": {
        "resourceId": "generator-2",
        "viaElementId": "hosp-01",
        "travelSeconds": 0,
        "workSeconds": 180,
        "totalSeconds": 180
      },
      "updatedAt": "2026-09-18T10:03:30.000Z"
    }
  ],
  "resources": [
    {
      "id": "crew-1",
      "type": "crew",
      "status": "in_transit",
      "assignedElementId": "dc-01",
      "lat": 40.299,
      "lng": -3.717,
      "route": [
        { "lat": 40.302, "lng": -3.722 },
        { "lat": 40.3018, "lng": -3.7205 },
        { "lat": 40.2978, "lng": -3.7155 }
      ]
    }
  ]
}
```

`status`: `normal` → `degraded` → `critical` → `resolved`.
`attention.state`: `unattended` | `analyzing` | `resource_en_route` | `resource_assigned` | `resolved`.
All five are emitted: a resource still `in_transit` reports `resource_en_route`,
one already on site `resource_assigned`, and a resolved element `resolved`
whatever is standing on it. Both resource states mean "covered".
The assignment shows up on both sides (`element.attention.resourceId` and `resource.assignedElementId`); the backend computes it once.

`repair`: the countdown to the element being fixed, or `null` when nothing is on
its way (and always `null` once it is `resolved`). Every figure is in **crisis
seconds**, like the rest of the state. `attention` says somebody is on it;
`repair` says when they are done — covered is not fixed, and the hospital's
8-minute limit only means something next to a number.

| Field | Meaning |
| --- | --- |
| `resourceId` | the resource doing the work |
| `viaElementId` | the site actually being worked on; when it differs from the element, the fix is **inherited** — repairing that upstream node restores this one's grid |
| `travelSeconds` | until the resource reaches its site; `0` once it is there |
| `workSeconds` | work left after arriving, from the remedy's declared duration |
| `totalSeconds` | `travelSeconds + workSeconds`: what the counter shows |

An element's own resource always wins over an inherited estimate, and a resource
sent where its remedy does not apply produces no estimate at all.
`sensors` keys (`SensorMetric`): `grid_voltage`, `ups_load`, `generator_battery`,
`temperature`, `network_coverage`, `tower_battery`, `fuel`, `congestion` — all
optional, a site only reports what it has. Their thresholds are in
[`RULES.md`](RULES.md) §2.
Resource `status`: `available` | `in_transit` | `assigned`.

## GET /api/agent

```json
{
  "tick": 42,
  "paused": false,
  "currentPlan": {
    "objective": "Stabilize the hospital before its generator runs out",
    "steps": [
      { "id": "s1", "description": "Assign generator-2 to hosp-01", "elementId": "hosp-01", "completed": true },
      { "id": "s2", "description": "Notify the hospital manager", "elementId": "hosp-01", "completed": false }
    ],
    "generatedAt": "2026-09-18T10:03:10.000Z",
    "replanOf": "dec-003"
  },
  "decisions": [
    {
      "id": "dec-004",
      "timestamp": "2026-09-18T10:03:10.000Z",
      "elementId": "hosp-01",
      "priority": 1,
      "reasoning": "The hospital has criticality 95 and only 18% battery. The datacenter can wait 5 min.",
      "provokesReplan": true,
      "actions": [
        {
          "id": "act-007",
          "type": "voice_call",
          "targetElementId": "hosp-01",
          "recipient": "hospital_manager",
          "status": "executed",
          "message": "We will cut power for 10 min to connect the portable generator.",
          "timestamp": "2026-09-18T10:03:10.000Z"
        }
      ]
    }
  ],
  "actions": []
}
```

`Decision.provokesReplan` marks the ticks that regenerate the global plan. The rest are incremental adjustments.
`Action.status` is born `queued` for a `voice_call` — the call waits on a line in the call queue — and `executed` when it goes out straight away (a `chat_message`, or a decision's contact action). When the queue dials the call it publishes a second `action` entry with the same `actionId` and status `executed`; a call the queue drops, evicts or finds stale publishes `discarded`. There is still no human confirmation gate.

## GET /api/feed?since=<seq>

Returns only what is new. The frontend accumulates and dedups by `seq`.

```json
{
  "items": [
    { "seq": 18, "ts": "2026-09-18T10:03:40.000Z", "kind": "alarm", "elementId": "dc-01", "metric": "temperature", "value": 48, "severity": 70 },
    { "seq": 19, "ts": "2026-09-18T10:03:41.000Z", "kind": "decision", "elementId": "dc-01", "decisionId": "dec-005", "priority": 2, "reasoning": "Reassigning resources to the datacenter…", "provokesReplan": false },
    { "seq": 20, "ts": "2026-09-18T10:03:42.000Z", "kind": "action", "elementId": "dc-01", "actionId": "act-008", "type": "chat_message", "status": "executed", "message": "Preventive shutdown of the hot aisles." },
    { "seq": 21, "ts": "2026-09-18T10:03:42.000Z", "kind": "action", "elementId": "hosp-01", "actionId": "act-009", "type": "voice_call", "status": "queued", "message": "The hospital is minutes from its limit: the crew must leave now." },
    { "seq": 22, "ts": "2026-09-18T10:03:50.000Z", "kind": "action", "elementId": "hosp-01", "actionId": "act-009", "type": "voice_call", "status": "executed", "message": "The hospital is minutes from its limit: the crew must leave now." },
    { "seq": 23, "ts": "2026-09-18T10:03:43.000Z", "kind": "system", "message": "Full re-plan: crew misses its ETA." },
    { "seq": 24, "ts": "2026-09-18T10:03:44.000Z", "kind": "report", "source": "emergency_call", "text": "My father is on a home ventilator and the power is out", "elementId": null },
    { "seq": 25, "ts": "2026-09-18T10:04:31.000Z", "kind": "outcome", "elementId": "sub-01", "actionId": "act-007", "outcome": "refused", "delayMinutes": 22, "summary": "The crew chief refuses to abandon the repair half-done." }
  ],
  "lastSeq": 25
}
```

`kind`: `alarm` | `report` | `decision` | `action` | `outcome` | `system` |
`chat` (`shared/src/feed.ts`).

- `report` is a **raw signal**, not a reading: social, press, an emergency call
  or a field team. `elementId` may be `null` — attributing it is the agent's job,
  and most of them are noise. That triage is the point.
- `chat` is a turn of the operator channel (`author`: `operator` | `agent`).
  A human intervention that left no trace in the feed could not be read back
  afterwards, and the feed is what the run is judged on.
- `outcome` is what the person on the other end of a call answered:
  `accepted` | `accepted_with_delay` | `refused` | `no_answer`. Anything other
  than `accepted` forces a re-plan on the next tick.

No `since` → returns the full feed (useful for debugging).

## POST /api/control

```json
{ "action": "inject", "payload": { "elementId": "dc-01", "metric": "temperature", "value": 55, "severity": 80 } }
```

Response:

```json
{ "ok": true }
```

`action`: `start` | `reset` | `pause` | `resume` | `inject`.
The simulation **does not start on boot**: `start` begins the timed script and `reset` returns the world to the reproducible initial state (clock at 0, empty feed, resources and elements re-seeded) and leaves it stopped.
`pause` freezes the simulation clock and stops the LLM tick.
`inject` requires `payload` (sensor event without `id`, assigned by the backend); an unknown `elementId` answers `400 {ok:false, error}`.
An invalid body answers `400 {ok:false, error}`.

## GET /api/chat

The operator channel, whole on every read (it is a demo-length conversation,
capped at 60 turns).

```json
{
  "messages": [
    { "id": "msg-001", "author": "operator", "ts": "2026-09-18T10:05:02.000Z", "text": "send generator-2 to sub-01", "directives": [] },
    {
      "id": "msg-002",
      "author": "agent",
      "ts": "2026-09-18T10:05:09.000Z",
      "text": "On its way.\n\n✕ Not done — [hospital-power-priority] the last free generator is committed to hosp-01.",
      "directives": [
        { "id": "dir-001", "kind": "assign", "elementId": "sub-01", "resourceId": "generator-2", "note": "the operator asked for it", "accepted": false, "reason": "[hospital-power-priority] the last free generator is committed to hosp-01" }
      ]
    }
  ],
  "standing": [
    { "id": "dir-002", "kind": "prioritize", "elementId": "junction-01", "resourceId": null, "note": "a school is being evacuated through it", "accepted": true, "reason": null }
  ],
  "thinking": false
}
```

- `directives` are the orders read out of that turn, **after execution**:
  `accepted` and `reason` are written by the engine, never promised by the
  model. `assign`/`release` pass `validateAction` — the same hard rules that
  veto the agent's own proposals — and a refusal moves nothing.
- `standing` are the accepted `prioritize`/`deprioritize`/`note` orders still in
  force; they shape every deliberation until a reset. A priority order applies
  as a boost inside `World.priorities`, so prompt, playbook, idle pairing and
  call queue cannot disagree about the ranking.
- `thinking` is `true` while an answer is in flight; the next turn is refused
  with `409` until it lands.

## POST /api/chat

```json
{ "text": "the hospital on Calle de Atocha comes first" }
```

`text`: 1-800 characters. Answers `{ "ok": true }` as soon as the turn is
accepted — the reply costs a model call and arrives through `GET /api/chat`,
like everything else the agent does. `400` on an invalid body, `409` while the
agent is still answering the previous turn.

## POST /api/call/outcome

The return path of a real call. HappyRobot invokes it on hang-up with what the
person answered; the backend validates the body and hands it to
`agent.closeCall()`.

```json
{
  "actionId": "act-007",
  "outcome": "refused",
  "delayMinutes": 22,
  "commitment": "Finishes the splice and leaves afterwards",
  "summary": "The crew chief refuses to abandon the repair half-done: picking it back up would cost 22 minutes more than it saves"
}
```

Response: `{ "ok": true }`. An invalid body answers `400 {ok:false, error}`.

- `outcome`: `accepted` | `accepted_with_delay` | `refused` | `no_answer`.
- `delayMinutes` and `commitment` are nullable and default to `null`.
- `actionId` refers to an `Action` already published in the feed as `executed`.
- Anything other than `accepted` becomes a **re-plan trigger**: the plan was
  built on an ETA that no longer holds (`RULES.md` §7).
- With `HAPPYROBOT_REAL_CALLS_ENABLED=false` (the default) the simulated client
  calls the same callback internally, so this shape is exercised either way.
- In a real run the closure normally arrives the other way round: the mission
  hook posts a call summary to the events API and `backend/src/outcome-poll.ts`
  polls it every `EVENTS_POLL_MS`, matching by `missionId` (the `actionId` the
  dispatch carried). This route stays as the direct path for a hook configured
  to call back into the backend.

## GET /api/health

```json
{ "status": "ok", "tick": 42, "paused": false, "started": true }
```

## GET /api/summary

End-of-run report for the finished-state screen. `available` is `false` while the
run is still going or has not started; once the script plays out it carries the
activity totals (feed items by kind), incidents resolved vs still open, the LLM
consumption (calls, min/mean/max latency, prompt/completion/total tokens) and
the mean trigger-to-decision reaction time.

## Map ↔ agent correlation

| UI element | Source | Link field |
|---|---|---|
| Marker, color | `/api/state` | `elements[].status` |
| Resource movement | `/api/state` | `resources[].lat/lng`, `resources[].route` (street polyline while `in_transit`, drawn on the map) |
| Decision text | `/api/agent` | `decisions[].reasoning` |
| Ticker / history | `/api/feed` | `items[].elementId`, `decisionId`, `actionId` |
