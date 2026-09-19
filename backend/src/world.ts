import type {
  SensorMetric,
  ValidationContext,
  ElementView,
  ValidatableElement,
  ValidatableResource,
  RepairEstimate,
  ResourceView,
} from "@swarmup/shared";
import {
  MAX_MINUTES_WITHOUT_POWER,
  CRITICAL_BATTERY_THRESHOLD,
  UPS_ACT_THRESHOLD,
  calculatePriority,
  deriveMetricStatus,
} from "@swarmup/shared";
import { dependentsOf } from "@swarmup/shared";
import type { LatLng, Remedies, RoadNetwork, Topology } from "@swarmup/shared";
import { createRoadRouter } from "@swarmup/shared";
import type { ScriptElement, ScriptResource } from "./script.js";

/** Movement speed of crews and generators, simulated km/min */
const SPEED_KM_MIN = 0.5;

/** Minimum ETA: even with the resource already on site, deployment takes time */
const MIN_ETA_SECONDS = 60;

/** Journey multiplier while the junction is unregulated */
const TRAFFIC_PENALTY = 2;

/** Minutes of delay above which the area counts as gridlocked */
const HIGH_CONGESTION = 10;

/** Severity a site settles at once its remedy has fully taken hold */
const RESOLVED_SEVERITY = 5;

/** How often, in crisis seconds, a recovery step is emitted */
const RECOVERY_STEP_SECONDS = 60;

/**
 * With the grid back, a site does not stay frozen at its worst reading:
 * batteries recharge, the datacenter cools and the jam clears. Each metric
 * converges toward its healthy value at this rate, per crisis minute. `fuel` is
 * deliberately absent: a tank does not refill itself, that needs the tanker.
 */
const RECOVERY: Partial<Record<SensorMetric, { target: number; rate: number }>> = {
  tower_battery: { target: 95, rate: 12 },
  generator_battery: { target: 95, rate: 10 },
  ups_load: { target: 95, rate: 15 },
  temperature: { target: 22, rate: 6 },
  congestion: { target: 3, rate: 8 },
};

/** Voltage above which a site counts as having grid power again */
const VOLTAGE_WITH_GRID = 90;

/**
 * World changes the agent must observe. The first three are replan triggers
 * (RULES.md §7); `arrival` is incremental adjustment.
 */
export type WorldEvent =
  | { type: "arrival"; resourceId: string; elementId: string }
  | { type: "eta_missed"; resourceId: string; elementId: string; delaySeconds: number }
  | { type: "deadline_exceeded"; elementId: string; minutesWithoutPower: number }
  /**
   * A remedy has finished taking hold. It carries the readings the real world
   * would now report: the simulation applies them as if a sensor had sent them,
   * so the effect of an agent action is indistinguishable from reality.
   */
  | {
      type: "remedy_applied";
      elementId: string;
      resourceId: string;
      metric: SensorMetric;
      value: number;
      severity: number;
      effect: string;
    }
  /** With the grid back, one of a site's own metrics steps toward healthy */
  | {
      type: "recovery";
      elementId: string;
      metric: SensorMetric;
      value: number;
      severity: number;
    }
  /**
   * The site no longer needs the resource, which goes back to `available`.
   * Capacity the agent did not have a moment ago: without this the whole fleet
   * ends a run pinned to sites that were fixed ten minutes earlier.
   */
  | { type: "released"; resourceId: string; elementId: string; reason: string };

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
  /** Road polyline being followed: origin, street vertices, destination */
  route: LatLng[];
  /** Accumulated km at each route waypoint (parallel to `route`) */
  cumulativeKm: number[];
  /** Total length of the route polyline in km */
  routeKm: number;
  /** Simulated second the route started */
  departedAt: number | null;
  /** Total route duration, including injected delays */
  etaSeconds: number;
  /** `eta_missed` was already emitted for this route */
  delayReported: boolean;
  /** Simulated second it reached its destination; null if it has not */
  arrivedAt: number | null;
  /** `remedy_applied` was already emitted for this assignment */
  remedyApplied: boolean;
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
  /**
   * Countdown to `elementId` being fixed, in crisis seconds. Reads the same
   * route and remedy state `advance` acts on, so the number and the event that
   * eventually fires cannot drift apart. `null` when nothing is on its way.
   */
  repairEstimate(elementId: string, seconds: number): RepairEstimate | null;
  /** Accumulated seconds without grid power or reliable backup, by elementId */
  secondsWithoutPower(elementId: string): number;
  /** Context consumed by `validateAction` from shared/rules */
  context(elements: ElementView[]): ValidationContext;
  /** Elements sorted by `calculatePriority`, from most to least urgent */
  priorities(elements: ElementView[]): { elementId: string; score: number }[];
}

