import type {
  Action,
  AgentPlan,
  AgentView,
  AttentionState,
  Decision,
  ElementStatus,
  ElementView,
  CallClosure,
  HistoricalIncident,
  Remedies,
  Report,
  StateView,
  Topology,
} from "@swarmup/shared";
import { validateAction } from "@swarmup/shared";
import type { ActionRegistry } from "./control.js";
import type { HappyRobotClient } from "./happyrobot.js";
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
/**
 * One retry, not two: each call costs 15-35s, so three attempts ate the whole
 * budget and guaranteed the fallback precisely when the agent was correcting
 * itself.
 */
const MAX_RETRIES = 1;

/** Sources whose arrival alone justifies waking the engine */
const HIGH_SIGNAL_SOURCES: readonly string[] = ["emergency_call", "field"];

/** Backlog of low-signal reports that is worth a triage pass on its own */
const REPORT_BACKLOG = 8;

/**
 * Reports and historical incidents handed over per deliberation. Measured: with
 * everything at once the model burns its budget on decisions and leaves the
 * communications field EMPTY — the very thing it exists for. Trimmed, it gets
 * there. High-signal reports go first, so the needle in the haystack survives
 * the cut; the rest is a sample large enough for the triage to be real.
 */
const MAX_REPORTS_PER_TURN = 12;
const MAX_HISTORY_PER_TURN = 3;

/**
 * Total budget of a deliberation, retries included; once spent, the
 * deterministic fallback takes over. It has to cover the realistic worst case
 * with the provider's measured latency: one long call (~19s) plus a retry
 * after a hard-rule rejection.
 */
const DELIBERATION_BUDGET_MS = 75_000;

/** Decisions kept for `/api/agent` */
const MAX_DECISIONS = 20;

export interface Agent {
  /** One engine tick. Decides whether to deliberate; if it does, executes the outcome. */
  observe(state: StateView, events: WorldEvent[]): Promise<void>;
  /**
   * The part of `AgentView` the agent owns. `tick` and `paused` belong to the
   * simulation clock, so the HTTP layer adds them from `sim`.
   */
  view(): Omit<AgentView, "tick" | "paused">;
  /** Derived attention state, which the contract requires to be computed in the backend */
  attention(elementId: string): ElementView["attention"];
  /** Raw incoming signal; buffered until the next deliberation */
  queueReport(report: Report): void;
  /**
   * Outcome of a real call. A refusal or a delay invalidates the ETA the plan
   * was built on, so it forces replanning on the next tick.
   */
  closeCall(closure: CallClosure): void;
  reset(): void;
}

export interface AgentOptions {
  world: World;
  feed: Feed;
  llm: LlmClient;
  /** Registry of real actions: stamps them as executed and publishes them (#43, no human gate) */
  actionRegistry: ActionRegistry;
  /** channel to the real world: calls and messages */
  happyrobot: HappyRobotClient;
  history: HistoricalIncident[];
  topology: Topology;
  remedies: Remedies;
  /** Current simulated second */
  seconds: () => number;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("deliberation budget exhausted")), ms),
  );
}

