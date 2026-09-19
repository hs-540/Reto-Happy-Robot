import type {
  Action,
  AgentPlan,
  AgentView,
  AttentionState,
  Contact,
  Decision,
  ElementStatus,
  ElementView,
  CallClosure,
  HistoricalIncident,
  OperatorDirective,
  Remedies,
  Report,
  StateView,
  Topology,
  ValidationContext,
  ValidatableResource,
} from "@swarmup/shared";
import { MAX_MINUTES_WITHOUT_POWER, validateAction } from "@swarmup/shared";
import type { ActionRegistry } from "./control.js";
import type { HappyRobotClient } from "./happyrobot.js";
import { ATTEMPT_TIMEOUT_MS, type LlmClient } from "./llm.js";
import { TIME_SCALE } from "./sim.js";
import type { WorldEvent, World } from "./world.js";
import type { Feed } from "./feed.js";
import type { RunStats } from "./stats.js";
import type { HistoryRag } from "./rag/history.js";
import { staticHistory, tryRetrieveHistory } from "./rag/retrieval.js";
import {
  AgentOutputSchema,
  buildMessages,
  countdown,
  coverageGaps,
  type OperatorIntent,
  type ProposedAction,
  type AgentOutput,
} from "./prompt.js";

/**
 * Retries on actions rejected by the hard rules, before discarding them.
 *
 * One retry, not two: re-measured, a single call costs 15-112s (see
 * `ATTEMPT_TIMEOUT_MS`), so three attempts ate the whole budget and guaranteed
 * the fallback precisely when the agent was correcting itself. One is also
 * cheap to keep: over 8 live deliberations no first proposal broke a hard rule,
 * so this second attempt hardly ever runs.
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
 * Ceiling on how long a deliberation may be worth waiting for. The simulation
 * runs at `TIME_SCALE` crisis-seconds per real second (configurable in the
 * `.env`), and the tightest clock in the scenario is the hospital's:
 * `maxMinutesWithoutPower.hospital` before `hospital-power-deadline` bites.
 * Spending longer than that on one decision means answering about a hospital
 * that has already blown its limit, so the answer arrives describing a world
 * that no longer exists. The ceiling derives from the configured scale:
 * 8 crisis-minutes are 32 s of wall clock at 15x and 80 s at 6x.
 */
const STALENESS_CEILING_MS =
  (MAX_MINUTES_WITHOUT_POWER.hospital * 60 * 1000) / TIME_SCALE;

/**
 * Total budget of a deliberation, retries included; once spent, the contingency
 * playbook takes over.
 *
 * It used to be a hand-written 75s while the gateway allowed 45s per attempt
 * and `MAX_RETRIES` allowed two attempts — 90s of legal work against a 75s
 * budget, so a deliberation that retried was killed at the exact moment it was
 * correcting itself. Deriving it removes the chance of that drifting again.
 *
 * Raising it to cover two attempts is not an option: two 90s attempts is 180s,
 * or 18 crisis-minutes at 6x, well past the staleness ceiling. So the ceiling
 * wins, and the budget is only ever large enough that a *single* attempt is
 * never cut off by it — the gateway's own timeout is what ends an attempt, and
 * its error ("timeout or connection", with the gateway named) is diagnosable,
 * whereas "deliberation budget exhausted" says nothing about who failed.
 *
 * The retry is kept: measured over 8 live deliberations, 0 first proposals
 * broke a hard rule, so the second attempt almost never runs and costs nothing
 * in the common case. When it does run, it is the agent fixing itself, and the
 * ceiling — not an arbitrary constant — is what decides it has run too long.
 */
const DELIBERATION_BUDGET_MS = Math.max(ATTEMPT_TIMEOUT_MS + 5_000, STALENESS_CEILING_MS);

/** Decisions kept for `/api/agent` */
const MAX_DECISIONS = 20;

/**
 * How long the engine tolerates idle capacity before asking the model again.
 *
 * A freed resource next to an uncovered site it could serve generates no
 * standing signal: no sensor moves, no status changes, and the `released`
 * wake-up was consumed by the one deliberation that followed it. If that
 * deliberation held the unit back (a reserve rule, a judgement call) or failed
 * outright, both the unit and the site sit idle until something unrelated
 * happens. This cooldown turns the pairing into a standing reason: every so
 * often, while a gap exists, the engine re-deliberates with the COVERAGE GAPS
 * list in front of the model. It is not a hot loop — each pass is a real call,
 * and holding a reserve stays legal, but the justification it writes for it is
 * what the next pass reads.
 */
const IDLE_WATCH_COOLDOWN_MS = 30_000;

/**
 * How much a priority order from the operator moves a site in the ranking.
 *
 * Calibrated against the catalog's own weights: a status jump is worth 40
 * (degraded 20 → critical 60) and the widest gap between two site types is 24
 * (hospital 30, junction 6). At 40, an operator can lift a degraded site over
 * a critical one of the same type, or over a critical site of a lighter type —
 * which is exactly the override a human watching the map needs. It is not
 * enough to drag a junction above a hospital that has been dark for minutes:
 * that gap is what the hard rules exist to defend, and an order cannot buy it.
 */
const OPERATOR_PRIORITY_BOOST = 40;

