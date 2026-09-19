import { readFileSync } from "node:fs";
import type {
  ElementType,
  ResourceStatus,
  ResourceType,
  SensorMetric,
  TopologyView,
} from "@swarmup/shared";

export interface ScriptSensorEvent {
  atSeconds: number;
  kind: "sensor_event";
  note?: string;
  payload: {
    id: string;
    elementId: string;
    metric: SensorMetric;
    value: number;
    severity: number;
  };
}

export interface ScriptReport {
  atSeconds: number;
  kind: "report";
  note?: string;
  payload: {
    id: string;
    source: "social" | "emergency_call" | "press" | "field" | "faulty_sensor";
    text: string;
    elementId: string | null;
  };
}

export interface ScriptNarrativeEvent {
  atSeconds: number;
  kind: "narrative";
  note?: string;
  payload: {
    resourceId?: string;
    event: string;
  };
}

export type ScriptEvent = ScriptSensorEvent | ScriptNarrativeEvent | ScriptReport;

export interface ScriptElement {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  criticality: number;
}

export interface ScriptResource {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
}

export interface Script {
  title: string;
  durationSeconds: number;
  elements: ScriptElement[];
  resources: ScriptResource[];
  timeline: ScriptEvent[];
}

const METRICS: readonly SensorMetric[] = [
  "temperature",
  "ups_load",
  "generator_battery",
  "network_coverage",
  "grid_voltage",
  "tower_battery",
  "fuel",
  "congestion",
];
const ELEMENT_TYPES: readonly ElementType[] = [
  "datacenter",
  "hospital",
  "substation",
  "tower",
  "fuel_station",
  "junction",
];
const RESOURCE_TYPES: readonly ResourceType[] = ["crew", "generator", "tanker", "police"];
const RESOURCE_STATUSES: readonly ResourceStatus[] = ["available", "in_transit", "assigned"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(rec: Record<string, unknown>, key: string, path: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`invalid script: ${path}.${key} must be a string`);
  return v;
}

function numberField(rec: Record<string, unknown>, key: string, path: string): number {
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`invalid script: ${path}.${key} must be a number`);
  }
  return v;
}

function optionalStringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`invalid script: ${key} must be a string`);
  return v;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new Error(`invalid script: ${path} must be one of ${values.join(", ")}`);
  }
  return v as T;
}

function arrayOf(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`invalid script: ${path} must be an array`);
  return v;
}

function validateElement(v: unknown, path: string): ScriptElement {
  if (!isRecord(v)) throw new Error(`invalid script: ${path} must be an object`);
  return {
    id: stringField(v, "id", path),
    type: oneOf(v.type, ELEMENT_TYPES, `${path}.type`),
    name: stringField(v, "name", path),
    lat: numberField(v, "lat", path),
    lng: numberField(v, "lng", path),
    criticality: numberField(v, "criticality", path),
  };
}

function validateResource(v: unknown, path: string): ScriptResource {
  if (!isRecord(v)) throw new Error(`invalid script: ${path} must be an object`);
  const assigned = v.assignedElementId;
  return {
    id: stringField(v, "id", path),
    type: oneOf(v.type, RESOURCE_TYPES, `${path}.type`),
    status: oneOf(v.status, RESOURCE_STATUSES, `${path}.status`),
    assignedElementId: assigned === null ? null : stringField(v, "assignedElementId", path),
    lat: numberField(v, "lat", path),
    lng: numberField(v, "lng", path),
  };
}

function validateEvent(v: unknown, path: string): ScriptEvent {
  if (!isRecord(v)) throw new Error(`invalid script: ${path} must be an object`);
  const atSeconds = numberField(v, "atSeconds", path);
  const note = optionalStringField(v, "note");
  const kind = oneOf(v.kind, ["sensor_event", "narrative", "report"], `${path}.kind`);
  const payload = v.payload;
  if (!isRecord(payload)) throw new Error(`invalid script: ${path}.payload must be an object`);
  if (kind === "sensor_event") {
    return {
      atSeconds,
      kind,
      note,
      payload: {
        id: stringField(payload, "id", `${path}.payload`),
        elementId: stringField(payload, "elementId", `${path}.payload`),
        metric: oneOf(payload.metric, METRICS, `${path}.payload.metric`),
        value: numberField(payload, "value", `${path}.payload`),
        severity: numberField(payload, "severity", `${path}.payload`),
      },
    };
  }
  if (kind === "report") {
    const elementId = payload.elementId;
    return {
      atSeconds,
      kind,
      note,
      payload: {
        id: stringField(payload, "id", `${path}.payload`),
        source: oneOf(
          payload.source,
          ["social", "emergency_call", "press", "field", "faulty_sensor"] as const,
          `${path}.payload.source`,
        ),
        text: stringField(payload, "text", `${path}.payload`),
        elementId: elementId === null ? null : stringField(payload, "elementId", `${path}.payload`),
      },
    };
  }
  return {
    atSeconds,
    kind,
    note,
    payload: {
      event: stringField(payload, "event", `${path}.payload`),
      resourceId: optionalStringField(payload, "resourceId"),
    },
  };
}

function validateScript(v: unknown): Script {
  if (!isRecord(v)) throw new Error("invalid script: must be an object");
  return {
    title: stringField(v, "title", "script"),
    durationSeconds: numberField(v, "durationSeconds", "script"),
    elements: arrayOf(v.elements, "script.elements").map((e, i) => validateElement(e, `elements[${i}]`)),
    resources: arrayOf(v.resources, "script.resources").map((r, i) => validateResource(r, `resources[${i}]`)),
    timeline: arrayOf(v.timeline, "script.timeline").map((e, i) => validateEvent(e, `timeline[${i}]`)),
  };
}

export function loadScript(url: URL): Script {
  return validateScript(JSON.parse(readFileSync(url, "utf8")));
}

export function toTopology(script: Script): TopologyView {
  return {
    crisis: {
      title: script.title,
      durationSeconds: script.durationSeconds,
      moments: script.timeline.flatMap((e) =>
        e.note === undefined ? [] : [{ atSeconds: e.atSeconds, title: e.note }],
      ),
    },
    elements: script.elements.map(({ id, type, name, lat, lng, criticality }) => ({
      id,
      type,
      name,
      lat,
      lng,
      criticality,
    })),
    resources: script.resources.map(({ id, type, lat, lng }) => ({ id, type, lat, lng })),
  };
}
