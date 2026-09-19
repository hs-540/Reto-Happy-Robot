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
  /** Simulated instant, ISO 8601 */
  simulationClock: string;
  /** Last seq emitted in the feed; correlates /api/state with /api/feed */
  lastSeq: number;
  elements: ElementView[];
  resources: ResourceView[];
}
