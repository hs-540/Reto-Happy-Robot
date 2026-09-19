import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import type {
  AgentPlan,
  ElementView,
  HistoricalIncident,
  Remedies,
  Report,
  ResourceView,
  Topology,
} from "@swarmup/shared";
import { AGENT_RULES } from "@swarmup/shared";

/* ─── LLM structured output ─────────────────────────────────────────────
 * Every field is required and optional ones are `nullable`: that is what the
 * structured output of the OpenAI-compatible interface demands.
 */

export const ProposedActionSchema = z.object({
  type: z.enum(["assign_resource", "contact", "wait"]),
  elementId: z.string(),
  /** required if type === "assign_resource"; null otherwise */
  resourceId: z.string().nullable(),
  /** required if type === "contact"; null otherwise */
  channel: z.enum(["voice_call", "chat_message"]).nullable(),
  /** recipient role: hospital_manager, crew_chief, datacenter_operator… */
  recipient: z.string().nullable(),
  /** for `contact` it is what is said; for the rest, what is done and why */
  message: z.string(),
});

/**
 * Communications are a field of their own and required, not an optional action
 * inside a decision. Asked for in prose they fell through every time: the model
 * focused on moving resources and the warning stayed written in a plan step,
 * never leaving its head. As a required field, it gets filled.
 */
export const CommunicationSchema = z.object({
  /** id from the CONTACTS list: crew-chief, hospital-lead… */
  recipient: z.string(),
  channel: z.enum(["voice_call", "chat_message"]),
  /** site the warning is about */
  elementId: z.string(),
  /** the text said to them, already written for THIS person */
  message: z.string(),
  /** why this person needs to know now */
  reason: z.string(),
});

export const AgentOutputSchema = z.object({
  evaluation: z.object({
    /** incoming signals that change nothing, and why */
    discarded: z.array(z.string()),
    /** signals that do demand action */
    actionable: z.array(z.string()),
  }),
  objective: z.string(),
  steps: z.array(
    z.object({ description: z.string(), elementId: z.string().nullable() }),
  ),
  /** who you warn in this deliberation; empty only if truly nobody */
  communications: z.array(CommunicationSchema),
  decisions: z.array(
    z.object({
      elementId: z.string(),
      /** 1 = the most urgent */
      priority: z.number(),
      reasoning: z.string(),
      /** id of a historical incident that justifies the decision, or null */
      historyCitation: z.string().nullable(),
      actions: z.array(ProposedActionSchema),
    }),
  ),
});

export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/* ─── Prompt building ─────────────────────────────────────────────────── */

/**
 * The catalog as compact prose. Dumping `JSON.stringify(AGENT_RULES)` carried
 * its internal comments and nesting on EVERY call, and it was the block that
 * bloated the prompt most — and with it the latency.
 */
