import type { ElementType, ResourceType, SensorMetric } from "@swarmup/shared";

/* ─── Incident template catalog (docs/SCENARIO-GENERATION.md) ────────────
 * The problem space is 4 remedy classes over 6 element types, so a template
 * per arc — not per site. Each template is one arc: escalating sensor events
 * plus its own reports, with {site} / {street} placeholders resolved onto the
 * activated site. Only root causes and genuinely independent local failures
 * are drawn; dependents of a downed substation are instantiated from the grid
 * variants of the same catalog, which is what keeps the world consistent with
 * the topology the agent reads (a hospital never loses grid power while its
 * substation is healthy).
 */

export type ReportSource = "social" | "emergency_call" | "press" | "field" | "faulty_sensor";

/** Where an arc may be instantiated: the roots and grid cascades follow the
 *  topology; a local failure can only strike a site with a healthy supply. */
export type TemplateKind = "root" | "grid" | "local";

export interface TemplateStep {
  /** offset in seconds from the start of the incident */
  atSeconds: number;
  metric: SensorMetric;
  value: number;
  severity: number;
}

export interface TemplateReport {
  atSeconds: number;
  source: ReportSource;
  /** {site} → element name, {street} → SITE_STREETS[elementId] */
  text: string;
  /** true: the report is bound to the site (elementId set); false: scene-wide */
  bound: boolean;
}

export interface ElementTemplate {
  id: string;
  kind: TemplateKind;
  appliesTo: ElementType;
  /** the resource class the remedy catalog offers against this arc */
  fixResource: ResourceType;
  steps: TemplateStep[];
  reports: TemplateReport[];
}

