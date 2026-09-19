import type {
  ElementStatus,
  ElementType,
  ElementView,
  InjectPayload,
  SensorMetric,
  StateView,
} from "@swarmup/shared";
import {
  RESOLVED_STABLE_SECONDS,
  RESOLVED_STABLE_VOLTAGE,
  deriveStatus,
} from "@swarmup/shared";
import type { Report } from "@swarmup/shared";
import type { Script, ScriptEvent } from "./script.js";
import type { Feed } from "./feed.js";
import type { World } from "./world.js";

/** Decision engine cadence (DESIGN.md): tick every 5-10s */
export const TICK_SECONDS = 5;

/**
 * Crisis seconds per real second. The domain numbers are realistic — a hospital
 * survives 8 min without power, repairing a substation takes 18 — but a demo
 * runs for two minutes: at 1:1 none of those deadlines ever came due. At 15x,
 * two minutes of demo is half an hour of emergency and every limit in
 * rules.json and every duration in remedies.json starts meaning something.
 */
export const TIME_SCALE = 15;

/** Delay suffered by the crew at moment 4 of the script */
const ETA_DELAY_SECONDS = 60;

interface ElementState {
  severity: number;
  /** maximum severity reached during the incident, for the historical record */
  maxSeverity: number;
  sensors: Partial<Record<SensorMetric, number>>;
  /** simulated second the element entered normal status (null if not normal) */
  normalSince: number | null;
  hadIncident: boolean;
  /** the incident closure was already handed to `onResolved` */
  reported: boolean;
  /** simulated second of the last received event */
  updatedAt: number;
}

/** Observable data of an incident closure (the moment the element becomes `resolved`) */
export interface IncidentClosure {
  elementId: string;
  type: ElementType;
  name: string;
  maxSeverity: number;
  clock: string;
}

export interface Simulation {
  /** Advances the clock up to `nowMs` and applies the script's due events */
  advance(nowMs: number): void;
  /** Starts the script at `nowMs` (no effect if already running) */
  start(nowMs: number): void;
  /** Back to the reproducible initial state and stops the script */
  reset(): void;
  pause(): void;
  resume(): void;
  /** Hybrid mode: applies an emergency sensor event at the current simulated second */
  inject(payload: InjectPayload): void;
  state(): StateView;
  tick(): number;
  /** Current simulated second; consumed by `world.advance` */
  seconds(): number;
  /** Every script event applied and the clock past the script's duration */
  readonly finished: boolean;
  readonly paused: boolean;
  readonly started: boolean;
}