export interface Agent {
  /** One engine tick. Decides whether to deliberate; if it does, executes the outcome. */
  observe(state: StateView, events: WorldEvent[]): Promise<void>;
  /**
   * The part of `AgentView` the agent owns. `tick` and `paused` belong to the
   * simulation clock, so the HTTP layer adds them from `sim`.
   */
  view(): Omit<AgentView, "tick" | "paused">;
  /**
   * Derived attention state, which the contract requires to be computed in the
   * backend. Needs the element's `status` too: whether a site is already
   * resolved is not something the agent can tell from its own decisions.
   */
  attention(elementId: string, status: ElementStatus): ElementView["attention"];
  /** Raw incoming signal; buffered until the next deliberation */
  queueReport(report: Report): void;
  /**
   * Outcome of a real call. A refusal or a delay invalidates the ETA the plan
   * was built on, so it forces replanning on the next tick.
   */
  closeCall(closure: CallClosure): void;
  /**
   * Orders the human operator gave in the chat, already read by the model and
   * reduced to intents. Executed here, against the same validator the model's
   * own proposals face: what comes back says, per order, whether it took
   * effect and which rule refused it if it did not. Every accepted order is
   * also a replanning trigger — the operator changed the problem.
   */
  command(state: StateView, intents: OperatorIntent[]): OperatorDirective[];
  /** Orders still in force: priority biases and standing notes */
  standing(): OperatorDirective[];
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
  /** Static history shipped in `data/history`: the floor when retrieval is not available */
  history: HistoricalIncident[];
  /**
   * Incident memory, resolved when Chroma is up (`null` when it never came up).
   * Optional and never awaited outside its own budget: it is what the agent
   * remembers, not something the agent depends on.
   */
  rag?: Promise<HistoryRag | null> | null;
  topology: Topology;
  remedies: Remedies;
  /** Current simulated second */
  seconds: () => number;
  /** Per-run counters for the end-of-simulation summary (optional, tests skip it) */
  stats?: RunStats;
}

/**
 * Runs `work` against the budget and CLEARS the timer either way. `Promise.race`
 * cannot cancel the loser, so a deliberation that answers in time still left its
 * timer armed: the process lingered for the whole budget after the work was
 * done, which is a dead wait at the end of every test run and a server that will
 * not shut down promptly.
 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deliberation budget exhausted")), ms);
  });
  return Promise.race([work, budget]).finally(() => clearTimeout(timer));
}

/** Accents and punctuation out, so "Dr. Elena Duarte" and "hospital-lead" compare alike */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The model is asked for a bare id from the CONTACTS list and now and then hands
 * back the person instead: "Dr. Elena Duarte (hospital-lead)". Measured over a
 * full run, an exact `===` dropped FOUR warnings that way, in the tick that
 * mattered most — the agent had written them, decided who needed them, and
 * nobody was called. The id is right there in the text: recover it rather than
 * throw the warning away. Tried in order of how much it proves: the id itself,
 * then the person's name, then their role.
 */
export function resolveContact(
  contacts: readonly Contact[],
  recipient: string,
): Contact | null {
  const exact = contacts.find((c) => c.id === recipient);
  if (exact) return exact;

  const written = normalise(recipient);
  if (written === "") return null;

  /** Among the contacts whose field appears in the text, the longest one wins:
   *  "crew-chief-2" written in prose must not fall back to "crew-chief". */
  function mostSpecific(field: "id" | "name" | "role"): Contact | undefined {
    let best: Contact | undefined;
    for (const c of contacts) {
      const needle = normalise(c[field]);
      if (needle === "" || !written.includes(needle)) continue;
      if (!best || needle.length > normalise(best[field]).length) best = c;
    }
    return best;
  }

  return mostSpecific("id") ?? mostSpecific("name") ?? mostSpecific("role") ?? null;
}

/**
 * Canonical shape of an id for comparison: case out, the lookalikes the model
 * swaps when typing (O/0, I/L/1) folded, separators unified and zero-padding
 * dropped. Applied to BOTH sides, so "sub-O2" ≡ "sub-02" and "crew-O1" ≡
 * "crew-1" without either spelling being "correct".
 */
function canonId(text: string): string {
  return text
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-0*(?=\d)/g, "-");
}

/**
 * The model now and then mistypes the very id it was handed: "sub-O2" with a
 * letter O, a dropped zero, a stray capital. The decision is sound; the label
 * is what failed — and an assignment carrying "sub-O2" dies at `world.assign`
 * as "nonexistent element" after the model already spent its reasoning on it.
 * Recover the id rather than bounce the move, the way `resolveContact`
 * recovers who a warning is really for. Exact match, canonical match, then a
 * UNIQUE prefix in either direction; anything ambiguous ("tower-0", bare
 * "sub") comes back unchanged rather than guessed.
 */
export function resolveElementId(
  proposed: string,
  candidates: readonly { id: string }[],
): string {
  if (candidates.some((c) => c.id === proposed)) return proposed;
  const target = canonId(proposed);
  if (target === "") return proposed;
  const canonical = candidates.find((c) => canonId(c.id) === target);
  if (canonical) return canonical.id;
  const partial = candidates.filter(
    (c) => canonId(c.id).startsWith(target) || target.startsWith(canonId(c.id)),
  );
  return partial.length === 1 ? partial[0].id : proposed;
}

/**
 * The model's whole output with every id it had to type re-anchored to the
 * world it was handed: decision and action elementIds against the sites,
 * resourceIds against the fleet, history citations against the retrieved
 * incidents. Runs BEFORE validation, so the retry loop, the sequential
 * checks and `execute` all see the id that was meant — a proposal is judged
 * on its merits, not on its typos.
 */