/** Approximate distance in km. At municipal scale the flat approximation is plenty. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/** Cumulative km at every waypoint of the polyline */
function cumulativeKmOf(points: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceKm(points[i - 1], points[i]));
  return cum;
}

export function createWorld(
  script: { elements: ScriptElement[]; resources: ScriptResource[] },
  remedies: Remedies,
  topology: Topology,
  roads?: RoadNetwork,
): World {
  /** Street-following navigation; null falls back to straight-line journeys */
  const router = roads ? createRoadRouter(roads) : null;
  const typeOf = new Map(script.elements.map((e) => [e.id, e.type]));
  const criticality = new Map(script.elements.map((e) => [e.id, e.criticality]));
  const coordinates = new Map(script.elements.map((e) => [e.id, { lat: e.lat, lng: e.lng }]));

  const resources = new Map<string, ResourceState>();
  /** accumulated seconds without power, per element */
  const withoutPower = new Map<string, number>();
  /** this element exceeding its deadline was already reported */
  const deadlineReported = new Set<string>();
  /** events emitted outside the tick; the next `advance` drains them */
  const pending: WorldEvent[] = [];
  /** last second a recovery step was emitted, per element */
  const lastRecovery = new Map<string, number>();
  /** the junction is gridlocked and nobody is directing it */
  let highCongestion = false;
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
        route: [],
        cumulativeKm: [0],
        routeKm: 0,
        departedAt: null,
        etaSeconds: 0,
        delayReported: false,
        arrivedAt: null,
        remedyApplied: false,
      });
    }
    withoutPower.clear();
    for (const e of script.elements) withoutPower.set(e.id, 0);
    deadlineReported.clear();
    lastRecovery.clear();
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

  /** Reading a site starts reporting once its remedy has completed */
  const HEALTHY_METRIC: Record<string, { metric: SensorMetric; value: number }> = {
    substation: { metric: "grid_voltage", value: 98 },
    hospital: { metric: "generator_battery", value: 95 },
    datacenter: { metric: "ups_load", value: 90 },
    tower: { metric: "tower_battery", value: 85 },
    fuel_station: { metric: "grid_voltage", value: 96 },
    junction: { metric: "congestion", value: 3 },
  };

  /** The remedy `resource` offers for a site of `elementType`, if any */
  function remedyFor(resource: string, elementType: string) {
    return remedies.remedies.find(
      (r) => r.resource === resource && (r.appliesTo as readonly string[]).includes(elementType),
    );
  }

  /**
   * What the resource committed to `elementId` still needs to finish its remedy.
   * A resource sent somewhere its remedy does not apply gets no countdown: it is
   * not fixing anything, and a counter ticking down to nothing would be a lie.
   */
  function directRepair(elementId: string, seconds: number): RepairEstimate | null {
    const elementType = typeOf.get(elementId);
    if (!elementType) return null;

    for (const r of resources.values()) {
      if (r.assignedElementId !== elementId) continue;
      if (r.status !== "in_transit" && r.status !== "assigned") continue;
      const remedy = remedyFor(r.type, elementType);
      if (!remedy) continue;

      const base = { resourceId: r.id, viaElementId: elementId };
      if (r.remedyApplied) {
        return { ...base, travelSeconds: 0, workSeconds: 0, totalSeconds: 0 };
      }

      const travel =
        r.status === "in_transit" && r.departedAt !== null
          ? Math.max(r.etaSeconds - (seconds - r.departedAt), 0)
          : 0;
      const work =
        r.status === "assigned" && r.arrivedAt !== null
          ? Math.max(remedy.minutes * 60 - (seconds - r.arrivedAt), 0)
          : remedy.minutes * 60;

      return {
        ...base,
        travelSeconds: Math.round(travel),
        workSeconds: Math.round(work),
        totalSeconds: Math.round(travel + work),
      };
    }
    return null;
  }

  /** With the junction unregulated, every journey takes twice as long */
  function trafficPenalised(): boolean {
    const directed = [...resources.values()].some(
      (r) => r.type === "police" && r.status === "assigned",
    );
    return directed ? false : highCongestion;
  }

  /**
   * Frees the resource in place: it keeps the coordinates it has reached, so a
   * resource that stands down mid-route does it where it is rather than
   * teleporting back to base.
   */
  function standDown(r: ResourceState): void {
    r.status = "available";
    r.assignedElementId = null;
    r.origin = null;
    r.destination = null;
    r.route = [];
    r.cumulativeKm = [0];
    r.routeKm = 0;
    r.departedAt = null;
    r.etaSeconds = 0;
    r.delayReported = false;
    r.arrivedAt = null;
    r.remedyApplied = false;
  }

  /**
   * Position at `seconds` while following the route polyline: the travelled
   * fraction of the ETA maps to the same fraction of the road length, so the
   * resource hugs the streets instead of sliding over blocks.
   */
  function positionOnRoute(r: ResourceState, seconds: number): { lat: number; lng: number } {
    if (r.route.length < 2 || r.departedAt === null || r.etaSeconds <= 0) {
      return { lat: r.lat, lng: r.lng };
    }
    const progress = Math.min((seconds - r.departedAt) / r.etaSeconds, 1);
    const targetKm = progress * r.routeKm;
    const cum = r.cumulativeKm;
    const last = r.route.length - 1;
    if (targetKm >= cum[last]) return r.route[last];

    let i = 1;
    while (i < last && cum[i] < targetKm) i++;
    const segment = cum[i] - cum[i - 1];
    const t = segment > 0 ? (targetKm - cum[i - 1]) / segment : 0;
    const a = r.route[i - 1];
    const b = r.route[i];
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    };
  }

  return {
    advance(seconds: number, elements: ElementView[]): WorldEvent[] {
      const delta = Math.max(seconds - lastSecond, 0);
      lastSecond = seconds;
      const events: WorldEvent[] = pending.splice(0, pending.length);

      // the junction reports whether the area is gridlocked; police neutralise it
      const junction = elements.find((e) => e.type === "junction");
      highCongestion =
        junction !== undefined && (junction.sensors.congestion ?? 0) >= HIGH_CONGESTION;

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
          r.route = [];
          r.cumulativeKm = [0];
          r.routeKm = 0;
          r.departedAt = null;
          r.arrivedAt = seconds;
          events.push({
            type: "arrival",
            resourceId: r.id,
            elementId: r.assignedElementId ?? "",
          });
        }
      }

      // A deployed resource takes its remedy's declared minutes to take hold.
      // Once that time is up the site reports healthy readings: an agent action
      // changes the world exactly as it would in reality.
      for (const r of resources.values()) {
        if (r.status !== "assigned" || r.arrivedAt === null || r.remedyApplied) continue;
        const targetId = r.assignedElementId;
        if (!targetId) continue;
        const elementType = typeOf.get(targetId);
        if (!elementType) continue;
        const remedy = remedyFor(r.type, elementType);
        if (!remedy) continue;
        if (seconds - r.arrivedAt < remedy.minutes * 60) continue;

        r.remedyApplied = true;
        const healthy = HEALTHY_METRIC[elementType];
        if (healthy) {
          events.push({
            type: "remedy_applied",
            elementId: targetId,
            resourceId: r.id,
            metric: healthy.metric,
            value: healthy.value,
            severity: RESOLVED_SEVERITY,
            effect: remedy.effect,
          });
        }
        // supplies: repairing a node returns the grid to everything below it
        for (const dependent of dependentsOf(topology, targetId)) {
          if (!typeOf.has(dependent)) continue;
          events.push({
            type: "remedy_applied",
            elementId: dependent,
            resourceId: r.id,
            metric: "grid_voltage",
            value: 96,
            severity: RESOLVED_SEVERITY,
            effect: `Grid restored by the repair of ${targetId}`,
          });
        }
      }

      // A resource whose site no longer needs it goes back to the pool. Runs
      // after the remedy loop on purpose: the remedy has to take hold on this
      // same tick before the release is even considered, or a one-shot job is
      // judged unfinished for a whole extra tick.
      for (const r of resources.values()) {
        if (r.status === "available") continue;
        const targetId = r.assignedElementId;
        if (!targetId) continue;
        const elementType = typeOf.get(targetId);
        if (!elementType) continue;
        const remedy = remedyFor(r.type, elementType);
        if (!remedy) continue;

        if (!remedy.sustains) {
          // One-shot: it does the job and leaves. Still in transit it has not
          // even started, so only `remedyApplied` frees it.
          if (r.status !== "assigned" || !r.remedyApplied) continue;
          standDown(r);
          events.push({
            type: "released",
            resourceId: r.id,
            elementId: targetId,
            reason: `its work at ${targetId} is finished`,
          });
          continue;
        }

        // Sustaining: the resource IS the missing service while it sits there,
        // so letting it go early puts the site straight back where it started.
        // Only the site no longer needing it frees it — and a resource still en
        // route stands down where it is instead of finishing a pointless trip.
        const element = elements.find((e) => e.id === targetId);
        if (!element) continue;
        const voltage = element.sensors.grid_voltage;
        // Missing data is not evidence of a fix: without a voltage reading we
        // keep the resource in place rather than gamble the site's supply.
        const gridBack = voltage !== undefined && voltage >= VOLTAGE_WITH_GRID;
        if (!gridBack && element.status !== "resolved") continue;
        standDown(r);
        events.push({
          type: "released",
          resourceId: r.id,
          elementId: targetId,
          reason: gridBack ? `${targetId} has grid power again` : `${targetId} is resolved`,
        });
      }

      // With the grid back, a site's own metrics stop being frozen at their
      // worst reading and converge toward healthy. Without this the demo ends
      // with three sites in red even though the agent solved everything.
      for (const e of elements) {
        const voltage = e.sensors.grid_voltage;
        if (voltage === undefined || voltage < VOLTAGE_WITH_GRID) continue;
        const since = lastRecovery.get(e.id) ?? -Infinity;
        if (seconds - since < RECOVERY_STEP_SECONDS) continue;

        let emitted = false;
        for (const [key, cfg] of Object.entries(RECOVERY)) {
          const metric = key as SensorMetric;
          const current = e.sensors[metric];
          if (current === undefined || current === cfg.target) continue;
          const next =
            cfg.target > current
              ? Math.min(current + cfg.rate, cfg.target)
              : Math.max(current - cfg.rate, cfg.target);
          const remaining = Math.abs(cfg.target - next) / Math.abs(cfg.target || 1);
          events.push({
            type: "recovery",
            elementId: e.id,
            metric,
            value: Math.round(next),
            severity: Math.round(Math.min(remaining * 100, 25)),
          });
          emitted = true;
        }
        if (emitted) lastRecovery.set(e.id, seconds);
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

      // A resource whose declared remedy does not cover this kind of site cannot
      // be sent there: it would arrive, apply nothing and sit `assigned` forever
      // (the release loop skips a resource with no remedy). The remedies catalog
      // is the source of truth, not the agent's prose.
      const elementType = typeOf.get(elementId);
      if (elementType && !remedyFor(r.type, elementType)) {
        return {
          ok: false,
          reason: `${r.type} has no remedy for ${elementId} (${elementType}): check the remedies catalog`,
        };
      }

      // Real navigation: shortest path over the street network, with the
      // journey distance measured along the roads, not over the blocks
      const origin: LatLng = { lat: r.lat, lng: r.lng };
      const roadRoute = router?.route(origin, destination) ?? null;
      const waypoints: LatLng[] = roadRoute?.waypoints ?? [origin, destination];
      const cum = cumulativeKmOf(waypoints);
      const km = cum[cum.length - 1];

      const base = Math.max(Math.round((km / SPEED_KM_MIN) * 60), MIN_ETA_SECONDS);
      // enables_transit: without the junction directed, moving costs double
      const eta = trafficPenalised() ? base * TRAFFIC_PENALTY : base;

      r.status = "in_transit";
      r.assignedElementId = elementId;
      r.origin = { lat: r.lat, lng: r.lng };
      r.destination = destination;
      r.route = waypoints;
      r.cumulativeKm = cum;
      r.routeKm = km;
      r.departedAt = seconds;
      r.etaSeconds = eta;
      r.delayReported = false;
      r.arrivedAt = null;
      r.remedyApplied = false;

      return { ok: true, etaSeconds: eta };
    },

    release(resourceId: string): void {
      const r = resources.get(resourceId);
      if (!r) return;
      standDown(r);
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
        ...(r.status === "in_transit" && r.route.length >= 2 ? { route: r.route } : {}),
      }));
    },

    repairEstimate(elementId: string, seconds: number): RepairEstimate | null {
      const own = directRepair(elementId, seconds);
      if (own) return own;

      // Nothing committed here, but repairing an upstream node hands the grid
      // back to everything below it — `advance` emits a `remedy_applied` for
      // every dependent. That repair IS this site's countdown, and saying so is
      // what makes the coverage argument visible: one crew, five sites.
      let inherited: RepairEstimate | null = null;
      for (const e of script.elements) {
        if (e.id === elementId) continue;
        if (!dependentsOf(topology, e.id).includes(elementId)) continue;
        const upstream = directRepair(e.id, seconds);
        if (upstream && (!inherited || upstream.totalSeconds < inherited.totalSeconds)) {
          inherited = upstream;
        }
      }
      return inherited;
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
