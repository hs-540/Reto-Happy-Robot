import type { Contact, ElementType, ResourceType, Topology } from "@swarmup/shared";
import { dependentsOf, loadRemedies, loadTopology } from "@swarmup/shared";
import { loadScript, type Script, type ScriptEvent, type ScriptResource } from "./script.js";
import { distanceKm } from "./world.js";
import { createRng, deriveSeed, type Rng } from "./rng.js";
import {
  NEEDLE_REPORT,
  NOISE_POOL,
  SITE_STREETS,
  TEMPLATES,
  type ElementTemplate,
} from "./scenario-templates.js";

/* ─── Seeded scenario generator (docs/SCENARIO-GENERATION.md, issue #90) ──
 * generateScenario(seed) returns { script, topologyGraph, contacts }: a
 * different, coherent, playable crisis per seed, with a curated fallback so
 * the demo never starts on a broken world and never starts with no scenario.
 */

const repoRoot = new URL("../../", import.meta.url);

/** Site and fleet catalog — and, unchanged, the fallback and fixture script */
const CATALOG = loadScript(new URL("data/scripts/madrid-blackout.json", repoRoot));
const FULL_TOPOLOGY = loadTopology(new URL("data/topology.json", repoRoot).pathname);
const REMEDIES = loadRemedies(new URL("data/remedies.json", repoRoot).pathname);

/** Band of demand over capacity the draw must land in (two tunable constants).
 *  The fleet is tight on purpose: at 110-140% of the capacity available in the
 *  window there is always more work than there are resource-minutes to spend,
 *  so ranking sites and leaving something unattended is part of every run. */
export const BAND_MIN = 1.1;
export const BAND_MAX = 1.4;

/** ~20 derived-seed attempts before falling back to the curated script */
export const MAX_ATTEMPTS = 20;

export const MIN_INCIDENT_SPACING_SECONDS = 120;
/** Later incidents start no earlier than this and none inside the last stretch */
const FIRST_SLOT_SECONDS = 180;
const LAST_START_SECONDS = 6600;
const INDEPENDENT_CHANCE = 0.5;
const MAX_INDEPENDENTS = 24;

/** Sites a drawn world holds, out of the 100 in the catalog. The draw fills up
 *  to MAX and validation holds the same band, so the two can never disagree
 *  about what is playable; which half of the map plays is up to the seed. */
export const MIN_SUBSET_SIZE = 46;
export const MAX_SUBSET_SIZE = 54;
/** Units a drawn fleet holds: the band above sizes it to the crisis inside
 *  these bounds. One unit of every class is the floor, so every remedy keeps a
 *  base to travel from. */
export const MIN_FLEET_SIZE = 4;
export const MAX_FLEET_SIZE = 90;
/** Every class a playable world needs at least one unit of */
const RESOURCE_CLASSES: readonly ResourceType[] = ["crew", "generator", "tanker", "police"];
/** A root blackout may take down the substations behind this share of the
 *  drawn world; the rest of it stays healthy and is there to be triaged. */
const MAX_DOWNED_SHARE = 0.8;
/** However small the world, a crisis needs more than one root cause */
const MIN_DOWNED_SUBS = 2;
/** The needle lands mid-crisis, never at the opening */
export const NEEDLE_WINDOW: readonly [number, number] = [1680, 4320];

/** Movement speed of the fleet, simulated km/min (world.ts drives with this) */
const SPEED_KM_MIN = 0.5;
/**
 * With a junction jammed and nobody directing it, the world doubles every
 * journey (world.ts TRAFFIC_PENALTY). Every accepted draw has a downed
 * junction, so the budget plans for the world the draw itself creates.
 */
const TRAFFIC_PENALTY = 2;
/** Even from the next street over, getting deployed takes a minute */
const MIN_TRAVEL_MINUTES = 1;

/** supplier per site id, from the `supplies` edges of the full topology */
const SUPPLIERS: ReadonlyMap<string, string> = new Map(
  FULL_TOPOLOGY.edges
    .filter((e) => e.type === "supplies" && e.to !== "*")
    .map((e) => [e.to, e.from]),
);
const SUBSTATION_IDS = CATALOG.elements.filter((e) => e.type === "substation").map((e) => e.id);

