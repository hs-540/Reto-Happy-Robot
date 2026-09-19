import type {
  ElementStatus,
  ElementType,
  ResourceStatus,
  ResourceType,
  SensorMetric,
} from "./index.js";
import rulesJson from "./rules.json" with { type: "json" };

/* ─── Catalog contract (rules.json is the single source of data) ─── */

export const BLOCKING_RULE_IDS = [
  "no-double-assignment",
  "hospital-power-priority",
  "hospital-power-deadline",
  "critical-ups-act",
  "generator-without-fuel",
] as const;

export type BlockingRuleId = (typeof BLOCKING_RULE_IDS)[number];

export interface BlockingRule {
  id: BlockingRuleId;
  rule: string;
}

export interface MetricThresholds {
  /** "low": the lower the value the worse (e.g. ups_load). "high": the higher the worse (e.g. temperature) */
  direction: "low" | "high";
  /** entry cut into `degraded` (inclusive) */
  degraded: number;
  /** entry cut into `critical` (inclusive) */
  critical: number;
}

export interface RulesCatalog {
  severity: { degradedThreshold: number; criticalThreshold: number };
  resolution: { stableSeconds: number; stableVoltage: number };
  metricThresholds: Record<SensorMetric, MetricThresholds>;
  maxMinutesWithoutPower: Record<ElementType, number>;
  ups: { act: number; emergency: number; criticalBattery: number };
  resources: { capacity: Record<ResourceType, number> };
  priority: {
    typeOrder: readonly ElementType[];
    criticalityWeight: number;
    statusWeight: Record<ElementStatus, number>;
    typeWeight: Record<ElementType, number>;
    minuteWithoutPowerWeight: number;
    maxCountedMinutes: number;
  };
  blockingRules: readonly BlockingRule[];
  replanTriggers: readonly string[];
}

/* ─── Validation on load: fail fast if the JSON is edited incorrectly ─── */

const ELEMENT_TYPES: readonly ElementType[] = [
  "datacenter",
  "hospital",
  "substation",
  "tower",
  "fuel_station",
  "junction",
];
const RESOURCE_TYPES: readonly ResourceType[] = ["crew", "generator", "tanker", "police"];
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
const STATUSES: readonly ElementStatus[] = ["normal", "degraded", "critical", "resolved"];

function assertNumericRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const invalid = keys.filter(
    (k) => !(k in record) || typeof record[k] !== "number" || !Number.isFinite(record[k]),
  );
  if (invalid.length > 0) {
    throw new Error(`rules.json: invalid or missing numeric keys in ${field}: ${invalid.join(", ")}`);
  }
}

function assertRules(r: RulesCatalog): void {
  assertNumericRecord(r.maxMinutesWithoutPower, ELEMENT_TYPES, "maxMinutesWithoutPower");
  assertNumericRecord(r.priority.typeWeight, ELEMENT_TYPES, "priority.typeWeight");
  assertNumericRecord(r.priority.statusWeight, STATUSES, "priority.statusWeight");
  assertNumericRecord(r.resources.capacity, RESOURCE_TYPES, "resources.capacity");
  assertNumericRecord(r.severity, ["degradedThreshold", "criticalThreshold"], "severity");
  assertNumericRecord(r.ups, ["act", "emergency", "criticalBattery"], "ups");
  if (r.severity.degradedThreshold >= r.severity.criticalThreshold) {
    throw new Error("rules.json: degradedThreshold must be lower than criticalThreshold");
  }
  for (const metric of METRICS) {
    const t = r.metricThresholds[metric] as unknown as Record<string, unknown>;
    if (
      !t ||
      (t.direction !== "low" && t.direction !== "high") ||
      typeof t.degraded !== "number" ||
      typeof t.critical !== "number"
    ) {
      throw new Error(`rules.json: metricThresholds.${metric} is invalid`);
    }
  }
  const ids = r.blockingRules.map((b) => b.id);
  const unknown = ids.filter((id) => !BLOCKING_RULE_IDS.includes(id));
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (unknown.length > 0 || duplicated.length > 0) {
    throw new Error(
      `rules.json: blockingRules with unknown ids (${unknown.join(", ")}) or duplicates (${duplicated.join(", ")})`,
    );
  }
}

export const AGENT_RULES: RulesCatalog = rulesJson as unknown as RulesCatalog;
assertRules(AGENT_RULES);

/* ─── Constants derived from the catalog (consumed by the engine and the agent) ─── */

