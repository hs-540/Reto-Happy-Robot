import type {
  ValidationContext,
  ElementView,
  ValidatableElement,
  ValidatableResource,
  ResourceView,
} from "@swarmup/shared";
import {
  MAX_MINUTES_WITHOUT_POWER,
  CRITICAL_BATTERY_THRESHOLD,
  UPS_ACT_THRESHOLD,
  calculatePriority,
  deriveMetricStatus,
} from "@swarmup/shared";
import type { ScriptElement, ScriptResource } from "./script.js";

/** Movement speed of crews and generators, simulated km/min */
const SPEED_KM_MIN = 1.5;

/** Minimum ETA: even with the resource already on site, deployment takes time */
const MIN_ETA_SECONDS = 15;

/**
 * World changes the agent must observe. The first three are replan triggers
 * (RULES.md §7); `arrival` is incremental adjustment.
 */
export type WorldEvent =
  | { type: "arrival"; resourceId: string; elementId: string }
  | { type: "eta_missed"; resourceId: string; elementId: string; delaySeconds: number }
  | { type: "deadline_exceeded"; elementId: string; minutesWithoutPower: number };

export type AssignmentResult =
  | { ok: true; etaSeconds: number }
  | { ok: false; reason: string };

interface ResourceState {
  id: string;
  type: ScriptResource["type"];
  status: ResourceView["status"];
  assignedElementId: string | null;
  lat: number;
  lng: number;
  /** Starting point of the current route */
  origin: { lat: number; lng: number } | null;
  destination: { lat: number; lng: number } | null;
  /** Simulated second the route started */
  departedAt: number | null;
  /** Total route duration, including injected delays */
  etaSeconds: number;
  /** `eta_missed` was already emitted for this route */
  delayReported: boolean;
}

export interface World {
  /**
   * Advances the world to the given simulated second and returns what changed.
   * `elements` is the snapshot the sensor simulation produces on this tick.
   */
  advance(seconds: number, elements: ElementView[]): WorldEvent[];
  assign(resourceId: string, elementId: string, seconds: number): AssignmentResult;
  release(resourceId: string): void;
  /**
   * Delays the route in progress; feeds moment 4 of the script. The replan
   * trigger comes out of the next `advance`. No effect if the resource is not
   * en route or this delay was already reported.
   */
  delay(resourceId: string, extraSeconds: number): void;
  /** Back to the initial script state (called by `simulation.reset`) */
  reset(): void;
  resources(): ResourceView[];
  /** Accumulated seconds without grid power or reliable backup, by elementId */
  secondsWithoutPower(elementId: string): number;
  /** Context consumed by `validateAction` from shared/rules */
  context(elements: ElementView[]): ValidationContext;
  /** Elements sorted by `calculatePriority`, from most to least urgent */
  priorities(elements: ElementView[]): { elementId: string; score: number }[];
}

/** Approximate distance in km. At municipal scale the flat approximation is plenty. */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

