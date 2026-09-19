import type { ScriptElement, ScriptResource, SensorEvent } from "./script.js";

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
  | "analyzing"
  | "resource_assigned"
  | "resolved";

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
  updatedAt: string;
}

export interface ResourceView {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
}

export interface StateView {
  tick: number;
  paused: boolean;
  /** false until the script starts via POST /api/control {action:"start"} */
  started: boolean;
  /** Simulated instant, ISO 8601 */
  simulationClock: string;
  /** Last seq emitted in the feed; correlates /api/state with /api/feed */
  lastSeq: number;
  elements: ElementView[];
  resources: ResourceView[];
}