export const DEGRADED_THRESHOLD = AGENT_RULES.severity.degradedThreshold;
export const CRITICAL_THRESHOLD = AGENT_RULES.severity.criticalThreshold;

export const RESOLVED_STABLE_SECONDS = AGENT_RULES.resolution.stableSeconds;
export const RESOLVED_STABLE_VOLTAGE = AGENT_RULES.resolution.stableVoltage;

export const MAX_MINUTES_WITHOUT_POWER: Record<ElementType, number> =
  AGENT_RULES.maxMinutesWithoutPower;

export const UPS_ACT_THRESHOLD = AGENT_RULES.ups.act;
export const CRITICAL_BATTERY_THRESHOLD = AGENT_RULES.ups.criticalBattery;

/** Litres below which a generator cannot be deployed without refuelling first */
export const CRITICAL_FUEL_THRESHOLD = AGENT_RULES.metricThresholds.fuel.critical;

export const METRIC_THRESHOLDS: Record<SensorMetric, MetricThresholds> =
  AGENT_RULES.metricThresholds;

export const RESOURCE_CAPACITY: Record<ResourceType, number> =
  AGENT_RULES.resources.capacity;

export const PRIORITY_ORDER: readonly ElementType[] = AGENT_RULES.priority.typeOrder;

export const REPLAN_TRIGGERS: readonly string[] = AGENT_RULES.replanTriggers;

export const BLOCKING_RULES: readonly BlockingRule[] =
  AGENT_RULES.blockingRules;

/* ─── Numeric priority: weights from the catalog, same formula documented in RULES.md ─── */

export interface PriorityElement {
  type: ElementType;
  status: ElementStatus;
  /** 0-100, business impact of losing the element */
  criticality: number;
  /** seconds without grid power or reliable backup */
  secondsWithoutPower: number;
}

export function calculatePriority(e: PriorityElement): number {
  const p = AGENT_RULES.priority;
  const minutes = Math.min(Math.max(e.secondsWithoutPower, 0) / 60, p.maxCountedMinutes);
  const score =
    p.criticalityWeight * e.criticality +
    p.statusWeight[e.status] +
    p.typeWeight[e.type] +
    p.minuteWithoutPowerWeight * minutes;
  return Math.round(score * 10) / 10;
}

/* ─── Status derivation ─── */

const STATUS_RANK = ["normal", "degraded", "critical"] as const;

type StatusWithoutResolved = Extract<ElementStatus, (typeof STATUS_RANK)[number]>;

function worstStatus(a: StatusWithoutResolved, b: StatusWithoutResolved): StatusWithoutResolved {
  return STATUS_RANK.indexOf(a) >= STATUS_RANK.indexOf(b) ? a : b;
}

export function deriveStatus(severity: number): StatusWithoutResolved {
  if (severity >= CRITICAL_THRESHOLD) return "critical";
  if (severity >= DEGRADED_THRESHOLD) return "degraded";
  return "normal";
}

export function deriveMetricStatus(
  metric: SensorMetric,
  value: number,
): StatusWithoutResolved {
  const thresholds = METRIC_THRESHOLDS[metric];
  const critical =
    thresholds.direction === "low" ? value <= thresholds.critical : value >= thresholds.critical;
  const degraded =
    thresholds.direction === "low" ? value <= thresholds.degraded : value >= thresholds.degraded;
  if (critical) return "critical";
  if (degraded) return "degraded";
  return "normal";
}

/** final status of an element: the worst between the last event's severity and its raw metrics */
export function deriveElementStatus(
  severity: number,
  metrics: Partial<Record<SensorMetric, number>>,
): StatusWithoutResolved {
  let status = deriveStatus(severity);
  for (const [metric, value] of Object.entries(metrics) as [SensorMetric, number][]) {
    status = worstStatus(status, deriveMetricStatus(metric, value));
  }
  return status;
}

/* ─── Action validation against the blocking rules ─── */

/**
 * Resources that can cover a hospital's power need and therefore compete with
 * it. The hospital priority and deadline rules apply only to these: a crew
 * repairing the root cause or a patrol regulating a junction is no substitute
 * for a generator, and blocking them paralyses the agent while giving the
 * hospital nothing in return.
 */
const RESOURCES_COMPETING_WITH_HOSPITAL: readonly ResourceType[] = ["generator", "tanker"];

export type EngineActionType = "contact" | "assign_resource" | "wait";

export interface ActionAttempt {
  type: EngineActionType;
  elementId: string;
  /** required if type === "assign_resource" */
  resourceId?: string;
}