export interface Scenario {
  script: Script;
  /** physical facts, filtered to the active subset */
  topologyGraph: Topology;
  /** contacts filtered to the subset, with the needle on a crisis hospital */
  contacts: Contact[];
}

export interface ScenarioMeta {
  seed: number;
  /** start of every drawn incident, ascending: the root at t=0, then arrivals */
  incidentStarts: number[];
  demandMinutes: number;
  capacityMinutes: number;
  demandRatio: number;
  needleHospitalId: string;
}

export interface ScenarioDraft extends Scenario {
  meta: ScenarioMeta;
}

interface PlannedIncident {
  startSeconds: number;
  siteId: string;
  template: ElementTemplate;
}

/** Does this substation feed at least one hospital? */
function suppliesHospital(subId: string): boolean {
  return dependentsOf(FULL_TOPOLOGY, subId).some(
    (id) => CATALOG.elements.find((e) => e.id === id)?.type === "hospital",
  );
}

function siteTypeOf(id: string): ElementType {
  const element = CATALOG.elements.find((e) => e.id === id);
  if (!element) throw new Error(`unknown site: ${id}`);
  return element.type;
}

function fillText(text: string, siteId: string): string {
  const name = CATALOG.elements.find((e) => e.id === siteId)?.name ?? siteId;
  return text.replaceAll("{site}", name).replaceAll("{street}", SITE_STREETS[siteId] ?? name);
}

/** Straight-line journey of the nearest base of the fixing resource class */
function travelMinutes(fleet: ScriptResource[], siteId: string, fixResource: string): number {
  const site = CATALOG.elements.find((e) => e.id === siteId);
  if (!site) return MIN_TRAVEL_MINUTES;
  const bases = fleet.filter((r) => r.type === fixResource);
  const nearest = Math.min(...bases.map((r) => distanceKm(r, site)));
  return Math.max((nearest / SPEED_KM_MIN) * TRAFFIC_PENALTY, MIN_TRAVEL_MINUTES);
}

/** Every dependent of a downed substation is in the subset with it */
function forcedSubset(downedSubs: string[]): Set<string> {
  const active = new Set<string>();
  for (const sub of downedSubs) {
    active.add(sub);
    for (const dependent of dependentsOf(FULL_TOPOLOGY, sub)) {
      if (CATALOG.elements.some((e) => e.id === dependent)) active.add(dependent);
    }
  }
  return active;
}

/**
 * Substations whose fall the world can absorb: each one drags every site it
 * supplies into the subset, so rings are taken only while the sites they force
 * stay inside the target. Substations that feed a hospital go first — a crisis
 * always has somebody to save.
 */
function drawDownedSubs(rng: Rng, targetSize: number): string[] {
  const candidates = rng
    .shuffle(SUBSTATION_IDS)
    .sort((a, b) => Number(suppliesHospital(b)) - Number(suppliesHospital(a)));
  const room = Math.floor(targetSize * MAX_DOWNED_SHARE);
  const downed: string[] = [];
  for (const sub of candidates) {
    if (downed.length >= MIN_DOWNED_SUBS && forcedSubset([...downed, sub]).size > room) continue;
    downed.push(sub);
  }
  return downed;
}

function drawSubset(rng: Rng, downedSubs: string[], targetSize: number): Set<string> {
  const active = forcedSubset(downedSubs);
  const fillable = rng.shuffle(CATALOG.elements.filter((e) => !active.has(e.id)));
  for (const site of fillable) {
    if (active.size >= targetSize) break;
    active.add(site.id);
    // upward closure: a dependent brings its substation in with it
    const supplier = SUPPLIERS.get(site.id);
    if (supplier) active.add(supplier);
  }
  return active;
}

/**
 * Starts for the incidents after the root blackout: slotted across the window
 * so any two starts are at least MIN_INCIDENT_SPACING_SECONDS apart. With
 * TIME_SCALE = 6, one deliberation occupies 48-120 s of crisis clock —
 * incidents packed tighter collapse into a single re-plan.
 */
