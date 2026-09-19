# API and data contract — HappyRobot Challenge

Source of truth for backend ↔ frontend communication. The types live in
`shared/src/index.ts`; this document illustrates them with example payloads.

Rule: if a route or a payload changes, `shared` changes first, it compiles, and
then this document gets updated. The issue tracker does not rule.

## Endpoints

| Route | Method | Purpose | Poll |
|---|---|---|---|
| `/api/topology` | GET | Elements + base resources + script metadata | once on load |
| `/api/state` | GET | World + resources (current snapshot) | 2s |
| `/api/agent` | GET | Current plan, live decisions, actions | 2s |
| `/api/feed?since=<seq>` | GET | Append-only log (`alarm`/`decision`/`action`/`system`) | 1-2s |
| `/api/control` | POST | `pause`/`resume`/`inject` | — |
| `/api/health` | GET | Connection status | 5s |

## Golden rules

1. Monotonic `seq` cursor, **never timestamps** for `since`. Avoids duplicates and gaps.
2. Every feed item carries `elementId` and, when applicable, `decisionId`/`actionId`. It allows correlating map ↔ agent.
3. `/api/topology` and `/api/state` return a **full snapshot**, never diffs.
4. `severity`, `status` and `attention` are computed by the **backend**. The frontend does not derive critical state.
5. `attention.state` is derived (live action or assigned resource), the LLM does not set it.
6. The feed is consumed as a **`seq`-keyed accumulator** (merge + dedup). That way it can move from polling to SSE without touching the UI.

## GET /api/topology

```json
{
  "crisis": {
    "title": "Regional blackout — Getafe, Community of Madrid",
    "durationSeconds": 300,
    "moments": [
      { "atSeconds": 0, "title": "Initial blackout at the substation" },
      { "atSeconds": 40, "title": "Datacenter overheats" },
      { "atSeconds": 90, "title": "Hospital loses its generator" },
      { "atSeconds": 150, "title": "ETA missed: re-plan" },
      { "atSeconds": 240, "title": "Substation repaired" }
    ]
  },
  "elements": [
    { "id": "sub-01", "type": "substation", "name": "Getafe-Sur Substation", "lat": 40.3057, "lng": -3.7327, "criticality": 70 },
    { "id": "dc-01", "type": "datacenter", "name": "Getafe Metropolitan Datacenter", "lat": 40.295, "lng": -3.72, "criticality": 60 },
    { "id": "hosp-01", "type": "hospital", "name": "Getafe-Sur Regional Hospital", "lat": 40.31, "lng": -3.71, "criticality": 95 }
  ],
  "resources": [
    { "id": "crew-1", "type": "crew", "lat": 40.302, "lng": -3.722 },
    { "id": "generator-1", "type": "generator", "lat": 40.302, "lng": -3.722 },
    { "id": "generator-2", "type": "generator", "lat": 40.302, "lng": -3.722 }
  ]
}
```

## GET /api/state

Full snapshot of the world. Replaced entirely on every poll.

```json
{
  "tick": 42,
  "paused": false,
  "started": true,
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
`attention.state`: `unattended` | `analyzing` | `resource_assigned` | `resolved`.
The assignment shows up on both sides (`element.attention.resourceId` and `resource.assignedElementId`); the backend computes it once.

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
`Action.status` is born directly as `executed`: the agent's actions run without a human confirmation gate.

## GET /api/feed?since=<seq>

Returns only what is new. The frontend accumulates and dedups by `seq`.

```json
{
  "items": [
    { "seq": 18, "ts": "2026-09-18T10:03:40.000Z", "kind": "alarm", "elementId": "dc-01", "metric": "temperature", "value": 48, "severity": 70 },
    { "seq": 19, "ts": "2026-09-18T10:03:41.000Z", "kind": "decision", "elementId": "dc-01", "decisionId": "dec-005", "priority": 2, "reasoning": "Reassigning resources to the datacenter…", "provokesReplan": false },
    { "seq": 20, "ts": "2026-09-18T10:03:42.000Z", "kind": "action", "elementId": "dc-01", "actionId": "act-008", "type": "chat_message", "status": "executed", "message": "Preventive shutdown of the hot aisles." },
    { "seq": 21, "ts": "2026-09-18T10:03:43.000Z", "kind": "system", "message": "Full re-plan: crew misses its ETA." }
  ],
  "lastSeq": 21
}
```

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

## GET /api/health

```json
{ "status": "ok", "tick": 42, "paused": false, "started": true }
```

## Map ↔ agent correlation

| UI element | Source | Link field |
|---|---|---|
| Marker, color | `/api/state` | `elements[].status` |
| Resource movement | `/api/state` | `resources[].lat/lng`, `resources[].route` (street polyline while `in_transit`, drawn on the map) |
| Decision text | `/api/agent` | `decisions[].reasoning` |
| Ticker / history | `/api/feed` | `items[].elementId`, `decisionId`, `actionId` |
