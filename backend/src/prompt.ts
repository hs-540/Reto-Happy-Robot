import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import type { AgentPlan, ElementView, HistoricalIncident, ResourceView } from "@swarmup/shared";
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

const SYSTEM_PROMPT = `You are the autonomous coordinator of a regional blackout crisis in the Community of Madrid.

You manage critical sites (hospital, substation, datacenter) with LIMITED, shared resources.
You decide alone: nobody will ask your permission or correct you between decisions.

YOUR JOB IN EVERY DELIBERATION
1. Separate signal from noise. Many alarms arrive and only a few change anything. State
   explicitly which ones you discard and why: that triage is part of your job.
2. Prioritize with the means THAT REMAIN, not with the ones that would be needed.
3. Decide concrete actions. "Monitor the situation" is not an action.
4. Communicate selectively: a hospital manager, a crew chief and a datacenter operator do
   NOT need the same message. Write each one for whoever receives it.
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
${JSON.stringify(AGENT_RULES)}`;

function elementLine(e: ElementView, secondsWithoutPower: number, priority: number): string {
  const sensors = Object.entries(e.sensors)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const power =
    secondsWithoutPower > 0 ? ` WITHOUT POWER for ${Math.floor(secondsWithoutPower / 60)}m${Math.floor(secondsWithoutPower % 60)}s` : "";
  return `- ${e.id} (${e.type}, "${e.name}") status=${e.status} severity=${e.severity} priority=${priority}${power}\n    sensors: ${sensors || "no readings"}`;
}

function resourceLine(r: ResourceView): string {
  const destination = r.assignedElementId ? ` → ${r.assignedElementId}` : "";
  return `- ${r.id} (${r.type}) ${r.status}${destination}`;
}

function historyLine(h: HistoricalIncident): string {
  return `- [${h.id}] ${h.title}\n    ${h.summary}\n    Lesson: ${h.outcome}`;
}

export interface AgentContext {
  simulationClock: string;
  elements: ElementView[];
  resources: ResourceView[];
  secondsWithoutPower: (elementId: string) => number;
  priorities: { elementId: string; score: number }[];
  currentPlan: AgentPlan | null;
  /** historical incidents of the involved element types */
  history: HistoricalIncident[];
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
  ];

  if (ctx.history.length > 0) {
    parts.push("", "PAST INCIDENTS OF THESE SITE TYPES:", ...ctx.history.map(historyLine));
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