export function reanchorOutput(
  output: AgentOutput,
  state: StateView,
  history: readonly { incident: { id: string } }[],
): AgentOutput {
  // `resolveElementId` passes "" through unchanged, so the non-nullable
  // fields (everything but plan steps) need no null handling
  const resolveSite = (id: string): string => resolveElementId(id, state.elements);
  const resolveUnit = (id: string): string => resolveElementId(id, state.resources);
  const resolveNullable = (id: string | null): string | null =>
    id === null ? null : resolveElementId(id, state.elements);
  return {
    ...output,
    steps: output.steps.map((s) => ({ ...s, elementId: resolveNullable(s.elementId) })),
    communications: output.communications.map((c) => ({
      ...c,
      elementId: resolveSite(c.elementId),
    })),
    decisions: output.decisions.map((d) => ({
      ...d,
      elementId: resolveSite(d.elementId),
      historyCitation:
        d.historyCitation === null
          ? null
          : resolveElementId(d.historyCitation, history.map((h) => ({ id: h.incident.id }))),
      actions: d.actions.map((a) => ({
        ...a,
        elementId: resolveSite(a.elementId),
        resourceId: a.resourceId === null ? null : resolveUnit(a.resourceId),
      })),
    })),
  };
}

/* ─── Mechanical pairing and sequential validation ───────────────────── */

export interface GreedyAssignment {
  resourceId: string;
  resourceType: string;
  elementId: string;
  /** rule priority of the site it was paired with */
  score: number;
}

/**
 * Validates one proposed action against the fleet as it stands after the
 * actions before it, and on success consumes the resource it assigns.
 *
 * Validating a whole output against the SAME pre-execution snapshot let two
 * actions promise the same unit: both passed, the first `world.assign` took
 * it, and the second died at execution as "not available (status
 * in_transit)" — a blocked action the retry loop never got to fix. Here each
 * action sees the state the previous ones leave behind, so the duplicate is
 * caught as a rejection (the model gets to correct it) or stripped (the
 * fallback keeps the first and drops the rest), and the hospital ration in
 * `hospital-power-priority` re-engages the moment its surplus is consumed.
 */
function judge(
  action: Pick<ProposedAction, "type" | "elementId" | "resourceId">,
  elements: ValidationContext["elements"],
  fleet: ValidatableResource[],
): ReturnType<typeof validateAction> {
  const verdict = validateAction(
    {
      type: action.type,
      elementId: action.elementId,
      resourceId: action.resourceId ?? undefined,
    },
    { elements, resources: fleet },
  );
  if (verdict.allowed && action.type === "assign_resource" && action.resourceId) {
    const unit = fleet.find((r) => r.id === action.resourceId);
    if (unit) {
      unit.status = "in_transit";
      unit.assignedElementId = action.elementId;
    }
  }
  return verdict;
}

/**
 * Greedy pairing of free units to uncovered sites, in rule-priority order.
 *
 * The one pairing both no-judgement paths share: the contingency playbook
 * (the LLM failed outright) and the idle-capacity pass (nothing woke the
 * engine and units sit next to gaps). Each pairing must satisfy three things
 * — the site is uncovered, the remedy catalog declares the unit fits it, and
 * the hard rules allow the assignment against the state the earlier pairings
 * leave behind — so a unit is never promised to two sites at once.
 */
export function greedyAssignments(
  candidates: readonly { elementId: string; score: number }[],
  context: ValidationContext,
  remedies: Remedies,
): GreedyAssignment[] {
  const typeOf = new Map(context.elements.map((e) => [e.id, e.type]));
  const fleet = context.resources.map((r) => ({ ...r }));
  const remedyApplies = (resourceType: string, elementType: string): boolean =>
    remedies.remedies.some(
      (r) =>
        r.resource === resourceType && (r.appliesTo as readonly string[]).includes(elementType),
    );
  const assignments: GreedyAssignment[] = [];
  for (const candidate of candidates) {
    const covered = fleet.some(
      (r) =>
        r.assignedElementId === candidate.elementId &&
        (r.status === "assigned" || r.status === "in_transit"),
    );
    if (covered) continue;
    const unit = fleet.find(
      (r) =>
        r.status === "available" &&
        remedyApplies(r.type, typeOf.get(candidate.elementId) ?? "") &&
        judge(
          { type: "assign_resource", elementId: candidate.elementId, resourceId: r.id },
          context.elements,
          fleet,
        ).allowed,
    );
    if (!unit) continue;
    assignments.push({
      resourceId: unit.id,
      resourceType: unit.type,
      elementId: candidate.elementId,
      score: candidate.score,
    });
  }
  return assignments;
}

/**
 * Rejections of a whole proposal, in output order, each action judged against
 * the state its predecessors leave behind (see `judge`). This is what the
 * retry loop hands back to the model.
 */
export function validateSequentially(
  output: AgentOutput,
  context: ValidationContext,
): string[] {
  const fleet = context.resources.map((r) => ({ ...r }));
  const rejections: string[] = [];
  for (const d of output.decisions) {
    for (const a of d.actions) {
      const verdict = judge(a, context.elements, fleet);
      if (!verdict.allowed) {
        rejections.push(`[${verdict.rule}] ${a.type} on ${a.elementId}: ${verdict.reason}`);
      }
    }
  }
  return rejections;
}

/**
 * The retry budget is spent: drop the actions that are still illegal and let
 * the rest of the plan go ahead. Sequential, like `validateSequentially` — a
 * legal first assignment must not keep an illegal duplicate of the same unit
 * alive.
 */