export function createWorld(script: {
  elements: ScriptElement[];
  resources: ScriptResource[];
}): World {
  const criticality = new Map(script.elements.map((e) => [e.id, e.criticality]));
  const coordinates = new Map(script.elements.map((e) => [e.id, { lat: e.lat, lng: e.lng }]));

  const resources = new Map<string, ResourceState>();
  /** accumulated seconds without power, per element */
  const withoutPower = new Map<string, number>();
  /** this element exceeding its deadline was already reported */
  const deadlineReported = new Set<string>();
  /** events emitted outside the tick; the next `advance` drains them */
  const pending: WorldEvent[] = [];
  let lastSecond = 0;

  function seed(): void {
    resources.clear();
    for (const r of script.resources) {
      resources.set(r.id, {
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
        lat: r.lat,
        lng: r.lng,
        origin: null,
        destination: null,
        departedAt: null,
        etaSeconds: 0,
        delayReported: false,
      });
    }
    withoutPower.clear();
    for (const e of script.elements) withoutPower.set(e.id, 0);
    deadlineReported.clear();
    pending.length = 0;
    lastSecond = 0;
  }
  seed();

  /**
   * "Without power" = grid down and no reliable backup (RULES.md §3).
   * Reliable backup: our generator already deployed, or own reserve above the
   * act threshold. Without a voltage reading we assume supply: we do not invent
   * a crisis out of missing data.
   */
  function isWithoutPower(e: ElementView): boolean {
    const voltage = e.sensors.grid_voltage;
    if (voltage === undefined) return false;
    if (deriveMetricStatus("grid_voltage", voltage) !== "critical") return false;

    for (const r of resources.values()) {
      if (r.type === "generator" && r.assignedElementId === e.id && r.status === "assigned") {
        return false;
      }
    }

    const ups = e.sensors.ups_load;
    if (ups !== undefined && ups > UPS_ACT_THRESHOLD) return false;
    const battery = e.sensors.generator_battery;
    if (battery !== undefined && battery > CRITICAL_BATTERY_THRESHOLD) return false;

    return true;
  }

  function positionOnRoute(r: ResourceState, seconds: number): { lat: number; lng: number } {
    if (!r.origin || !r.destination || r.departedAt === null || r.etaSeconds <= 0) {
      return { lat: r.lat, lng: r.lng };
    }
    const progress = Math.min((seconds - r.departedAt) / r.etaSeconds, 1);
    return {
      lat: r.origin.lat + (r.destination.lat - r.origin.lat) * progress,
      lng: r.origin.lng + (r.destination.lng - r.origin.lng) * progress,
    };
  }

  return {
    advance(seconds: number, elements: ElementView[]): WorldEvent[] {
      const delta = Math.max(seconds - lastSecond, 0);
      lastSecond = seconds;
      const events: WorldEvent[] = pending.splice(0, pending.length);

      for (const e of elements) {
        if (isWithoutPower(e)) {
          const accumulated = (withoutPower.get(e.id) ?? 0) + delta;
          withoutPower.set(e.id, accumulated);
          const limitSeconds = MAX_MINUTES_WITHOUT_POWER[e.type] * 60;
          if (accumulated > limitSeconds && !deadlineReported.has(e.id)) {
            deadlineReported.add(e.id);
            events.push({
              type: "deadline_exceeded",
              elementId: e.id,
              minutesWithoutPower: Math.floor(accumulated / 60),
            });
          }
        } else {
          // supply was restored: the counter and the warning reset
          withoutPower.set(e.id, 0);
          deadlineReported.delete(e.id);
        }
      }

      for (const r of resources.values()) {
        if (r.status !== "in_transit" || r.departedAt === null) continue;
        const pos = positionOnRoute(r, seconds);
        r.lat = pos.lat;
        r.lng = pos.lng;
        if (seconds - r.departedAt >= r.etaSeconds) {
          r.status = "assigned";
          r.origin = null;
          r.destination = null;
          r.departedAt = null;
          events.push({
            type: "arrival",
            resourceId: r.id,
            elementId: r.assignedElementId ?? "",
          });
        }
      }

      return events;
    },

    assign(resourceId: string, elementId: string, seconds: number): AssignmentResult {
      const r = resources.get(resourceId);
      if (!r) return { ok: false, reason: `nonexistent resource: ${resourceId}` };
      if (r.status !== "available") {
        return { ok: false, reason: `${resourceId} is not available (status ${r.status})` };
      }
      const destination = coordinates.get(elementId);
      if (!destination) return { ok: false, reason: `nonexistent element: ${elementId}` };

      const km = distanceKm({ lat: r.lat, lng: r.lng }, destination);
      const eta = Math.max(Math.round((km / SPEED_KM_MIN) * 60), MIN_ETA_SECONDS);

      r.status = "in_transit";
      r.assignedElementId = elementId;
      r.origin = { lat: r.lat, lng: r.lng };
      r.destination = destination;
      r.departedAt = seconds;
      r.etaSeconds = eta;
      r.delayReported = false;

      return { ok: true, etaSeconds: eta };
    },

    release(resourceId: string): void {
      const r = resources.get(resourceId);
      if (!r) return;
      r.status = "available";
      r.assignedElementId = null;
      r.origin = null;
      r.destination = null;
      r.departedAt = null;
      r.etaSeconds = 0;
      r.delayReported = false;
    },

    delay(resourceId: string, extraSeconds: number): void {
      const r = resources.get(resourceId);
      if (!r || r.status !== "in_transit" || r.delayReported) return;
      r.etaSeconds += extraSeconds;
      r.delayReported = true;
      pending.push({
        type: "eta_missed",
        resourceId: r.id,
        elementId: r.assignedElementId ?? "",
        delaySeconds: extraSeconds,
      });
    },

    reset(): void {
      seed();
    },

    resources(): ResourceView[] {
      return [...resources.values()].map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
        lat: r.lat,
        lng: r.lng,
      }));
    },

    secondsWithoutPower(elementId: string): number {
      return withoutPower.get(elementId) ?? 0;
    },

    context(elements: ElementView[]): ValidationContext {
      const elementViews: ValidatableElement[] = elements.map((e) => ({
        id: e.id,
        type: e.type,
        status: e.status,
        metrics: e.sensors,
        secondsWithoutPower: withoutPower.get(e.id) ?? 0,
      }));
      const resourceViews: ValidatableResource[] = [...resources.values()].map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
      }));
      return { elements: elementViews, resources: resourceViews };
    },

    priorities(elements: ElementView[]): { elementId: string; score: number }[] {
      return elements
        .map((e) => ({
          elementId: e.id,
          score: calculatePriority({
            type: e.type,
            status: e.status,
            criticality: criticality.get(e.id) ?? 50,
            secondsWithoutPower: withoutPower.get(e.id) ?? 0,
          }),
        }))
        .sort((a, b) => b.score - a.score);
    },
  };
}
