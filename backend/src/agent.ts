import type {
  Action,
  AgentPlan,
  AgentView,
  AttentionState,
  Decision,
  ElementStatus,
  ElementView,
  HistoricalIncident,
  StateView,
} from "@swarmup/shared";
import { validateAction } from "@swarmup/shared";
import type { ActionRegistry } from "./control.js";
import type { LlmClient } from "./llm.js";
import type { WorldEvent, World } from "./world.js";
import type { Feed } from "./feed.js";
import {
  AgentOutputSchema,
  buildMessages,
  type ProposedAction,
  type AgentOutput,
} from "./prompt.js";

/** Retries on actions rejected by the hard rules, before discarding them */
const MAX_RETRIES = 2;

/**
 * Total budget of a deliberation, retries included; once spent, the
 * deterministic fallback takes over. It has to cover the realistic worst case
 * with the provider's measured latency: one long call (~19s) plus a retry
 * after a hard-rule rejection.
 */
const DELIBERATION_BUDGET_MS = 60_000;

/** Decisions kept for `/api/agent` */
const MAX_DECISIONS = 20;

export interface Agent {
  /** One engine tick. Decides whether to deliberate; if it does, executes the outcome. */
  observe(state: StateView, events: WorldEvent[]): Promise<void>;
  view(): AgentView;
  /** Derived attention state, which the contract requires to be computed in the backend */
  attention(elementId: string): ElementView["attention"];
  reset(): void;
}

export interface AgentOptions {
  world: World;
  feed: Feed;
  llm: LlmClient;
  /** Registry of real actions: stamps them as executed and publishes them (#43, no human gate) */
  actionRegistry: ActionRegistry;
  history: HistoricalIncident[];
  /** Current simulated second */
  seconds: () => number;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("deliberation budget exhausted")), ms),
  );
}