function drawStarts(rng: Rng, count: number): number[] {
  const slotWidth = (LAST_START_SECONDS - FIRST_SLOT_SECONDS) / count;
  const jitter = Math.max(Math.floor(slotWidth - MIN_INCIDENT_SPACING_SECONDS), 0);
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    starts.push(FIRST_SLOT_SECONDS + i * slotWidth + rng.int(0, jitter));
  }
  return starts;
}

/**
 * The fleet is drawn after the incidents: capacity is the scarce side, so its
 * size is whatever keeps the drawn demand inside the difficulty band — a
 * smaller world deploys fewer units and the scarcity that makes the demo
 * interesting survives in every shape. One unit of every class always stays,
 * so every remedy keeps a base to travel from; when no fleet size can reach
 * the band the smallest legal fleet is drawn and validation rejects the
 * attempt. The fleet is also never as large as the world: at most one unit
 * fewer than the drawn sites, so covering everything at once is never on the
 * table and ranking sites is always part of the job.
 */
function drawFleet(
  rng: Rng,
  demandMinutes: number,
  durationSeconds: number,
  siteCount: number,
): ScriptResource[] {
  const windowMinutes = durationSeconds / 60;
  const cap = Math.min(CATALOG.resources.length, MAX_FLEET_SIZE, siteCount - 1);
  const clamp = (n: number) => Math.min(Math.max(n, MIN_FLEET_SIZE), cap);
  const lo = clamp(Math.ceil(demandMinutes / (BAND_MAX * windowMinutes)));
  const hi = clamp(Math.floor(demandMinutes / (BAND_MIN * windowMinutes)));
  const size = lo <= hi ? rng.int(lo, hi) : MIN_FLEET_SIZE;

  const core: ScriptResource[] = [];
  const seenClasses = new Set<ResourceType>();
  for (const unit of CATALOG.resources) {
    if (!seenClasses.has(unit.type)) {
      seenClasses.add(unit.type);
      core.push(unit);
    }
  }
  const extras = rng.shuffle(CATALOG.resources.filter((r) => !core.includes(r)));
  return [...core, ...extras.slice(0, size - core.length)];
}

/**
 * One pure draw of the world from a seed. Subset invariants hold by
 * construction; the budget band and the pacing are checked by
 * `validateScenario`, which is what the retry loop consumes.
 */