export const TEMPLATES: ElementTemplate[] = [
  /* ── Roots: substation grid failures ── */
  {
    id: "substation-total-collapse",
    kind: "root",
    appliesTo: "substation",
    fixResource: "crew",
    steps: [
      { atSeconds: 0, metric: "grid_voltage", value: 12, severity: 90 },
      { atSeconds: 60, metric: "grid_voltage", value: 8, severity: 92 },
    ],
    reports: [
      { atSeconds: 15, source: "field", text: "{site}: breaker bank tripped, no restoration ETA", bound: true },
      { atSeconds: 70, source: "social", text: "Power is out across {street}", bound: true },
      { atSeconds: 300, source: "press", text: "Local outlet asks about the scope of the outage at {site}", bound: true },
    ],
  },
  {
    id: "substation-feeder-fault",
    kind: "root",
    appliesTo: "substation",
    fixResource: "crew",
    steps: [
      { atSeconds: 0, metric: "grid_voltage", value: 30, severity: 66 },
      { atSeconds: 150, metric: "grid_voltage", value: 18, severity: 78 },
      { atSeconds: 330, metric: "grid_voltage", value: 9, severity: 90 },
    ],
    reports: [
      { atSeconds: 10, source: "field", text: "{site}: feeder fault, voltage collapsing on the ring", bound: true },
      { atSeconds: 340, source: "field", text: "{site}: feeder fault confirmed, no restoration ETA", bound: true },
    ],
  },

  /* ── Grid cascades: instantiated on dependents of a downed substation ── */
  {
    id: "hospital-generator-failure",
    kind: "grid",
    appliesTo: "hospital",
    fixResource: "generator",
    steps: [
      { atSeconds: 15, metric: "grid_voltage", value: 9, severity: 82 },
      { atSeconds: 90, metric: "generator_battery", value: 40, severity: 58 },
      { atSeconds: 300, metric: "generator_battery", value: 18, severity: 78 },
      { atSeconds: 480, metric: "generator_battery", value: 8, severity: 88 },
    ],
    reports: [
      { atSeconds: 30, source: "emergency_call", text: "{site} is switching everything over to generators", bound: true },
      { atSeconds: 130, source: "field", text: "{site}: main generator set will not start", bound: true },
      { atSeconds: 420, source: "social", text: "Ambulances being diverted from {site}?", bound: true },
    ],
  },
  {
    id: "hospital-battery-drain",
    kind: "grid",
    appliesTo: "hospital",
    fixResource: "generator",
    steps: [
      { atSeconds: 15, metric: "grid_voltage", value: 11, severity: 80 },
      { atSeconds: 120, metric: "generator_battery", value: 70, severity: 32 },
      { atSeconds: 360, metric: "generator_battery", value: 45, severity: 55 },
      { atSeconds: 600, metric: "generator_battery", value: 26, severity: 72 },
      { atSeconds: 780, metric: "generator_battery", value: 17, severity: 82 },
    ],
    reports: [
      { atSeconds: 60, source: "emergency_call", text: "Caller asks how long {site} can hold on generators", bound: true },
      { atSeconds: 420, source: "social", text: "{site} is running on loud generators in the parking lot", bound: true },
    ],
  },
  {
    id: "datacenter-ups-overload",
    kind: "grid",
    appliesTo: "datacenter",
    fixResource: "generator",
    steps: [
      { atSeconds: 20, metric: "grid_voltage", value: 10, severity: 80 },
      { atSeconds: 150, metric: "ups_load", value: 44, severity: 48 },
      { atSeconds: 330, metric: "ups_load", value: 14, severity: 68 },
      { atSeconds: 500, metric: "temperature", value: 42, severity: 60 },
      { atSeconds: 650, metric: "temperature", value: 47, severity: 78 },
    ],
    reports: [
      { atSeconds: 90, source: "faulty_sensor", text: "Sensor T-14 at {site} reports 87 °C — inconsistent with the adjacent sensors", bound: true },
      { atSeconds: 320, source: "field", text: "{site} technician confirms a hot aisle in row B", bound: true },
      { atSeconds: 550, source: "social", text: "Is that smoke coming from {site}? Hard to tell", bound: true },
    ],
  },
  {
    id: "datacenter-cooling-loss",
    kind: "grid",
    appliesTo: "datacenter",
    fixResource: "generator",
    steps: [
      { atSeconds: 20, metric: "grid_voltage", value: 12, severity: 78 },
      { atSeconds: 180, metric: "temperature", value: 41, severity: 52 },
      { atSeconds: 420, metric: "ups_load", value: 38, severity: 56 },
      { atSeconds: 600, metric: "temperature", value: 46, severity: 74 },
    ],
    reports: [
      { atSeconds: 240, source: "field", text: "{site}: cooling pumps lost, temperature climbing", bound: true },
      { atSeconds: 480, source: "press", text: "Can you confirm an incident at {site}?", bound: true },
    ],
  },
  {
    id: "tower-battery-drain",
    kind: "grid",
    appliesTo: "tower",
    fixResource: "generator",
    steps: [
      { atSeconds: 25, metric: "grid_voltage", value: 14, severity: 76 },
      { atSeconds: 200, metric: "tower_battery", value: 62, severity: 40 },
      { atSeconds: 450, metric: "tower_battery", value: 41, severity: 58 },
      { atSeconds: 700, metric: "network_coverage", value: 52, severity: 62 },
      { atSeconds: 850, metric: "tower_battery", value: 22, severity: 78 },
    ],
    reports: [
      { atSeconds: 300, source: "field", text: "Intermittent mobile coverage near {site}; some calls are not getting through", bound: true },
      { atSeconds: 600, source: "social", text: "No mobile coverage around {street} since the blackout began", bound: true },
    ],
  },
  {
    id: "fuel-station-pumps-out",
    kind: "grid",
    appliesTo: "fuel_station",
    fixResource: "tanker",
    steps: [
      { atSeconds: 30, metric: "grid_voltage", value: 11, severity: 78 },
      { atSeconds: 240, metric: "fuel", value: 30, severity: 40 },
      { atSeconds: 420, metric: "grid_voltage", value: 7, severity: 84 },
    ],
    reports: [
      { atSeconds: 120, source: "field", text: "{site}: pumps have no power, unable to dispense", bound: true },
      { atSeconds: 450, source: "field", text: "{site}: ambulances queuing for diesel", bound: true },
    ],
  },
  {
    id: "junction-lights-out",
    kind: "grid",
    appliesTo: "junction",
    fixResource: "police",
    steps: [
      { atSeconds: 20, metric: "grid_voltage", value: 10, severity: 76 },
      { atSeconds: 150, metric: "congestion", value: 7, severity: 32 },
      { atSeconds: 400, metric: "congestion", value: 11, severity: 55 },
      { atSeconds: 650, metric: "congestion", value: 16, severity: 72 },
    ],
    reports: [
      { atSeconds: 60, source: "field", text: "Traffic lights out at {site}, slow-moving traffic", bound: true },
      { atSeconds: 320, source: "social", text: "Massive jam at {street}", bound: true },
      { atSeconds: 600, source: "emergency_call", text: "Drivers stuck at {street} ask someone to direct traffic", bound: true },
    ],
  },

  /* ── Local failures: genuinely independent of the grid ── */
  {
    id: "hospital-backup-fuel-low",
    kind: "local",
    appliesTo: "hospital",
    fixResource: "tanker",
    steps: [
      { atSeconds: 100, metric: "generator_battery", value: 48, severity: 42 },
      { atSeconds: 400, metric: "generator_battery", value: 30, severity: 60 },
      { atSeconds: 620, metric: "generator_battery", value: 16, severity: 76 },
    ],
    reports: [
      { atSeconds: 0, source: "field", text: "{site}: backup generator fuel below half after the weekly test", bound: true },
      { atSeconds: 450, source: "emergency_call", text: "Caller asks whether {site} still has backup power", bound: true },
    ],
  },
  {
    id: "datacenter-ups-fault",
    kind: "local",
    appliesTo: "datacenter",
    fixResource: "generator",
    steps: [
      { atSeconds: 100, metric: "ups_load", value: 46, severity: 42 },
      { atSeconds: 380, metric: "ups_load", value: 19, severity: 62 },
      { atSeconds: 600, metric: "temperature", value: 41, severity: 58 },
      { atSeconds: 800, metric: "temperature", value: 46, severity: 74 },
    ],
    reports: [
      { atSeconds: 0, source: "field", text: "{site}: UPS bank fault during a test, running on bypass", bound: true },
      { atSeconds: 300, source: "faulty_sensor", text: "Sensor rack 3 at {site} reports -5 °C — impossible", bound: true },
      { atSeconds: 640, source: "social", text: "{site} status page is down, is something going on?", bound: true },
    ],
  },
  {
    id: "tower-battery-fault",
    kind: "local",
    appliesTo: "tower",
    fixResource: "generator",
    steps: [
      { atSeconds: 100, metric: "tower_battery", value: 58, severity: 45 },
      { atSeconds: 380, metric: "tower_battery", value: 38, severity: 62 },
      { atSeconds: 620, metric: "tower_battery", value: 19, severity: 78 },
    ],
    reports: [
      { atSeconds: 0, source: "field", text: "{site}: battery bank fault, running on one string", bound: true },
      { atSeconds: 450, source: "social", text: "Calls keep dropping around {street}", bound: true },
    ],
  },
  {
    id: "fuel-station-dry-tank",
    kind: "local",
    appliesTo: "fuel_station",
    fixResource: "tanker",
    steps: [
      { atSeconds: 100, metric: "fuel", value: 32, severity: 40 },
      { atSeconds: 400, metric: "fuel", value: 18, severity: 60 },
      { atSeconds: 650, metric: "fuel", value: 9, severity: 75 },
    ],
    reports: [
      { atSeconds: 0, source: "field", text: "{site}: diesel nearly out, deliveries delayed", bound: true },
      { atSeconds: 350, source: "social", text: "An hour queuing at {street} and they are out of diesel", bound: true },
    ],
  },
  {
    id: "junction-accident-jam",
    kind: "local",
    appliesTo: "junction",
    fixResource: "police",
    steps: [
      { atSeconds: 100, metric: "congestion", value: 8, severity: 38 },
      { atSeconds: 350, metric: "congestion", value: 12, severity: 58 },
      { atSeconds: 600, metric: "congestion", value: 16, severity: 74 },
    ],
    reports: [
      { atSeconds: 0, source: "field", text: "Two-vehicle collision at {site}, one lane blocked", bound: true },
      { atSeconds: 250, source: "social", text: "Awful traffic at {street}, something happened?", bound: true },
    ],
  },
];