export interface ValidatableElement {
  id: string;
  type: ElementType;
  status: ElementStatus;
  metrics: Partial<Record<SensorMetric, number>>;
  /** seconds without grid power or reliable backup (0 if powered) */
  secondsWithoutPower: number;
}

export interface ValidatableResource {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
}

export interface ValidationContext {
  elements: ValidatableElement[];
  resources: ValidatableResource[];
}

export type ValidationResult =
  | { allowed: true }
  | { allowed: false; rule: BlockingRuleId; reason: string };

/**
 * Validates a proposed action against the blocking rules.
 * `contact` is never blocked (communicating consumes no physical resources).
 */
export function validateAction(
  attempt: ActionAttempt,
  context: ValidationContext,
): ValidationResult {
  if (attempt.type === "contact") return { allowed: true };

  const elementsById = new Map(context.elements.map((e) => [e.id, e]));
  const hospitalsAtRisk = context.elements.filter(
    (e) =>
      e.type === "hospital" &&
      e.status === "critical" &&
      e.secondsWithoutPower > 0 &&
      !context.resources.some(
        (r) => r.type === "generator" && r.assignedElementId === e.id,
      ),
  );
  const hospitalPastDeadline = context.elements.find(
    (e) =>
      e.type === "hospital" &&
      e.secondsWithoutPower > MAX_MINUTES_WITHOUT_POWER.hospital * 60,
  );

  if (attempt.type === "assign_resource") {
    if (!attempt.resourceId) {
      return {
        allowed: false,
        rule: "no-double-assignment",
        reason: "assign_resource requires resourceId",
      };
    }
    const resource = context.resources.find((r) => r.id === attempt.resourceId);
    if (!resource) {
      return {
        allowed: false,
        rule: "no-double-assignment",
        reason: `nonexistent resource: ${attempt.resourceId}`,
      };
    }
    if (resource.status !== "available") {
      return {
        allowed: false,
        rule: "no-double-assignment",
        reason: `${resource.id} is not available (status ${resource.status}); release it before reassigning`,
      };
    }
    const target = elementsById.get(attempt.elementId);
    if (target && resource.type === "generator" && target.type !== "hospital") {
      const hospitalAtRisk = hospitalsAtRisk[0];
      if (hospitalAtRisk) {
        return {
          allowed: false,
          rule: "hospital-power-priority",
          reason: `${hospitalAtRisk.id} is critical without power backup: generators can only go to it`,
        };
      }
    }
    // generator-without-fuel: deploying a dry generator wastes the journey
    if (resource.type === "generator") {
      const fuel = target?.metrics.fuel;
      if (fuel !== undefined && fuel <= CRITICAL_FUEL_THRESHOLD) {
        return {
          allowed: false,
          rule: "generator-without-fuel",
          reason: `${target?.id} reports fuel ${fuel} (threshold ${CRITICAL_FUEL_THRESHOLD}): refuel with the tanker before deploying a generator`,
        };
      }
    }
    const competes = RESOURCES_COMPETING_WITH_HOSPITAL.includes(resource.type);
    if (competes && hospitalPastDeadline && target && target.id !== hospitalPastDeadline.id) {
      const validTarget =
        target.type === "substation" && target.status === "critical";
      if (!validTarget) {
        return {
          allowed: false,
          rule: "hospital-power-deadline",
          reason: `${hospitalPastDeadline.id} has been ${Math.floor(hospitalPastDeadline.secondsWithoutPower / 60)} min without power (limit ${MAX_MINUTES_WITHOUT_POWER.hospital}): only acting on it or on the origin substation is allowed`,
        };
      }
    }
    return { allowed: true };
  }

  // type === "wait"
  const target = elementsById.get(attempt.elementId);
  if (hospitalPastDeadline && target && target.id !== hospitalPastDeadline.id) {
    return {
      allowed: false,
      rule: "hospital-power-deadline",
      reason: `${hospitalPastDeadline.id} has been ${Math.floor(hospitalPastDeadline.secondsWithoutPower / 60)} min without power (limit ${MAX_MINUTES_WITHOUT_POWER.hospital}): waiting on ${target.id} is not allowed`,
    };
  }
  const upsLoad = target?.metrics.ups_load;
  if (target && upsLoad !== undefined && upsLoad < UPS_ACT_THRESHOLD) {
    return {
      allowed: false,
      rule: "critical-ups-act",
      reason: `${target.id} with ups_load ${upsLoad}% < ${UPS_ACT_THRESHOLD}%: waiting is forbidden, a resource must be assigned or the issue escalated (hist-dc-002)`,
    };
  }
  return { allowed: true };
}