export function drawScenario(seed: number): ScenarioDraft {
  const rng = createRng(seed);
  const durationSeconds = CATALOG.durationSeconds;

  // root causes: the rings the world can absorb; the first opens at t = 0
  const targetSize = rng.int(MIN_SUBSET_SIZE, MAX_SUBSET_SIZE);
  const downedSubs = drawDownedSubs(rng, targetSize);
  const firstSub = downedSubs[0];
  if (!firstSub) throw new Error("no substation drawn");

  const active = drawSubset(rng, downedSubs, targetSize);

  // genuinely independent local failures, only on sites with a healthy supply
  const independents: PlannedIncident[] = [];
  for (const site of CATALOG.elements) {
    if (independents.length >= MAX_INDEPENDENTS) break;
    if (!active.has(site.id) || site.type === "substation") continue;
    const supplier = SUPPLIERS.get(site.id);
    if (supplier !== undefined && downedSubs.includes(supplier)) continue;
    if (!rng.chance(INDEPENDENT_CHANCE)) continue;
    const templates = TEMPLATES.filter((t) => t.appliesTo === site.type && t.kind === "local");
    independents.push({ startSeconds: 0, siteId: site.id, template: rng.pick(templates) });
  }

  // the other roots and the independents land on the spaced slots
  const rootTemplates = TEMPLATES.filter((t) => t.appliesTo === "substation" && t.kind === "root");
  const laterRoots: PlannedIncident[] = downedSubs.slice(1).map((sub) => ({
    startSeconds: 0,
    siteId: sub,
    template: rng.pick(rootTemplates),
  }));
  const arrivals = rng.shuffle([...laterRoots, ...independents]);
  const starts = drawStarts(rng, arrivals.length);
  arrivals.forEach((incident, i) => {
    incident.startSeconds = starts[i] as number;
  });

  const incidents: PlannedIncident[] = [
    { startSeconds: 0, siteId: firstSub, template: rng.pick(rootTemplates) },
    ...arrivals,
  ];

  // dependents derive from the topology: they fall because their sub fell
  const startOfSub = new Map(incidents.map((i) => [i.siteId, i.startSeconds]));
  const timeline: ScriptEvent[] = [];
  for (const incident of incidents) {
    timeline.push(...incidentEvents(incident, true));
  }
  for (const sub of downedSubs) {
    const subStart = startOfSub.get(sub) ?? 0;
    for (const dependent of dependentsOf(FULL_TOPOLOGY, sub)) {
      if (!active.has(dependent)) continue;
      const templates = TEMPLATES.filter(
        (t) => t.appliesTo === siteTypeOf(dependent) && t.kind === "grid",
      );
      timeline.push(...incidentEvents({ startSeconds: subStart, siteId: dependent, template: rng.pick(templates) }, false));
    }
  }

  // background noise on top: site-agnostic, so it never leaks the plot
  const noise = rng.shuffle(NOISE_POOL).slice(0, rng.int(14, 22));
  for (const entry of noise) {
    timeline.push({
      atSeconds: rng.int(30, durationSeconds - 120),
      kind: "report",
      payload: { id: "", source: entry.source, text: entry.text, elementId: null },
    });
  }

  // the needle always appears, on a hospital whose substation is down
  const crisisHospitals = [...active].filter(
    (id) => siteTypeOf(id) === "hospital" && downedSubs.includes(SUPPLIERS.get(id) ?? ""),
  );
  // With no hospital on a downed substation there is no crisis hospital to put
  // the needle on; any hospital in the world keeps the draw alive and
  // validation decides whether it is playable.
  const hospitals = crisisHospitals.length
    ? crisisHospitals
    : [...active].filter((id) => siteTypeOf(id) === "hospital");
  const needleHospitalId = rng.pick(hospitals);
  timeline.push({
    atSeconds: rng.int(NEEDLE_WINDOW[0], NEEDLE_WINDOW[1]),
    kind: "report",
    note: NEEDLE_REPORT.text,
    payload: { id: "", source: NEEDLE_REPORT.source, text: NEEDLE_REPORT.text, elementId: needleHospitalId },
  });

  // events past the curtain are not part of the run; ids follow the clock
  const playable = timeline
    .filter((e) => e.atSeconds <= durationSeconds)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  assignIds(playable);

  // the fleet is sized to this draw: a smaller crisis deploys fewer units, so
  // the demand stays inside the band and the dilemma outlives the world size —
  // and it always stays below the site count: one site short of full coverage
  const preliminary = demand(incidents, downedSubs, active, durationSeconds, CATALOG.resources);
  const fleet = drawFleet(rng, preliminary.demandMinutes, durationSeconds, active.size);
  const resourceIds = new Set(fleet.map((r) => r.id));

  const script: Script = {
    title: "Seeded blackout — Getafe, Community of Madrid",
    durationSeconds,
    elements: CATALOG.elements.filter((e) => active.has(e.id)),
    resources: fleet,
    timeline: playable,
  };

  const topologyGraph: Topology = {
    edges: FULL_TOPOLOGY.edges.filter(
      (e) => active.has(e.from) && (e.to === "*" || active.has(e.to) || resourceIds.has(e.to)),
    ),
  };

  const contacts: Contact[] = REMEDIES.contacts.flatMap((c) => {
    // the needle moves to this seed's crisis hospital before filtering: its
    // original site may not even exist in this world
    if (c.id === "ventilator-citizen") return [{ ...c, elementId: needleHospitalId }];
    if (c.elementId !== undefined && !active.has(c.elementId)) return [];
    if (c.resourceId !== undefined && !resourceIds.has(c.resourceId)) return [];
    return [{ ...c }];
  });

  return {
    script,
    topologyGraph,
    contacts,
    meta: {
      seed,
      incidentStarts: incidents.map((i) => i.startSeconds).sort((a, b) => a - b),
      ...demand(incidents, downedSubs, active, durationSeconds, fleet),
      needleHospitalId,
    },
  };
}

/**
 * Events of one arc, offset from its start. When `withMoment` is set, the
 * arc's opening event carries the narrative note that the feed reveals the
 * moment it fires; dependent cascades stay silent (the root speaks for them).
 */