/** Street or district label per site, for the {street} placeholder */
export const SITE_STREETS: Record<string, string> = {
  "sub-01": "Getafe Sur",
  "hosp-01": "calle Madrid",
  "dc-01": "the industrial estate",
  "tower-01": "Getafe Norte",
  "fuel-01": "the A-42",
  "junction-01": "Av. Juan Carlos I",
  "sub-02": "Getafe Norte",
  "sub-03": "Las Margaritas",
  "hosp-02": "El Bercial",
  "hosp-03": "Getafe Este",
  "dc-02": "Los Ángeles",
  "tower-02": "Getafe Este",
  "tower-03": "Las Margaritas",
  "fuel-02": "the M-409",
  "junction-02": "Av. España",
};

/** Scene-wide background noise, drawn on top of each template's own reports.
 *  Deliberately site-agnostic: it must never leak where the crisis is. */
export const NOISE_POOL: { source: ReportSource; text: string }[] = [
  { source: "social", text: "Anyone else without power? #blackout" },
  { source: "social", text: "my fridge has been off a while, everything is going to spoil" },
  { source: "social", text: "No wifi, no TV, does anyone know anything" },
  { source: "social", text: "#blackout is trending already" },
  { source: "social", text: "My phone is dead, no calls and no data" },
  { source: "social", text: "anyone know if the supermarket is open?" },
  { source: "social", text: "been stuck in the car for a while now" },
  { source: "social", text: "Someone said power is back on their street, can anyone confirm?" },
  { source: "social", text: "Odd humming in the industrial estate, probably a generator" },
  { source: "social", text: "Do not panic, the sirens are just a test... right?" },
  { source: "press", text: "Local outlet requests a statement on the scope of the outage" },
  { source: "press", text: "Interview request for the evening news bulletin" },
  { source: "press", text: "Local radio asks whether the western districts are affected too" },
  { source: "press", text: "Is there an estimate for restoration?" },
  { source: "press", text: "Council press office asks how many substations are actually down" },
  { source: "emergency_call", text: "Resident asks when power returns to their street" },
  { source: "emergency_call", text: "Person trapped in a lift — fire service already alerted through another channel" },
  { source: "emergency_call", text: "Resident reports the branch cash machine is down" },
  { source: "emergency_call", text: "Caller asks if schools will open tomorrow" },
  { source: "faulty_sensor", text: "Grid sensor reports 400% voltage — outside any physical range" },
  { source: "faulty_sensor", text: "Temperature probe reads -3 °C — impossible" },
  { source: "faulty_sensor", text: "Humidity sensor reports 210% — clearly broken" },
  { source: "faulty_sensor", text: "Flow meter reports negative consumption — recalibration overdue" },
  { source: "social", text: "Candles sold out at the corner shop, whole street is dark" },
];

/** The needle: the signal no sensor produces, the moment that cannot be lost
 *  to a dice roll. Bound at generation to whichever hospital is in crisis. */
export const NEEDLE_REPORT = {
  source: "emergency_call" as ReportSource,
  text: "Caller reports her father is on a home ventilator with one hour of battery left",
};