export function stripIllegalActions(
  output: AgentOutput,
  context: ValidationContext,
): AgentOutput {
  const fleet = context.resources.map((r) => ({ ...r }));
  return {
    ...output,
    decisions: output.decisions.map((d) => ({
      ...d,
      actions: d.actions.filter((a) => judge(a, context.elements, fleet).allowed),
    })),
  };
}

export function createAgent(options: AgentOptions): Agent {
  const {
    world,
    feed,
    llm,
    actionRegistry,
    happyrobot,
    history,
    rag = null,
    topology,
    remedies,
    seconds,
    stats,
  } = options;

  let plan: AgentPlan | null = null;
  let decisions: Decision[] = [];
  /** communication actions already executed, most recent first */
  let actions: Action[] = [];
  /** status of the previous tick, to detect threshold crossings */
  let previousStatus = new Map<string, ElementStatus>();
  /** a deliberation in flight outlives a tick: they do not overlap */
  let deliberating = false;
  /**
   * World events seen while a deliberation was in flight, merged into the next
   * one. A tick during a deliberation must not lose its news: the release of a
   * resource, for one, is a wake-up no sensor will ever repeat later — without
   * the buffer a unit freed mid-deliberation sits idle until something else
   * happens to wake the engine.
   */
  let bufferedEvents: WorldEvent[] = [];
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
  /** when the last deliberation finished, for the idle-capacity cooldown */
  let lastDeliberationEnd = 0;
  /**
   * Operator orders that outlive the turn they were given in: priority biases
   * and notes. `assign` and `release` are not here — they already happened,
   * and repeating them to the model every deliberation would read as a
   * standing instruction to keep doing it.
   */
  let standingDirectives: OperatorDirective[] = [];

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
      } else if (ev.type === "released") {
        // A freed resource is capacity the engine did not have a moment ago,
        // and nothing else would wake it: no sensor moved. Deliberate, but do
        // not replan — the plan in flight is still valid, it just has one more
        // resource to spend (see REPLAN_REASONS).
        reasons.push(`${ev.resourceId} is free again after ${ev.elementId} and can be reassigned`);
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

    // Standing wake-up, on a cooldown: uncovered sites with free units that
    // fit them. This is the state a freed resource leaves behind when its
    // deliberation did not reassign it — no event will ever announce it twice.
    if (performance.now() - lastDeliberationEnd >= IDLE_WATCH_COOLDOWN_MS) {
      const gaps = coverageGaps(state.elements, state.resources, remedies);
      if (gaps.length > 0) {
        reasons.push(
          `idle capacity watch: ${gaps
            .map((g) => `${g.elementId} is uncovered while ${g.freeResourceIds.join(", ")} stand free`)
            .join("; ")}`,
        );
      }
    }

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

  /**
   * Whoever the contingency playbook escalates to when it cannot act itself:
   * the site's own lead, or the first contact in the roster as a last resort.
   * Going silent about a site nobody is covering is the one outcome that is
   * strictly worse than a bad assignment.
   */
  function escalationContactFor(elementId: string): string | null {
    return leadFor(elementId) ?? remedies.contacts[0]?.id ?? null;
  }

  /**
   * Contingency playbook: the same ordering the model is given (rule priority),
   * minus the judgement. It commits a resource to EVERY uncovered site it can
   * legally serve — one decision per site — instead of stopping at the first:
   * measured on a live run, one move per pass left a whole cascade unattended
   * while the units that could have served it stood free. What remains
   * uncovered after the pairing gets the stated hold or the escalation.
   */
  function decideByRules(state: StateView, reasons: string[]): AgentOutput {
    const context = world.context(state.elements);
    const ranking = world.priorities(state.elements);
    const elementById = new Map(state.elements.map((e) => [e.id, e]));

    const open = ranking
      .map((p) => ({ score: p.score, element: elementById.get(p.elementId) }))
      .filter(
        (c): c is { score: number; element: ElementView } =>
          c.element !== undefined && c.element.status !== "normal" && c.element.status !== "resolved",
      );

    if (open.length === 0) {
      return {
        evaluation: { discarded: [], actionable: reasons },
        objective: "Contingency mode — no active incidents: holding watch",
        steps: [],
        communications: [],
        decisions: [],
      };
    }

    const assignments = greedyAssignments(
      open.map(({ element, score }) => ({ elementId: element.id, score })),
      context,
      remedies,
    );

    const decisions: AgentOutput["decisions"] = assignments.map((a) => ({
      elementId: a.elementId,
      priority: a.score,
      reasoning: `Contingency playbook: ${a.elementId} is uncovered and ${a.resourceType} is the remedy declared for a ${elementById.get(a.elementId)?.type ?? "site"}; the hard rules allow the pairing.`,
      historyCitation: null,
      actions: [
        {
          type: "assign_resource" as const,
          elementId: a.elementId,
          resourceId: a.resourceId,
          channel: null,
          recipient: null,
          message: `Commit ${a.resourceId} (${a.resourceType}) to ${a.elementId}: uncovered site, the remedy applies and the rules allow it`,
        },
      ],
    }));

    const communications = assignments
      .map((a) => {
        const lead = leadFor(a.elementId);
        return lead
          ? {
              recipient: lead,
              channel: "chat_message" as const,
              elementId: a.elementId,
              message: `Active incident at ${a.elementId}. ${a.resourceId} (${a.resourceType}) has been committed to you by the contingency playbook.`,
              reason: "Contingency mode: automatic notice to the site lead",
            }
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const steps: AgentOutput["steps"] = decisions.flatMap((d) =>
      d.actions.map((a) => ({ description: a.message, elementId: a.elementId })),
    );

    // Sites the pairing could not cover: hold or escalate on the most urgent,
    // with the reason — a stated hold is a decision, an invented assignment is
    // a bug. When nothing is left uncovered there is nothing to state.
    const servedByPlaybook = new Set(assignments.map((a) => a.elementId));
    const uncovered = open.filter(
      (c) =>
        !servedByPlaybook.has(c.element.id) &&
        !state.resources.some(
          (r) =>
            r.assignedElementId === c.element.id &&
            (r.status === "assigned" || r.status === "in_transit"),
        ),
    );
    let holdObjective: string | null = null;

    if (uncovered.length > 0) {
      const target = uncovered[0].element.id;
      const justification =
        "no free resource whose declared remedy applies to the sites still uncovered";

      // `wait` is not automatically legal: `critical-ups-act` and
      // `hospital-power-deadline` veto it. Both demand the same thing — act or
      // escalate — and `contact` is the one action the validator never blocks,
      // so the playbook escalates rather than emit something its own validator
      // vetoes.
      const holding = validateAction({ type: "wait", elementId: target }, context);
      const recipient = escalationContactFor(target);
      const action: ProposedAction | null = holding.allowed
        ? {
            type: "wait",
            elementId: target,
            resourceId: null,
            channel: null,
            recipient: null,
            message: `Holding on ${target}: ${justification}`,
          }
        : recipient
          ? {
              type: "contact",
              elementId: target,
              resourceId: null,
              channel: "voice_call",
              recipient,
              message: `${target} needs a move the contingency playbook cannot make: ${justification}. Rule ${holding.rule} forbids standing by, so this is escalated to you.`,
            }
          : null;

      holdObjective = holding.allowed
        ? `Contingency mode — holding on ${target}: ${justification}`
        : `Contingency mode — escalating ${target}: ${justification}`;
      const holdReasoning = holding.allowed
        ? `Contingency playbook: ${target} leads the remaining priority, but ${justification}. Holding beats spending a resource that cannot help it.`
        : `Contingency playbook: ${target} cannot be left waiting (${holding.rule}) and ${justification}. Escalated to a human instead of committing a resource that does not fit.`;

      decisions.push({
        elementId: target,
        priority: uncovered[0].score,
        reasoning: holdReasoning,
        historyCitation: null,
        actions: action ? [action] : [],
      });
      if (action) {
        steps.push({ description: action.message, elementId: target });
      }
      const holdLead = leadFor(target);
      if (holdLead) {
        communications.push({
          recipient: holdLead,
          channel: "chat_message",
          elementId: target,
          message: `Active incident at ${target}. ${action?.message ?? "the contingency playbook has no move available"}.`,
          reason: "Contingency mode: automatic notice to the site lead",
        });
      }
    }

    const objective =
      assignments.length > 0
        ? `Contingency mode — rule priority committed: ${assignments
            .map((a) => `${a.resourceId} to ${a.elementId}`)
            .join(", ")}${holdObjective ? `; ${holdObjective.replace("Contingency mode — ", "")}` : ""}`
        : (holdObjective ??
          "Contingency mode — every active site already has a resource assigned or in transit");

    return {
      evaluation: { discarded: [], actionable: reasons },
      objective,
      steps,
      communications,
      decisions,
    };
  }

  /* ─── Deliberation: LLM with retry against the hard rules ────────────── */

  async function deliberate(state: StateView, reasons: string[]): Promise<AgentOutput> {
    const affected = state.elements.filter((e) => e.status !== "normal");
    // Real retrieval against the incident memory, capped at the same measured
    // per-turn budget. `null` covers every failure — no Chroma, a throw, a slow
    // search — and the static history of `data/history` takes over.
    const retrieved = await tryRetrieveHistory({
      rag,
      reasons,
      sites: affected,
      limit: MAX_HISTORY_PER_TURN,
    });
    const ctx = {
      simulationClock: state.simulationClock,
      elements: state.elements,
      resources: state.resources,
      secondsWithoutPower: (id: string) => world.secondsWithoutPower(id),
      priorities: world.priorities(state.elements),
      currentPlan: plan,
      history: retrieved ?? staticHistory(history, affected, MAX_HISTORY_PER_TURN),
      topology,
      remedies,
      reports: [
        ...pendingReports.filter((r) => HIGH_SIGNAL_SOURCES.includes(r.source)),
        ...pendingReports.filter((r) => !HIGH_SIGNAL_SOURCES.includes(r.source)),
      ].slice(0, MAX_REPORTS_PER_TURN),
      reasons,
      standing: standingDirectives,
    };

    // consumed: the next deliberation only sees what arrives from now on
    pendingReports = [];

    let rejections: string[] = [];
    let last: AgentOutput | null = null;
    const startedAt = performance.now();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A retry only starts if the budget can still hold a full attempt.
      // Measured live, first attempts reach 47-90s against a 95s budget, so a
      // retry started anyway is not a correction but a scheduled failure —
      // "deliberation budget exhausted" throws away the WHOLE output, legal
      // actions and communications included, and lands on the one-move
      // playbook. Breaking here keeps the last proposal and the strip-illegal
      // path below, which is exactly the softer degradation.
      if (attempt > 0 && performance.now() - startedAt + ATTEMPT_TIMEOUT_MS > DELIBERATION_BUDGET_MS) {
        break;
      }
      const response = await llm.structured(
        buildMessages(ctx, rejections),
        AgentOutputSchema,
        "agent_decision",
      );
      // The model mistypes the ids it was handed ("sub-O2" for "sub-02");
      // recover them before anything judges or executes the proposal.
      last = reanchorOutput(response.data, state, ctx.history);
      // each action judged against the state its predecessors leave behind
      rejections = validateSequentially(last, world.context(state.elements));
      if (rejections.length === 0) return last;

      for (const reason of rejections) {
        feed.publish({ kind: "system", message: `Action blocked by hard rules — ${reason}` });
      }
    }

    // retries exhausted: illegal actions are discarded, the rest goes on
    if (!last) throw new Error("the LLM returned no proposal");
    return stripIllegalActions(last, world.context(state.elements));
  }

  /* ─── Execution ──────────────────────────────────────────────────────── */

  /**
   * Replanning means ABANDONING a plan that already existed because the facts
   * overtook it. A status change happens every tick and does not qualify: if
   * everything is flagged, the badge stops distinguishing anything and the
   * moment that matters — the crew missing its ETA — is lost.
   */
  const REPLAN_REASONS = [
    "misses its ETA",
    "exceeded its limit",
    "Call ",
    // an order from the operator changes the problem, not just the state
    "Operator order",
  ];

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

  function contactFor(recipient: string): Contact | null {
    const match = resolveContact(remedies.contacts, recipient);
    if (match && match.id !== recipient) {
      console.log(`[agent] recipient "${recipient}" resolved to ${match.id}`);
    }
    return match;
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
    // Urgency of each site for the call queue: a call not in the ranking gets
    // the lowest score rather than being rejected.
    const ranking = world.priorities(state.elements);
    const lowestScore = ranking[ranking.length - 1]?.score ?? 0;
    const scoreOf = new Map(ranking.map((r) => [r.elementId, r.score]));

    for (const c of output.communications) {
      const contact = contactFor(c.recipient);
      if (!contact) {
        feed.publish({
          kind: "system",
          message: `Unknown recipient "${c.recipient}": the warning does not go out`,
        });
        continue;
      }
      // no-emergency-services-calls: 112 is never dialled, whatever the model
      // decided. The veto is published so the block is visible, not silent.
      if (contact.emergencyService) {
        feed.publish({
          kind: "system",
          message: `Blocked contact to ${contact.name} (${contact.id}): emergency services are never contacted (no-emergency-services-calls)`,
        });
        continue;
      }
      // fingerprinted by the RESOLVED id: the same text addressed once as
      // `hospital-lead` and once as "Dr. Elena Duarte" is one phone call, not two
      const fingerprint = `${contact.id}|${c.message.trim()}`;
      if (warningsSent.has(fingerprint)) continue;
      warningsSent.add(fingerprint);
      const action = actionRegistry.record(
        {
          type: c.channel,
          targetElementId: anchorToSite(c.elementId, state),
          recipient: contact.id,
          message: c.message,
        },
        // a voice call waits on a line in the call queue; a message goes out now
        c.channel === "voice_call" ? "queued" : "executed",
      );
      actions = [action, ...actions].slice(0, MAX_DECISIONS);
      // Here the system leaves the laptop: a real phone rings.
      happyrobot.contact({
        actionId: action.id,
        contact,
        channel: c.channel,
        priority: scoreOf.get(action.targetElementId) ?? lowestScore,
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
        assignments: [],
      };

      for (const a of d.actions) {
        if (a.type === "assign_resource" && a.resourceId) {
          const result = world.assign(a.resourceId, a.elementId, seconds());
          // recorded on the decision: the panel must show what was SENT, not
          // only what was said — an assignment that only lives in the feed
          // reads as "the agent decided nothing"
          decision.assignments.push({
            resourceId: a.resourceId,
            resourceType:
              state.resources.find((r) => r.id === a.resourceId)?.type ?? "unknown",
            elementId: a.elementId,
            etaSeconds: result.ok ? result.etaSeconds : null,
            ok: result.ok,
            reason: result.ok ? null : result.reason,
          });
          feed.publish({
            kind: "system",
            message: result.ok
              ? `${a.resourceId} → ${a.elementId}, arrives in ${countdown(result.etaSeconds)}`
              : `Could not assign ${a.resourceId}: ${result.reason}`,
          });
        } else if (a.type === "contact" && a.channel) {
          // same recovery as the communications field: the panel shows the id
          // of whoever it really is, not whatever prose the model wrote
          const resolved = a.recipient ? contactFor(a.recipient) : null;
          // no-emergency-services-calls: the veto applies here too, so a
          // decision-level contact never even shows up as executed
          if (resolved?.emergencyService) {
            feed.publish({
              kind: "system",
              message: `Blocked contact to ${resolved.name} (${resolved.id}): emergency services are never contacted (no-emergency-services-calls)`,
            });
            continue;
          }
          // No human gate (#43): recorded as executed and published
          const action = actionRegistry.record(
            {
              type: a.channel,
              targetElementId: a.elementId,
              recipient: resolved?.id ?? undefined,
              message: a.message,
            },
            "executed",
          );
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

  /* ─── Idle-capacity pass ─────────────────────────────────────────────── */

  /**
   * Commits free units to uncovered sites WITHOUT a deliberation, and returns
   * how many pairings landed.
   *
   * This runs only when nothing woke the engine: no trigger fired, no status
   * changed, nothing is pending. That is exactly the state a freed resource
   * leaves behind when its deliberation held it back or the release arrived
   * between deliberations — on a live run, four units stood down at once and
   * two of them waited for the LAST deliberation of the simulation, their
   * ETAs landing after the crisis was over. The pairing is the mechanical
   * `greedyAssignments`: uncovered site, remedy fits, hard rules allow — with
   * the hospital ration enforced by the validator, so the pass can never
   * spend a generator a hospital still needs. Judgement calls stay with the
   * LLM: the pass adds no reasons, sends no communications and never touches
   * the plan in flight.
   */
  function idleReassignments(state: StateView): number {
    const context = world.context(state.elements);
    const ranking = world.priorities(state.elements);
    const elementById = new Map(state.elements.map((e) => [e.id, e]));
    const open = ranking
      .map((p) => ({ score: p.score, element: elementById.get(p.elementId) }))
      .filter(
        (c): c is { score: number; element: ElementView } =>
          c.element !== undefined && c.element.status !== "normal" && c.element.status !== "resolved",
      );

    const assignments = greedyAssignments(
      open.map(({ element, score }) => ({ elementId: element.id, score })),
      context,
      remedies,
    );
    if (assignments.length === 0) return 0;

    feed.publish({
      kind: "system",
      message:
        "Idle-capacity watch: free units committed to uncovered sites without a deliberation — no trigger woke the engine, and idle capacity is wasted capacity.",
    });

    let committed = 0;
    for (const a of assignments) {
      const result = world.assign(a.resourceId, a.elementId, seconds());
      feed.publish({
        kind: "system",
        message: result.ok
          ? `${a.resourceId} → ${a.elementId}, arrives in ${countdown(result.etaSeconds)}`
          : `Could not assign ${a.resourceId}: ${result.reason}`,
      });
      if (!result.ok) continue;
      committed += 1;
      const decision: Decision = {
        id: newId("dec"),
        timestamp: state.simulationClock,
        elementId: a.elementId,
        priority: a.score,
        reasoning: `Idle capacity: ${a.elementId} is uncovered, ${a.resourceId} is free and the ${a.resourceType} remedy applies to it, and the hard rules allow the pairing — committed without a deliberation.`,
        provokesReplan: false,
        actions: [],
        assignments: [
          {
            resourceId: a.resourceId,
            resourceType:
              state.resources.find((r) => r.id === a.resourceId)?.type ?? "unknown",
            elementId: a.elementId,
            etaSeconds: result.etaSeconds,
            ok: true,
            reason: null,
          },
        ],
      };
      decisions = [decision, ...decisions].slice(0, MAX_DECISIONS);
    }
    return committed;
  }

  /* ─── Public API ─────────────────────────────────────────────────────── */

  return {
    async observe(state, events): Promise<void> {
      if (deliberating) {
        bufferedEvents.push(...events);
        return;
      }
      const seen = bufferedEvents.length > 0 ? [...bufferedEvents, ...events] : events;
      bufferedEvents = [];
      const reasons = deliberationReasons(state, seen);
      previousStatus = new Map(state.elements.map((e) => [e.id, e.status]));

      if (state.paused) return;
      if (reasons.length === 0) {
        // Nothing woke the engine. Before letting the tick go by, close
        // mechanically what can be closed: free units over uncovered sites.
        idleReassignments(state);
        return;
      }

      deliberating = true;
      const reactionStart = performance.now();
      try {
        let output: AgentOutput;
        try {
          output = await withBudget(deliberate(state, reasons), DELIBERATION_BUDGET_MS);
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`[agent] deliberation failed (${cause}); fallback to rules`);
          // What a jury reads on screen when this fires. It is a designed
          // degraded mode, not a crash: say what took over and on what basis.
          feed.publish({
            kind: "system",
            message:
              "Contingency mode engaged: the deliberation did not land in time. The rule-based playbook takes over — priority ranking, coverage check and hard rules all still apply.",
          });
          output = decideByRules(state, reasons);
        }
        execute(output, state, isReplan(reasons));
        stats?.recordReaction(performance.now() - reactionStart);
      } finally {
        deliberating = false;
        // the idle-capacity cooldown counts from the END of a deliberation: a
        // 90s deliberation must not restart the watch the moment it lands
        lastDeliberationEnd = performance.now();
      }
    },

    view() {
      return {
        currentPlan: plan,
        decisions,
        actions,
      };
    },

    /**
     * `AttentionState` has five members and this used to emit three. The two it
     * skipped are the two that change a decision:
     *
     * - `resource_en_route` — a truck that is still driving was reported as
     *   "resource deployed". The agent could not tell "powered now" from
     *   "powered in five minutes", with a hospital that lasts eight.
     * - `resolved` — a site whose resource has been released reads as
     *   `unattended`, i.e. NOT COVERED, and invites the agent to send help back
     *   to somewhere it already fixed.
     */
    attention(elementId, status): ElementView["attention"] {
      const resource = world.resources().find((r) => r.assignedElementId === elementId);
      const decision = decisions.find((d) => d.elementId === elementId);
      let state: AttentionState = "unattended";
      if (status === "resolved") state = "resolved";
      else if (resource) {
        state = resource.status === "in_transit" ? "resource_en_route" : "resource_assigned";
      } else if (decision) state = "analyzing";
      return {
        state,
        resourceId: resource?.id ?? null,
        activeDecisionId: decision?.id ?? null,
      };
    },


    command(state, intents): OperatorDirective[] {
      const results: OperatorDirective[] = [];

      for (const intent of intents) {
        // The model mistypes the ids it was handed here exactly as it does in
        // a deliberation, and an order dropped for a typo is an operator
        // ignored. Same recovery, same rules about what is ambiguous.
        const elementId = intent.elementId
          ? resolveElementId(intent.elementId, state.elements)
          : null;
        const resourceId = intent.resourceId
          ? resolveElementId(intent.resourceId, state.resources)
          : null;
        const site = elementId ? state.elements.find((e) => e.id === elementId) : undefined;
        const unit = resourceId ? state.resources.find((r) => r.id === resourceId) : undefined;
        const note = intent.note.trim() === "" ? "no reason given" : intent.note.trim();

        const directive: OperatorDirective = {
          id: newId("ord"),
          kind: intent.kind,
          elementId: site?.id ?? null,
          resourceId: unit?.id ?? null,
          note,
          accepted: false,
          reason: null,
        };
        /** Refusal is a result, not a failure: it is what the operator has to read */
        const refuse = (reason: string): void => {
          directive.accepted = false;
          directive.reason = reason;
        };

        switch (intent.kind) {
          case "prioritize":
          case "deprioritize": {
            if (!site) {
              refuse(`no site called "${intent.elementId ?? "(none)"}" in this scenario`);
              break;
            }
            const amount =
              intent.kind === "prioritize" ? OPERATOR_PRIORITY_BOOST : -OPERATOR_PRIORITY_BOOST;
            world.boost(site.id, amount);
            directive.accepted = true;
            feed.publish({
              kind: "system",
              message: `Operator order: ${site.id} ${amount > 0 ? "+" : ""}${amount} priority — ${note}`,
            });
            break;
          }

          case "assign": {
            if (!site) {
              refuse(`no site called "${intent.elementId ?? "(none)"}" in this scenario`);
              break;
            }
            if (!unit) {
              refuse(`no unit called "${intent.resourceId ?? "(none)"}" in this fleet`);
              break;
            }
            // The operator is the human in the loop, not an exception to the
            // hard rules: their order faces the same validator as the model's
            // own proposals, and a refusal comes back naming the rule.
            const verdict = validateAction(
              { type: "assign_resource", elementId: site.id, resourceId: unit.id },
              world.context(state.elements),
            );
            if (!verdict.allowed) {
              refuse(`[${verdict.rule}] ${verdict.reason}`);
              feed.publish({
                kind: "system",
                message: `Operator order refused — ${unit.id} to ${site.id}: [${verdict.rule}] ${verdict.reason}`,
              });
              break;
            }
            const result = world.assign(unit.id, site.id, seconds());
            if (!result.ok) {
              refuse(result.reason);
              feed.publish({
                kind: "system",
                message: `Operator order refused — ${unit.id} to ${site.id}: ${result.reason}`,
              });
              break;
            }
            directive.accepted = true;
            feed.publish({
              kind: "system",
              message: `Operator order: ${unit.id} → ${site.id}, arrives in ${countdown(result.etaSeconds)} — ${note}`,
            });
            // Recorded as a decision of its own so the panel shows WHO decided
            // it. An operator move that only exists in the chat reads, three
            // minutes later, as a resource the agent moved for no reason.
            const decision: Decision = {
              id: newId("dec"),
              timestamp: state.simulationClock,
              elementId: site.id,
              priority: world.priorities(state.elements).find((p) => p.elementId === site.id)?.score ?? 0,
              reasoning: `Operator order from the chat: ${note}. The hard rules allow ${unit.id} on ${site.id}, so it goes now.`,
              provokesReplan: false,
              actions: [],
              assignments: [
                {
                  resourceId: unit.id,
                  resourceType: unit.type,
                  elementId: site.id,
                  etaSeconds: result.etaSeconds,
                  ok: true,
                  reason: null,
                },
              ],
            };
            decisions = [decision, ...decisions].slice(0, MAX_DECISIONS);
            feed.publish({
              kind: "decision",
              elementId: decision.elementId,
              decisionId: decision.id,
              priority: decision.priority,
              reasoning: decision.reasoning,
              provokesReplan: decision.provokesReplan,
            });
            break;
          }

          case "release": {
            if (!unit) {
              refuse(`no unit called "${intent.resourceId ?? "(none)"}" in this fleet`);
              break;
            }
            if (unit.status === "available") {
              refuse(`${unit.id} is already free: there is nothing to stand down`);
              break;
            }
            world.release(unit.id);
            directive.accepted = true;
            feed.publish({
              kind: "system",
              message: `Operator order: ${unit.id} stands down from ${unit.assignedElementId ?? "its assignment"} — ${note}`,
            });
            break;
          }

          case "note": {
            directive.accepted = true;
            feed.publish({
              kind: "system",
              message: `Operator note${site ? ` on ${site.id}` : ""}: ${note}`,
            });
            break;
          }
        }

        if (directive.accepted) {
          // Priority biases and notes shape every deliberation from now on; a
          // move that already happened does not need repeating to the model.
          if (
            directive.kind === "prioritize" ||
            directive.kind === "deprioritize" ||
            directive.kind === "note"
          ) {
            standingDirectives = [...standingDirectives, directive];
          }
          externalReasons.push(
            `Operator order (${directive.kind}${directive.elementId ? ` on ${directive.elementId}` : ""}${directive.resourceId ? `, ${directive.resourceId}` : ""}): ${note}`,
          );
        }
        results.push(directive);
      }

      return results;
    },

    standing(): OperatorDirective[] {
      return [...standingDirectives];
    },

    queueReport(report): void {
      pendingReports.push(report);
    },

    closeCall(closure): void {
      const action = actions.find((a) => a.id === closure.actionId);
      // a closure can only arrive for a call that went out
      if (action && action.status === "queued") action.status = "executed";
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
      bufferedEvents = [];
      lastDeliberationEnd = 0;
      standingDirectives = [];
      counter = 0;
    },
  };
}