function incidentEvents(incident: PlannedIncident, withMoment: boolean): ScriptEvent[] {
  const events: ScriptEvent[] = [];
  for (const step of incident.template.steps) {
    events.push({
      atSeconds: incident.startSeconds + step.atSeconds,
      kind: "sensor_event",
      payload: {
        id: "",
        elementId: incident.siteId,
        metric: step.metric,
        value: step.value,
        severity: step.severity,
      },
    });
  }
  for (const report of incident.template.reports) {
    events.push({
      atSeconds: incident.startSeconds + report.atSeconds,
      kind: "report",
      payload: {
        id: "",
        source: report.source,
        text: fillText(report.text, incident.siteId),
        elementId: report.bound ? incident.siteId : null,
      },
    });
  }
  if (withMoment && incident.template.moment !== undefined) {
    const opening = events[0];
    if (opening) opening.note = fillText(incident.template.moment, incident.siteId);
  }
  return events;
}

function assignIds(timeline: ScriptEvent[]): void {
  let sensor = 0;
  let report = 0;
  for (const event of timeline) {
    if (event.kind === "sensor_event") {
      sensor += 1;
      event.payload.id = `evt-${String(sensor).padStart(3, "0")}`;
    } else if (event.kind === "report") {
      report += 1;
      event.payload.id = `rep-${String(report).padStart(3, "0")}`;
    }
  }
}

/**
 * Resource-minutes the drawn crisis will demand, against the minutes the fleet
 * has in the window. A sustaining remedy (a generator on a hospital, police at
 * the junction) pins its resource until the window closes; a one-shot job costs
 * its declared minutes. Travel uses the same flat-earth arithmetic as the
 * world's own ETAs.
 */
function demand(
  incidents: PlannedIncident[],
  downedSubs: string[],
  active: Set<string>,
  durationSeconds: number,
  fleet: ScriptResource[],
): { demandMinutes: number; capacityMinutes: number; demandRatio: number } {
  const windowMinutes = durationSeconds / 60;
  let demandMinutes = 0;

  function costOf(siteId: string, fixResource: string, startSeconds: number): number {
    const type = siteTypeOf(siteId);
    const remedy = REMEDIES.remedies.find(
      (r) => r.resource === fixResource && r.appliesTo.includes(type),
    );
    if (!remedy) return 0;
    const work = remedy.sustains ? remedy.minutes + (windowMinutes - startSeconds / 60) : remedy.minutes;
    return work + travelMinutes(fleet, siteId, fixResource);
  }

  for (const incident of incidents) {
    demandMinutes += costOf(incident.siteId, incident.template.fixResource, incident.startSeconds);
  }
  const startOfSub = new Map(incidents.map((i) => [i.siteId, i.startSeconds]));
  for (const sub of downedSubs) {
    const subStart = startOfSub.get(sub) ?? 0;
    for (const dependent of dependentsOf(FULL_TOPOLOGY, sub)) {
      if (!active.has(dependent)) continue;
      const remedy = REMEDIES.remedies.find((r) => r.appliesTo.includes(siteTypeOf(dependent)));
      if (!remedy) continue;
      demandMinutes += costOf(dependent, remedy.resource, subStart);
    }
  }

  const capacityMinutes = fleet.length * windowMinutes;
  return {
    demandMinutes: Math.round(demandMinutes),
    capacityMinutes,
    demandRatio: demandMinutes / capacityMinutes,
  };
}

/* ─── Validation ───────────────────────────────────────────────────────── */

/**
 * The safety net: a draw is only playable if the subset keeps its invariants,
 * the contacts point at the subset, the pacing leaves room to deliberate and
 * the demand lands inside the difficulty band.
 */