export function createAgent(options: AgentOptions): Agent {
  const { world, feed, llm, actionRegistry, happyrobot, history, topology, remedies, seconds } =
    options;

  let plan: AgentPlan | null = null;
  let decisions: Decision[] = [];
  /** communication actions already executed, most recent first */
  let actions: Action[] = [];
  /** status of the previous tick, to detect threshold crossings */
  let previousStatus = new Map<string, ElementStatus>();
  /** a deliberation in flight outlives a tick: they do not overlap */
  let deliberating = false;
  let counter = 0;
  /**
   * Warnings already sent, by recipient and text. With real phones, repeating
   * the same message to the same person is calling them twice to say the same
   * thing: it annoys and costs credibility. If the text changes, it goes out.
   */
  const warningsSent = new Set<string>();
  /** raw signals accumulated since the last deliberation */
  let pendingReports: Report[] = [];
  /** extra reasons injected from outside (call outcomes) */
  let externalReasons: string[] = [];

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

    // Raw signals have to be able to wake the engine on their own: a 112 call
    // reporting a home ventilator is not going to change any sensor reading,
    // and if only status changes trigger deliberation that call is never read.
    const highSignal = pendingReports.filter((r) => HIGH_SIGNAL_SOURCES.includes(r.source));
    if (highSignal.length > 0) {
      reasons.push(
        `${highSignal.length} signal(s) from emergency calls or field teams awaiting triage`,
      );
    } else if (pendingReports.length >= REPORT_BACKLOG) {
      reasons.push(`${pendingReports.length} unprocessed signals piling up`);
    }

    // a refusal or a delay reported by phone invalidates the plan's ETA
    reasons.push(...externalReasons);
    externalReasons = [];

    // startup: there is a crisis and there is still no plan
    if (plan === null && state.elements.some((e) => e.status === "critical" || e.status === "degraded")) {
      reasons.push("first assessment of the crisis: no plan yet");
    }

    return reasons;
  }

  /* ─── Deterministic fallback: the agent degrades, it never freezes ───── */

  /** Contact who answers for a site, for the fallback's automatic warning */
  function leadFor(elementId: string): string | null {
    return remedies.contacts.find((c) => c.elementId === elementId)?.id ?? null;
  }

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
        communications: [],
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
      // even without the LLM the site lead is warned: going silent is no option
      communications: leadFor(target.elementId)
        ? [
            {
              recipient: leadFor(target.elementId) as string,
              channel: "chat_message" as const,
              elementId: target.elementId,
              message: `Active incident at ${target.elementId}. ${action.message}.`,
              reason: "Automatic warning in degraded mode",
            },
          ]
        : [],
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
      history: history.filter((h) => involvedTypes.has(h.type)).slice(0, MAX_HISTORY_PER_TURN),
      topology,
      remedies,
      reports: [
        ...pendingReports.filter((r) => HIGH_SIGNAL_SOURCES.includes(r.source)),
        ...pendingReports.filter((r) => !HIGH_SIGNAL_SOURCES.includes(r.source)),
      ].slice(0, MAX_REPORTS_PER_TURN),
      reasons,
    };

    // consumed: the next deliberation only sees what arrives from now on
    pendingReports = [];

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

  /**
   * Replanning means ABANDONING a plan that already existed because the facts
   * overtook it. A status change happens every tick and does not qualify: if
   * everything is flagged, the badge stops distinguishing anything and the
   * moment that matters — the crew missing its ETA — is lost.
   */
  const REPLAN_REASONS = ["misses its ETA", "exceeded its limit", "Call "];

  function isReplan(reasons: string[]): boolean {
    if (plan === null) return false; // no plan to abandon
    return reasons.some((r) => REPLAN_REASONS.some((p) => r.includes(p)));
  }

  /**
   * The LLM sometimes uses `elementId` as a free-text subject and puts a
   * resource or a contact there. The decision is still sound; the label is what
   * failed. Re-anchor it to the site it really concerns instead of dropping it.
   */
  function anchorToSite(id: string, state: StateView): string {
    if (state.elements.some((e) => e.id === id)) return id;
    const byResource = state.resources.find((r) => r.id === id)?.assignedElementId;
    if (byResource && state.elements.some((e) => e.id === byResource)) return byResource;
    const contact = remedies.contacts.find((c) => c.id === id);
    if (contact?.elementId && state.elements.some((e) => e.id === contact.elementId)) {
      return contact.elementId;
    }
    if (contact?.resourceId) {
      const dest = state.resources.find((r) => r.id === contact.resourceId)?.assignedElementId;
      if (dest) return dest;
    }
    return world.priorities(state.elements)[0]?.elementId ?? id;
  }

  function execute(output: AgentOutput, state: StateView, provokesReplan: boolean): void {
    const now = state.simulationClock;

    if (output.evaluation.discarded.length > 0) {
      feed.publish({
        kind: "system",
        message: `Triage: ${output.evaluation.actionable.length} actionable signals, ${output.evaluation.discarded.length} discarded (${output.evaluation.discarded.join("; ")})`,
      });
    }

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

    // Communications are a field of their own: they execute every time, even if
    // the model put no `contact` action inside a decision.
    for (const c of output.communications) {
      const fingerprint = `${c.recipient}|${c.message.trim()}`;
      if (warningsSent.has(fingerprint)) continue;
      const contact = remedies.contacts.find((x) => x.id === c.recipient);
      if (!contact) {
        feed.publish({
          kind: "system",
          message: `Unknown recipient "${c.recipient}": the warning does not go out`,
        });
        continue;
      }
      warningsSent.add(fingerprint);
      const action = actionRegistry.record({
        type: c.channel,
        targetElementId: anchorToSite(c.elementId, state),
        recipient: contact.id,
        message: c.message,
      });
      actions = [action, ...actions].slice(0, MAX_DECISIONS);
      // Here the system leaves the laptop: a real phone rings.
      happyrobot.contact({
        actionId: action.id,
        contact,
        channel: c.channel,
        message: c.message,
        context: { elementId: action.targetElementId, situation: c.reason },
      });
    }

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
        execute(output, state, isReplan(reasons));
      } finally {
        deliberating = false;
      }
    },

    view() {
      return {
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


    queueReport(report): void {
      pendingReports.push(report);
    },

    closeCall(closure): void {
      const action = actions.find((a) => a.id === closure.actionId);
      feed.publish({
        kind: "outcome",
        elementId: action?.targetElementId ?? null,
        actionId: closure.actionId,
        outcome: closure.outcome,
        delayMinutes: closure.delayMinutes,
        summary: closure.summary,
      });
      if (closure.outcome === "accepted") return;
      const delay =
        closure.delayMinutes === null ? "no concrete timeframe" : `${closure.delayMinutes} min delay`;
      externalReasons.push(
        `Call ${closure.actionId} ended as "${closure.outcome}" (${delay}): ${closure.summary}. The plan relied on a deadline that no longer holds.`,
      );
    },

    reset(): void {
      plan = null;
      decisions = [];
      actions = [];
      previousStatus = new Map();
      warningsSent.clear();
      pendingReports = [];
      externalReasons = [];
      counter = 0;
    },
  };
}