export function createSimulation(
  script: Script,
  startMs: number,
  feed: Feed,
  world: World,
  onResolved?: (closure: IncidentClosure) => void,
  /** hands each raw signal to the decision engine so it can triage it */
  onReport?: (report: Report) => void,
): Simulation {
  const timeline = [...script.timeline].sort((a, b) => a.atSeconds - b.atSeconds);
  let next = 0;
  let seconds = 0;
  let lastMs = startMs;
  let paused = false;
  let started = false;
  let injections = 0;

  const elements = new Map<string, ElementState>();

  function seedElements(): void {
    elements.clear();
    for (const e of script.elements) {
      elements.set(e.id, {
        severity: 0,
        maxSeverity: 0,
        sensors: {},
        normalSince: 0,
        hadIncident: false,
        reported: false,
        updatedAt: 0,
      });
    }
  }
  seedElements();

  function stateOf(id: string): ElementState {
    const state = elements.get(id);
    if (!state) throw new Error(`event for unknown element: ${id}`);
    return state;
  }

  function isoClock(sec: number): string {
    return new Date(startMs + sec * 1000).toISOString();
  }

  function applyEvent(ev: ScriptEvent): void {
    if (ev.kind === "report") {
      // Raw signal: most of it is noise. It does not touch the world; deciding
      // whether it changes anything is the agent's job, and that triage counts.
      feed.publish({
        kind: "report",
        source: ev.payload.source,
        text: ev.payload.text,
        elementId: ev.payload.elementId,
      });
      // a note on a report is a key moment of the script: revealed as it fires
      if (ev.note !== undefined) {
        feed.publish({ kind: "system", message: ev.note, moment: true });
      }
      onReport?.(ev.payload);
      return;
    }
    if (ev.kind === "narrative") {
      if (ev.note !== undefined) {
        feed.publish({ kind: "system", message: ev.note, moment: true });
      }
      if (ev.payload.event !== "eta_missed" || ev.payload.resourceId === undefined) return;
      // moment 4 of the script: the crew does not arrive in time. The world
      // extends its route and emits the replan trigger on the next tick.
      world.delay(ev.payload.resourceId, ETA_DELAY_SECONDS);
      return;
    }
    const state = stateOf(ev.payload.elementId);
    state.severity = ev.payload.severity;
    state.sensors[ev.payload.metric] = ev.payload.value;
    state.updatedAt = ev.atSeconds;
    if (ev.payload.severity > state.maxSeverity) {
      state.maxSeverity = ev.payload.severity;
    }
    if (deriveStatus(state.severity) === "normal") {
      if (state.normalSince === null) state.normalSince = ev.atSeconds;
    } else {
      state.normalSince = null;
      state.hadIncident = true;
    }
    feed.publish({
      kind: "alarm",
      elementId: ev.payload.elementId,
      metric: ev.payload.metric,
      value: ev.payload.value,
      severity: ev.payload.severity,
    });
    // the key moments of the script are the demo's narrative frame
    if (ev.note !== undefined) {
      feed.publish({ kind: "system", message: ev.note, moment: true });
    }
  }

  function statusOf(state: ElementState): ElementStatus {
    // hist-sub-002: a partial restoration misleads; `resolved` demands sustained
    // stability and, if the element reports grid voltage, that it is restored
    if (
      state.hadIncident &&
      state.normalSince !== null &&
      seconds - state.normalSince >= RESOLVED_STABLE_SECONDS
    ) {
      const voltage = state.sensors.grid_voltage;
      if (voltage === undefined || voltage >= RESOLVED_STABLE_VOLTAGE) return "resolved";
    }
    return deriveStatus(state.severity);
  }

  /** Loop closure (DESIGN.md): every element that becomes `resolved` is handed over exactly once */
  function reportResolved(): void {
    for (const e of script.elements) {
      const state = stateOf(e.id);
      if (state.reported || !state.hadIncident || statusOf(state) !== "resolved") continue;
      state.reported = true;
      if (!onResolved) continue;
      onResolved({
        elementId: e.id,
        type: e.type,
        name: e.name,
        maxSeverity: Math.round(state.maxSeverity),
        clock: isoClock(seconds),
      });
    }
  }

  function isFinished(): boolean {
    return started && next >= timeline.length && seconds >= script.durationSeconds;
  }

  return {
    advance(nowMs: number): void {
      if (!started) {
        lastMs = nowMs;
        return;
      }
      const deltaMs = nowMs - lastMs;
      lastMs = nowMs;
      if (!paused) seconds += (deltaMs / 1000) * TIME_SCALE;
      while (next < timeline.length && timeline[next].atSeconds <= seconds) {
        applyEvent(timeline[next]);
        next++;
      }
      // the script has an end: past its duration the clock freezes and the run
      // is over — the world stops, the summary publishes, the UI shows COMPLETE
      if (seconds >= script.durationSeconds) seconds = script.durationSeconds;
      reportResolved();
    },
    start(nowMs: number): void {
      if (started) return;
      started = true;
      paused = false;
      lastMs = nowMs;
    },
    reset(): void {
      next = 0;
      seconds = 0;
      paused = false;
      started = false;
      feed.reset();
      injections = 0;
      seedElements();
      world.reset();
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
    },
    inject(payload: InjectPayload): void {
      injections++;
      applyEvent({
        atSeconds: seconds,
        kind: "sensor_event",
        payload: {
          id: `injection-${injections}`,
          elementId: payload.elementId,
          metric: payload.metric,
          value: payload.value,
          severity: payload.severity,
        },
      });
    },
    state(): StateView {
      const views: ElementView[] = script.elements.map((e) => {
        const state = stateOf(e.id);
        return {
          id: e.id,
          type: e.type,
          name: e.name,
          lat: e.lat,
          lng: e.lng,
          status: statusOf(state),
          severity: Math.round(state.severity),
          sensors: { ...state.sensors },
          // attention is the agent's, not the simulation's: the HTTP layer
          // replaces this placeholder with `agent.attention(id)` before serving
          attention: { state: "unattended", resourceId: null, activeDecisionId: null },
          // like `attention`: derived state the HTTP layer fills in `fullState`,
          // because it needs the world's routes and the agent's decisions
          repair: null,
          updatedAt: isoClock(state.updatedAt),
        };
      });
      return {
        tick: Math.floor(seconds / TICK_SECONDS),
        paused,
        started,
        finished: isFinished(),
        simulationClock: isoClock(seconds),
        lastSeq: feed.lastSeq(),
        elements: views,
        // resources are owned by `world`: physical state, position and routes
        resources: world.resources(),
      };
    },
    tick(): number {
      return Math.floor(seconds / TICK_SECONDS);
    },
    seconds(): number {
      return seconds;
    },
    get finished(): boolean {
      return isFinished();
    },
    get paused(): boolean {
      return paused;
    },
    get started(): boolean {
      return started;
    },
  };
}
