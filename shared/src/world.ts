import type { ScriptElement, ScriptResource, SensorEvent } from "./script.js";
import type { LatLng } from "./roads.js";

/* Primitives derived from the data/ schemas (single source in script.ts) */
export type ElementType = ScriptElement["type"];

export type ElementStatus = ScriptElement["status"];

export type SensorMetric = SensorEvent["metric"];

export type ResourceType = ScriptResource["type"];

export type ResourceStatus = ScriptResource["status"];

export type ElementTopology = Omit<ScriptElement, "status">;

export type ResourceTopology = Omit<ScriptResource, "status" | "assignedElementId">;

export interface ScriptMoment {
  atSeconds: number;
  title: string;
}

export interface TopologyView {
  crisis: {
    title: string;
    durationSeconds: number;
    moments: ScriptMoment[];
  };
  elements: ElementTopology[];
  resources: ResourceTopology[];
}

export type AttentionState =
  | "unattended"
  /** a live decision covers the site, but no resource is committed yet */
  | "analyzing"
  /** resource committed and on its way: the site IS covered, no need for another */
  | "resource_en_route"
  /** resource deployed and working on site */
  | "resource_assigned"
  | "resolved";

/**
 * How long until a site stops being a problem. `attention` says somebody is on
 * it; this says when they are done — the difference between "a generator is
 * coming" and "the hospital has power in four minutes", with a limit of eight.
 *
 * Every number is in CRISIS seconds, like the rest of the state: the simulation
 * runs faster than the wall clock and the countdown belongs to the scenario.
 */
export interface RepairEstimate {
  /** the resource doing the work */
  resourceId: string;
  /**
   * The site actually being worked on. Usually the element itself; when the fix
   * is inherited it is the upstream node whose repair restores this one's grid.
   */
  viaElementId: string;
  /** until the resource reaches the site it is working on; 0 once it is there */
  travelSeconds: number;
  /** work left after arriving, from the remedy's declared duration */
  workSeconds: number;
  /** what the counter shows: travel + work */
  totalSeconds: number;
}

export interface ElementView {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  status: ElementStatus;
  /** 0-100, derived from sensors in the backend */
  severity: number;
  sensors: Partial<Record<SensorMetric, number>>;
  attention: {
    state: AttentionState;
    resourceId: string | null;
    activeDecisionId: string | null;
  };
  /** countdown to being fixed; `null` when nothing is on its way */
  repair: RepairEstimate | null;
  updatedAt: string;
}

export interface ResourceView {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
  /**
   * Road polyline the resource is following while `in_transit` (origin, street
   * vertices, destination). Absent when it is not moving or the journey could
   * not be routed over the network.
   */
  route?: LatLng[];
}

export interface StateView {
  tick: number;
  paused: boolean;
  /** false until the script starts via POST /api/control {action:"start"} */
  started: boolean;
  /** the script played out completely: the clock is frozen at its duration */
  finished: boolean;
  /** Simulated instant, ISO 8601 */
  simulationClock: string;
  /** Last seq emitted in the feed; correlates /api/state with /api/feed */
  lastSeq: number;
  elements: ElementView[];
  resources: ResourceView[];
}

/** End-of-run report served by GET /api/summary (populated once the script is over) */
export interface RunSummaryView {
  /** false while the run is still going or has not started */
  available: boolean;
  /** feed publications grouped by kind, for the run's activity totals */
  events: {
    total: number;
    alarms: number;
    reports: number;
    decisions: number;
    actions: number;
    outcomes: number;
    /** operator directives (pins and orders) plus the agent's answers */
    directives: number;
    system: number;
  };
  /** incidents resolved this run vs sites still degraded or critical */
  incidents: { resolved: number; open: number };
  /** LLM consumption across the whole run */
  llm: {
    calls: number;
    minLatencyMs: number | null;
    meanLatencyMs: number | null;
    maxLatencyMs: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** wall time from a deliberation trigger to its decision being executed */
  meanReactionMs: number | null;
}