export function validateScenario(draft: ScenarioDraft): string[] {
  const problems: string[] = [];
  const { script, contacts, meta } = draft;
  const active = new Set(script.elements.map((e) => e.id));
  const resourceIds = new Set(script.resources.map((r) => r.id));
  const countOfType = (type: ElementType) => script.elements.filter((e) => e.type === type).length;

  if (script.elements.length < MIN_SUBSET_SIZE || script.elements.length > MAX_SUBSET_SIZE) {
    problems.push(
      `subset size ${script.elements.length} outside ${MIN_SUBSET_SIZE}-${MAX_SUBSET_SIZE}`,
    );
  }
  if (countOfType("substation") < 2) problems.push("fewer than 2 substations");
  if (countOfType("hospital") < 2) problems.push("fewer than 2 hospitals");
  if (countOfType("fuel_station") < 1) problems.push("no fuel_station: the tankers are decorative");
  if (countOfType("junction") < 1) problems.push("no junction: the police units are decorative");

  // one unit of every class: a template's fix resource must have a base
  for (const type of RESOURCE_CLASSES) {
    if (!script.resources.some((r) => r.type === type)) {
      problems.push(`no ${type} in the fleet`);
    }
  }

  // the fleet never matches the world: with one site short of full coverage,
  // ranking sites is always part of the job
  if (script.resources.length > script.elements.length - 1) {
    problems.push(
      `fleet of ${script.resources.length} is not smaller than the ${script.elements.length} drawn sites`,
    );
  }

  // topological upward closure: a dependent in implies its substation in
  for (const element of script.elements) {
    const supplier = SUPPLIERS.get(element.id);
    if (supplier && !active.has(supplier)) {
      problems.push(`${element.id} is in but its substation ${supplier} is not`);
    }
  }

  for (const contact of contacts) {
    if (contact.elementId !== undefined && !active.has(contact.elementId)) {
      problems.push(`contact ${contact.id} dangles on ${contact.elementId}`);
    }
    if (contact.resourceId !== undefined && !resourceIds.has(contact.resourceId)) {
      problems.push(`contact ${contact.id} dangles on ${contact.resourceId}`);
    }
  }
  const needle = contacts.find((c) => c.id === "ventilator-citizen");
  if (!needle || needle.elementId !== meta.needleHospitalId || !active.has(meta.needleHospitalId)) {
    problems.push("the needle is missing or not on a crisis hospital");
  }

  if (meta.demandRatio < BAND_MIN || meta.demandRatio > BAND_MAX) {
    problems.push(
      `demand ${Math.round(meta.demandRatio * 100)}% of capacity outside the ${BAND_MIN}-${BAND_MAX} band`,
    );
  }

  if (meta.incidentStarts[0] !== 0) problems.push("no root blackout at t = 0");
  for (let i = 1; i < meta.incidentStarts.length; i++) {
    const gap = (meta.incidentStarts[i] as number) - (meta.incidentStarts[i - 1] as number);
    if (gap < MIN_INCIDENT_SPACING_SECONDS) {
      problems.push(`incidents ${i - 1} and ${i} only ${gap}s apart`);
    }
  }

  let lastAt = -1;
  for (const event of script.timeline) {
    if (event.atSeconds < lastAt) {
      problems.push("timeline is not sorted");
      break;
    }
    lastAt = event.atSeconds;
    if (event.kind === "report") {
      if (event.payload.elementId !== null && !active.has(event.payload.elementId)) {
        problems.push(`report ${event.payload.id} dangles on ${event.payload.elementId}`);
      }
    } else if (event.kind === "sensor_event" && !active.has(event.payload.elementId)) {
      problems.push(`event ${event.payload.id} dangles on ${event.payload.elementId}`);
    }
  }

  return problems;
}

/* ─── Entry point ──────────────────────────────────────────────────────── */

function curatedFallback(): Scenario {
  return { script: CATALOG, topologyGraph: FULL_TOPOLOGY, contacts: [...REMEDIES.contacts] };
}

/**
 * Draws a scenario from `seed` and validates it; on failure retries with a
 * derived seed; if no draw passes, loads the curated script. Deterministic:
 * the same seed always yields the same crisis.
 */
export function generateScenario(seed: number): Scenario {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const draft = drawScenario(deriveSeed(seed, attempt));
    if (validateScenario(draft).length === 0) {
      return { script: draft.script, topologyGraph: draft.topologyGraph, contacts: draft.contacts };
    }
  }
  console.error(
    `[scenario] no draw of seed ${seed} passed validation in ${MAX_ATTEMPTS} attempts; falling back to the curated script`,
  );
  return curatedFallback();
}
