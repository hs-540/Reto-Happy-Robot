# Hard rules catalog

> **Single source of truth**: `shared/src/rules.json` (data) + `shared/src/rules.ts` (typed layer and validation).
> Every number applied by the engine or the agent lives here. **There are no magic thresholds scattered through the code.**
>
> Status: **closed** (agreement A + B, issue #26). Changing a value requires a PR and updating this document.
> It depends on the `status`/`severity`/`attention` semantics of the contract (#18).

## How it is consumed

| Consumer | What it uses |
| --- | --- |
| Status derivation (#19) | `deriveStatus`, `deriveMetricStatus`, `deriveElementStatus` |
| Engine rules layer (#10/#20) | `validateAction`, `BLOCKING_RULES`, `REPLAN_TRIGGERS` |
| **Agent (LLM)** | `AGENT_RULES` — the full JSON, injected as-is into the system prompt, so decisions and plans of action respect the same rules and weights |
| Decision priority | `calculatePriority` + `PRIORITY_ORDER` |

Flow of every agent action: **the LLM proposes** (tool use / structured output) → **`validateAction` checks it against the blocking rules** → if it violates a rule it is rejected with its `id` and handed back to the LLM → if not, **it is executed directly, without a human confirmation gate** (#42), and recorded in the `Decision`.

---

## 1. Severity thresholds → status

`severity` is 0–100 (higher = worse). **Inclusive** cuts (>=):

| Range | Status |
| --- | --- |
| `severity >= 60` | `critical` |
| `30 <= severity < 60` | `degraded` |
| `severity < 30` | `normal` |
| `grid_voltage >= 90` during **60 s** stable | `resolved` |

- An element's final status is **the worst** between the last event's severity and its raw metrics (`deriveElementStatus`).
- **`resolved` is not declared with a single good tick**: it demands 60 s of stability with `grid_voltage >= 90` (lesson from `hist-sub-002`, a partial restoration that created a false sense of resolution).

## 2. Per-metric thresholds

Inclusive cuts. `direction = low` → the lower the value the worse; `direction = high` → the higher the worse.

| Metric | Direction | `degraded` | `critical` |
| --- | --- | --- | --- |
| `grid_voltage` (%) | low | ≤ 85 | ≤ 50 |
| `ups_load` (%) | low | ≤ 50 | ≤ 15 |
| `generator_battery` (%) | low | ≤ 60 | ≤ 20 |
| `temperature` (°C) | high | ≥ 40 | ≥ 45 |
| `network_coverage` (%) | low | ≤ 80 | ≤ 50 |
| `tower_battery` (%) | low | ≤ 40 | ≤ 20 |
| `fuel` (%) | low | ≤ 40 | ≤ 15 |
| `congestion` (index) | high | ≥ 10 | ≥ 25 |

These raw thresholds **raise the status even when the event's severity is low** (e.g. `temperature 41` with `severity 55` → at least `degraded`).

## 3. Non-negotiable time limits (minutes without power)

"Without power" = no grid **and no reliable backup**. Exceeding the hospital's limit triggers the blocking rule `hospital-power-deadline`.

| Site type | Max. minutes without power |
| --- | --- |
| **hospital** | **8** |
| datacenter | 12 |
| tower | 15 |
| substation | 20 |
| fuel_station | 30 |
| junction | 45 |

### UPS threshold (when a rule is blocking for the LLM)

| Condition | Consequence |
| --- | --- |
| `ups_load < 15` | **`wait` forbidden**: a resource must be assigned or the issue escalated (`hist-dc-002`: UPS drained while waiting for backup) |
| `ups_load < 10` | Emergency: immediate backup activation |
| `generator_battery < 20` | Critical battery: prioritize generator dispatch |

## 4. Resource constraints

Total shared capacity of the scenario (`resources.capacity` in `rules.json`):
**1 crew + 2 generators + 1 tanker + 1 police unit**.

- **Mutual exclusion**: a resource serves **one element at a time**. A resource in `assigned` or `in_transit` cannot be reassigned (blocking rule `no-double-assignment`).
- **On release** a resource goes to `available` and can be reassigned on the next tick; releasing is an **incremental adjustment**, it does not trigger re-planning.
- Assigning a nonexistent or unavailable resource is rejected with an explicit reason (`release it before reassigning`).

## 5. Priority order (who wins and why)

**Type order**: `hospital` > `substation` > `tower` > `datacenter` > `fuel_station` > `junction`. Reason: risk to life > origin of the cascade (fixing it restores everyone) > the ability to coordinate at all > service loss > what refuels the resources > what slows them down. It matches the script's `criticality` (95 / 70 / 75 / 60 / 40 / 35).

The tower weighs almost as much as the substation on purpose: if its batteries run out, no call or message reaches anyone and the agent loses its only lever over people. The junction weighs least and still matters, because an unregulated junction doubles every journey (`enables_transit` in `data/topology.json`).

### Numeric priority formula

```
priority = 0.5 · criticality
         + statusWeight        (critical 60 · degraded 20 · normal/resolved 0)
         + typeWeight          (hospital 30 · substation 20 · tower 18 · datacenter 10 · fuel_station 8 · junction 6)
         + 2 · min(minutesWithoutPower, 15)
```

Example from the script: hospital `critical` with 10 min without power → `47.5 + 60 + 30 + 20 = 157.5`; datacenter `degraded` without power loss → `60`. The weights live in `priority` of `rules.json` and the LLM receives them in its prompt to order its plans.

## 6. Blocking rules for the LLM

The LLM **cannot** propose an action that violates them; the rules layer rejects it before execution:

| id | Rule |
| --- | --- |
| `no-double-assignment` | A resource serves one element at a time; reassigning requires releasing it first. |
| `hospital-power-priority` | While a hospital is `critical` and without power backup, generators can only be assigned to it. |
| `hospital-power-deadline` | If a hospital exceeds its limit of minutes without power, only acting on it or on the origin substation (if `critical`) is allowed. |
| `critical-ups-act` | With `ups_load` below the act threshold (15) waiting is forbidden: a resource must be assigned or the issue escalated. |
| `generator-without-fuel` | A generator cannot be deployed to a site whose `fuel` is at or below the critical threshold (15): it must be refuelled by the tanker first, or the journey is wasted. |

Application notes:

- `contact` is **never** blocked (communicating consumes no physical resources).
- When two blocking rules apply, the **stricter one** wins (e.g. with a hospital `critical` without backup, a generator cannot go to the substation even if the hospital has exceeded its deadline: `hospital-power-priority` rules).

## 7. Re-plan triggers

They trigger a **full re-plan** (abandon the current plan), not just incremental adjustment:

1. An event makes a critical element **cross a severity threshold**.
2. An action in progress **fails or misses its ETA**.
3. A hospital **exceeds its limit of minutes without power**.
4. A contact **refuses an action or reports a delay** on a call: the plan relied on an ETA that no longer holds. It arrives through `POST /api/call/outcome` → `agent.closeCall()`.

The remaining ticks (5–10 s) are only incremental adjustments: reordering queues by `calculatePriority`, updating states, reassigning released resources.