export function createAgent(options: AgentOptions): Agent {
  const { world, feed, llm, actionRegistry, history, seconds } = options;

  let plan: AgentPlan | null = null;
  let decisions: Decision[] = [];
  /** communication actions already executed, most recent first */
  let actions: Action[] = [];
  /** status of the previous tick, to detect threshold crossings */
  let previousStatus = new Map<string, ElementStatus>();
  /** a deliberation in flight outlives a tick: they do not overlap */
  let deliberating = false;
  let counter = 0;

  function newId(prefix: string): string {
    counter += 1;
    return `${prefix}-${String(counter).padStart(3, "0")}`;
  }

  /* ─── Perception: has anything changed that deserves thinking? ───────── */

  function deliberationReasons(state: StateView, events: WorldEvent[]): string[] {
    const reasons: string[] = [];

    for (const ev of events) {
      if (ev.type === "eta_missed") {
        reasons.push(`${ev.resourceId} misses its ETA to ${ev.elementId}: the plan counted on it`);
      } else if (ev.type === "deadline_exceeded") {
        reasons.push(
          `${ev.elementId} has been ${ev.minutesWithoutPower} min without power and has exceeded its limit`,
        );
      }
      // `arrival` is incremental adjustment: it does not justify regenerating the strategy
    }

    for (const e of state.elements) {
      const before = previousStatus.get(e.id);
      if (before !== undefined && before !== e.status && e.status !== "normal") {
        reasons.push(`${e.id} goes from ${before} to ${e.status}`);
      }
    }

    // startup: there is a crisis and there is still no plan
    if (plan === null && state.elements.some((e) => e.status === "critical" || e.status === "degraded")) {
      reasons.push("first assessment of the crisis: no plan yet");
    }

    return reasons;
  }

  /* ─── Deterministic fallback: the agent degrades, it never freezes ───── */

  function decideByRules(state: StateView, reasons: string[]): AgentOutput {
    const context = world.context(state.elements);
    const ranking = world.priorities(state.elements);
    const target = ranking.find((p) => {
      const e = state.elements.find((x) => x.id === p.elementId);
      return e && e.status !== "normal" && e.status !== "resolved";
    });

    if (!target) {
      return {
        evaluation: { discarded: [], actionable: [] },
        objective: "No active incidents: watch mode",
        steps: [],
        decisions: [],
      };
    }

    const free = state.resources.find((r) => r.status === "available");
    const action: ProposedAction =
      free &&
      validateAction(
        { type: "assign_resource", elementId: target.elementId, resourceId: free.id },
        context,
      ).allowed
        ? {
            type: "assign_resource",
            elementId: target.elementId,
            resourceId: free.id,
            channel: null,
            recipient: null,
            message: `Deploy ${free.id} to the highest-priority site`,
          }
        : {
            type: "wait",
            elementId: target.elementId,
            resourceId: null,
            channel: null,
            recipient: null,
            message: "No assignable resources right now",
          };

    return {
      evaluation: { discarded: [], actionable: reasons },
      objective: `Degraded mode (no LLM): attend ${target.elementId} by rule priority`,
      steps: [{ description: action.message, elementId: target.elementId }],
      decisions: [
        {
          elementId: target.elementId,
          priority: 1,
          reasoning: `Deterministic fallback: ${target.elementId} leads the computed priority (${target.score}).`,
          historyCitation: null,
          actions: [action],
        },
      ],
    };
  }

  /* ─── Deliberation: LLM with retry against the hard rules ────────────── */

  async function deliberate(state: StateView, reasons: string[]): Promise<AgentOutput> {
    const involvedTypes = new Set(
      state.elements.filter((e) => e.status !== "normal").map((e) => e.type),
    );
    const ctx = {
      simulationClock: state.simulationClock,
      elements: state.elements,
      resources: state.resources,
      secondsWithoutPower: (id: string) => world.secondsWithoutPower(id),
      priorities: world.priorities(state.elements),
      currentPlan: plan,
      history: history.filter((h) => involvedTypes.has(h.type)),
      reasons,
    };

    let rejections: string[] = [];
    let last: AgentOutput | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await llm.structured(
        buildMessages(ctx, rejections),
        AgentOutputSchema,
        "agent_decision",
      );
      last = response.data;
      rejections = collectRejections(last, state);
      if (rejections.length === 0) return last;

      for (const reason of rejections) {
        feed.publish({ kind: "system", message: `Action blocked by hard rules — ${reason}` });
      }
    }

    // retries exhausted: illegal actions are discarded, the rest goes on
    if (!last) throw new Error("the LLM returned no proposal");
    return {
      ...last,
      decisions: last.decisions.map((d) => ({
        ...d,
        actions: d.actions.filter((a) => isLegal(a, state)),
      })),
    };
  }

  function isLegal(action: ProposedAction, state: StateView): boolean {
    return validateAction(
      {
        type: action.type,
        elementId: action.elementId,
        resourceId: action.resourceId ?? undefined,
      },
      world.context(state.elements),
    ).allowed;
  }

  function collectRejections(output: AgentOutput, state: StateView): string[] {
    const context = world.context(state.elements);
    const reasons: string[] = [];
    for (const d of output.decisions) {
      for (const a of d.actions) {
        const verdict = validateAction(
          { type: a.type, elementId: a.elementId, resourceId: a.resourceId ?? undefined },
          context,
        );
        if (!verdict.allowed) {
          reasons.push(`[${verdict.rule}] ${a.type} on ${a.elementId}: ${verdict.reason}`);
        }
      }
    }
    return reasons;
  }

  /* ─── Execution ──────────────────────────────────────────────────────── */

  function execute(output: AgentOutput, state: StateView): void {
    const now = state.simulationClock;

    if (output.evaluation.discarded.length > 0) {
      feed.publish({
        kind: "system",
        message: `Triage: ${output.evaluation.actionable.length} actionable signals, ${output.evaluation.discarded.length} discarded (${output.evaluation.discarded.join("; ")})`,
      });
    }

    const provokesReplan = output.decisions.length > 0;
    plan = {
      objective: output.objective,
      steps: output.steps.map((s, i) => ({
        id: `s${i + 1}`,
        description: s.description,
        elementId: s.elementId,
        completed: false,
      })),
      generatedAt: now,
      replanOf: plan === null ? null : (decisions[0]?.id ?? null),
    };

    for (const d of output.decisions) {
      const decision: Decision = {
        id: newId("dec"),
        timestamp: now,
        elementId: d.elementId,
        priority: d.priority,
        reasoning: d.historyCitation
          ? `${d.reasoning} [history: ${d.historyCitation}]`
          : d.reasoning,
        provokesReplan,
        actions: [],
      };

      for (const a of d.actions) {
        if (a.type === "assign_resource" && a.resourceId) {
          const result = world.assign(a.resourceId, a.elementId, seconds());
          feed.publish({
            kind: "system",
            message: result.ok
              ? `${a.resourceId} → ${a.elementId}, ETA ${result.etaSeconds}s`
              : `Could not assign ${a.resourceId}: ${result.reason}`,
          });
        } else if (a.type === "contact" && a.channel) {
          // No human gate (#43): the registry stamps it as executed and publishes it
          const action = actionRegistry.record({
            type: a.channel,
            targetElementId: a.elementId,
            recipient: a.recipient ?? undefined,
            message: a.message,
          });
          actions = [action, ...actions].slice(0, MAX_DECISIONS);
          decision.actions.push(action);
        }
      }

      decisions = [decision, ...decisions].slice(0, MAX_DECISIONS);
      feed.publish({
        kind: "decision",
        elementId: decision.elementId,
        decisionId: decision.id,
        priority: decision.priority,
        reasoning: decision.reasoning,
        provokesReplan: decision.provokesReplan,
      });
    }
  }

  /* ─── Public API ─────────────────────────────────────────────────────── */

  return {
    async observe(state, events): Promise<void> {
      const reasons = deliberationReasons(state, events);
      previousStatus = new Map(state.elements.map((e) => [e.id, e.status]));

      if (reasons.length === 0 || deliberating || state.paused) return;

      deliberating = true;
      try {
        let output: AgentOutput;
        try {
          output = await Promise.race([deliberate(state, reasons), timeoutAfter(DELIBERATION_BUDGET_MS)]);
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`[agent] deliberation failed (${cause}); fallback to rules`);
          feed.publish({
            kind: "system",
            message: "LLM unavailable: the engine keeps running in deterministic rules mode",
          });
          output = decideByRules(state, reasons);
        }
        execute(output, state);
      } finally {
        deliberating = false;
      }
    },

    view(): AgentView {
      return {
        tick: 0,
        paused: false,
        currentPlan: plan,
        decisions,
        actions,
      };
    },

    attention(elementId): ElementView["attention"] {
      const resource = world.resources().find((r) => r.assignedElementId === elementId);
      const decision = decisions.find((d) => d.elementId === elementId);
      let state: AttentionState = "unattended";
      if (resource) state = "resource_assigned";
      else if (decision) state = "analyzing";
      return {
        state,
        resourceId: resource?.id ?? null,
        activeDecisionId: decision?.id ?? null,
      };
    },


    reset(): void {
      plan = null;
      decisions = [];
      actions = [];
      previousStatus = new Map();
      counter = 0;
    },
  };
}