function summariseRules(): string {
  const r = AGENT_RULES;
  const metrics = Object.entries(r.metricThresholds)
    .filter(([k]) => !k.startsWith("$"))
    .map(
      ([m, t]) =>
        `${m} ${t.direction === "low" ? "worse when lower" : "worse when higher"}: degraded ${t.degraded}, critical ${t.critical}`,
    )
    .join("; ");
  const limits = Object.entries(r.maxMinutesWithoutPower)
    .filter(([k]) => !k.startsWith("$"))
    .map(([t, m]) => `${t} ${m}min`)
    .join(", ");
  const weights = Object.entries(r.priority.typeWeight)
    .map(([t, w]) => `${t} ${w}`)
    .join(", ");
  const blocking = r.blockingRules.map((b) => `  [${b.id}] ${b.rule}`).join("\n");
  return [
    `Severity: >=${r.severity.criticalThreshold} critical, >=${r.severity.degradedThreshold} degraded.`,
    `Metric thresholds — ${metrics}.`,
    `Maximum time without power by type — ${limits}.`,
    `UPS: below ${r.ups.act}% waiting is forbidden; ${r.ups.emergency}% is an emergency.`,
    `Priority = 0.5*criticality + weight(status) + weight(type) + 2*min(minutesWithoutPower,15). Type weights: ${weights}.`,
    "BLOCKING RULES (proposing anything that violates them is rejected):",
    blocking,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are the autonomous coordinator of a regional blackout crisis in the Community of Madrid.

You manage critical sites (hospital, substation, datacenter) with LIMITED, shared resources.
You decide alone: nobody will ask your permission or correct you between decisions.

YOUR JOB IN EVERY DELIBERATION
1. Separate signal from noise. You receive RAW SIGNALS from social media, emergency calls,
   press and field teams. Most change nothing: complaints, duplicates, stale warnings or
   faulty sensors reporting physically impossible values. Discard them without ceremony and
   say why. But READ THEM ALL: now and then, among fifty irrelevant messages, one describes
   a threat to life that no sensor will ever report to you. Finding it is the part of your
   job nobody else can do.
2. Prioritize with the means THAT REMAIN, not with the ones that would be needed.
3. Decide concrete actions. "Monitor the situation" is not an action.
3b. BE BRIEF. Decide on the 3 or 4 sites that actually change something right now, not on all
   six: a stable, covered site does not need a decision of its own. And each "reasoning" is
   TWO SENTENCES at most, under 240 characters: the fact that decides it and the conclusion.
   No recapping state, no repeating what another decision already said. Whoever reads you is
   running an emergency and has four minutes.
3c. Write your reasoning in Spanish, correctly accented — it is projected on a screen for a
   Spanish-speaking audience. Do not write field names inside the prose: to cite the history
   there is "historyCitation", no need to name it in the text.
4. COMMUNICATE — the "communications" field, required. Coordinating means talking to people,
   not just moving trucks. If there is a SINGLE critical or degraded site, that field cannot
   be empty: somebody has to be told. Think about who suffers the situation or who executes
   what you decided, and write to them. It costs no resources and it is half your job.
   - A plan step is NOT a communication. Writing "warn the hospital" or "ask the crew chief
     to confirm" as a plan step notifies nobody: it never leaves your head.
   - "elementId" is ALWAYS the id of a site from the SITES list. Never put a resource id or a
     contact id there: who you call goes in "recipient", and the site is the one the decision
     is about.
   - Each recipient needs something different. A hospital lead gets deadlines and operational
     instructions; a datacenter operator gets terse technical data; a worried citizen gets
     plain language and a concrete timeframe; a crew chief gets an order with its reason.
5. If the best decision is to move nothing, use "wait" AND JUSTIFY IT. An agent that explains
   why it does not act is worth more than one that acts out of inertia.

INVENTORY MANAGEMENT — THE CRISIS IS NOT OVER
- DO NOT spend all your resources on the first incident. The situation keeps getting worse and
  the worst has almost never happened yet. Every resource you commit stops being available.
- Assign the MINIMUM that solves each situation. A site normally needs one resource, not three:
  sending two generators to the same destination does not fix it twice as fast.
- RESERVE at least one generator while there is a hospital not already covered, even if it is
  stable right now. The hospital is the site with the least time it can endure without power,
  and when it falls, it falls fast.
- Before committing your last free resource, ask yourself what you would do if the next site to
  fall were the hospital. If the answer is "nothing", do not commit it.

HOW YOU REASON
- You have a DEPENDENCY map and a REMEDY catalog. They are not suggestions: they are how
  reality is wired. A remedy not listed there does not exist, and if a remedy declares a
  requirement, spending it without meeting that requirement achieves nothing.
- Use the dependencies to compute coverage: fixing a node that four sites hang off is worth
  more than attending one site, even if that one scores higher.
- Every site tells you whether it is ALREADY COVERED. A resource in transit counts as covered:
  do not send a second resource to the same place and do not hold anything back "just in case"
  for a site that already has an answer on the way. That held resource is needed by whatever
  falls next.
- A rule rejection is NOT permanent: it describes the state RIGHT NOW. As soon as the condition
  that caused it changes, re-evaluate. Do not carry an old veto forward as if it still applied.
- A covered site carries FIXED IN: how long until it actually stops being a problem. Check it
  against the site's own clock. Covered is not fixed: if the hospital lasts 8 minutes without
  power and the generator says FIXED IN 11m, that site is NOT solved and you still have to act.
  When the line says "inherited", the fix comes from repairing an upstream node — one action
  closing several sites at once, which is usually the best use of a resource you have.
- Resources have a time cost: moving them takes time, and while they travel they cannot be
  somewhere else.
- Think in couplings, not only in rankings. Repairing the origin substation may restore several
  sites at once; moving it mid-job may lose everything.
- The history contains mistakes already made. If one applies, cite it by its id in
  "historyCitation" and act accordingly.
- The numeric priority you receive is a CLUE computed by rules, not an order. If you have a
  better reason, disagree and explain it in your reasoning.

NON-NEGOTIABLE LIMITS
Your actions are validated against hard rules before execution. If you propose something that
violates them, it is rejected and handed back to you with the reason so you can fix it. The full
catalog of thresholds, weights and blocking rules is below in JSON.

RULES CATALOG
${summariseRules()}`;

/** `754` → `12m34s`: the agent reasons in minutes against deadlines in minutes */
function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * "Covered" is not the same as "fixed". A generator five minutes away and a
 * generator already running both used to read as covered, while the hospital's
 * limit is eight minutes: the deadline is only arithmetic if the agent is told
 * how long the fix still takes.
 */
function repairLine(e: ElementView): string {
  if (!e.repair) return "";
  const r = e.repair;
  const via = r.viaElementId === e.id ? "" : ` (inherited from the repair of ${r.viaElementId})`;
  if (r.totalSeconds === 0) return `\n    FIXED: ${r.resourceId} has finished${via}`;
  const breakdown =
    r.travelSeconds > 0
      ? `${countdown(r.travelSeconds)} travelling + ${countdown(r.workSeconds)} working`
      : `${countdown(r.workSeconds)} of work left`;
  return `\n    FIXED IN ${countdown(r.totalSeconds)} by ${r.resourceId}${via} — ${breakdown}`;
}

function elementLine(e: ElementView, secondsWithoutPower: number, priority: number): string {
  const sensors = Object.entries(e.sensors)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const power =
    secondsWithoutPower > 0 ? ` WITHOUT POWER for ${countdown(secondsWithoutPower)}` : "";
  const resource = e.attention.resourceId ? ` (${e.attention.resourceId})` : "";
  const attention = `${ATTENTION[e.attention.state] ?? e.attention.state}${resource}`;
  return `- ${e.id} (${e.type}, "${e.name}") status=${e.status} severity=${e.severity} priority=${priority}${power}\n    ${attention}${repairLine(e)}\n    sensors: ${sensors || "no readings"}`;
}

function resourceLine(r: ResourceView): string {
  const destination = r.assignedElementId ? ` → ${r.assignedElementId}` : "";
  return `- ${r.id} (${r.type}) ${r.status}${destination}`;
}

const ATTENTION: Record<string, string> = {
  unattended: "NOT COVERED",
  analyzing: "under analysis, no resource committed",
  resource_en_route: "ALREADY COVERED: resource en route",
  resource_assigned: "ALREADY COVERED: resource deployed",
  resolved: "resolved",
};

function topologyLine(e: Topology["edges"][number]): string {
  const to = e.to === "*" ? "the whole scenario" : e.to;
  return `- ${e.from} --${e.type}--> ${to}${e.note ? `\n    ${e.note}` : ""}`;
}

function remedyLine(r: Remedies["remedies"][number]): string {
  const req = r.requires ? ` REQUIRES: ${r.requires}.` : "";
  return `- ${r.resource} solves "${r.solves}" on ${r.appliesTo.join("/")} — ${r.minutes} min.${req}\n    ${r.effect}`;
}

function contactLine(c: Remedies["contacts"][number]): string {
  const scope = c.resourceId ? ` leads ${c.resourceId}` : c.elementId ? ` answers for ${c.elementId}` : "";
  return `- ${c.id}: ${c.name}, ${c.role}.${scope}${c.$note ? ` ${c.$note}` : ""}`;
}

function reportLine(r: Report): string {
  return `- [${r.source}]${r.elementId ? ` (${r.elementId})` : ""} ${r.text}`;
}

/**
 * A past incident handed to the model together with WHY it surfaced now.
 * Without that "why" the model cannot tell a semantic match from a plain type
 * filter, and `historyCitation` comes back empty or cites whatever was first.
 */
export interface HistoryEntry {
  incident: HistoricalIncident;
  /** what surfaced it: the live situation it resembles, or the type filter */
  retrievedFor: string;
}

function historyLine(h: HistoryEntry): string {
  const { incident } = h;
  return [
    `- [${incident.id}] ${incident.title} (${incident.date})`,
    `    Retrieved because: ${h.retrievedFor}`,
    `    What happened: ${incident.summary}`,
    `    Conclusion: ${incident.outcome}`,
  ].join("\n");
}

export interface AgentContext {
  simulationClock: string;
  elements: ElementView[];
  resources: ResourceView[];
  secondsWithoutPower: (elementId: string) => number;
  priorities: { elementId: string; score: number }[];
  currentPlan: AgentPlan | null;
  /** physical facts: what depends on what */
  topology: Topology;
  /** physical facts: which resource fixes what, and who can be called */
  remedies: Remedies;
  /** raw signals since the last deliberation, mostly noise */
  reports: Report[];
  /** past incidents retrieved for this situation, each with why it surfaced */
  history: HistoryEntry[];
  /** why this deliberation was triggered */
  reasons: string[];
}

export function buildMessages(
  ctx: AgentContext,
  rejections: string[] = [],
): ChatCompletionMessageParam[] {
  const priorityOf = new Map(ctx.priorities.map((p) => [p.elementId, p.score]));

  const parts = [
    `CRISIS CLOCK: ${ctx.simulationClock}`,
    "",
    "WHY YOU ARE DELIBERATING NOW:",
    ...ctx.reasons.map((m) => `- ${m}`),
    "",
    "SITES (priority = rule-computed clue, higher = more urgent):",
    ...ctx.elements.map((e) =>
      elementLine(e, ctx.secondsWithoutPower(e.id), priorityOf.get(e.id) ?? 0),
    ),
    "",
    "AVAILABLE RESOURCES — this is everything you have:",
    ...ctx.resources.map(resourceLine),
    "",
    "DEPENDENCIES (how the scenario is wired):",
    ...ctx.topology.edges.map(topologyLine),
    "",
    "REMEDIES (what fixes what; nothing outside this list exists):",
    ...ctx.remedies.remedies.map(remedyLine),
    "",
    "CONTACTS (who you can call or message, and the role they hold):",
    ...ctx.remedies.contacts.map(contactLine),
  ];

  if (ctx.reports.length > 0) {
    parts.push(
      "",
      `RAW SIGNALS (${ctx.reports.length} since your last deliberation) — triage them:`,
      ...ctx.reports.map(reportLine),
    );
  }

  if (ctx.history.length > 0) {
    parts.push(
      "",
      "PAST INCIDENTS OF THESE SITE TYPES — retrieved from the incident memory by",
      "similarity to what you are looking at now, closures of earlier runs included:",
      ...ctx.history.map(historyLine),
      'If one of these conclusions changes a decision, cite its id in "historyCitation".',
    );
  }

  if (ctx.currentPlan) {
    parts.push(
      "",
      `PLAN IN PROGRESS: ${ctx.currentPlan.objective}`,
      ...ctx.currentPlan.steps.map((s) => `- [${s.completed ? "x" : " "}] ${s.description}`),
      "",
      "If the plan is still good, keep it and adjust. If the facts have overtaken it, drop it and make a new one.",
    );
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];

  if (rejections.length > 0) {
    messages.push({
      role: "user",
      content: [
        "Your previous proposal violated hard rules and was REJECTED:",
        ...rejections.map((r) => `- ${r}`),
        "",
        "Fix those actions and return the complete decision again.",
      ].join("\n"),
    });
  }

  return messages;
}
