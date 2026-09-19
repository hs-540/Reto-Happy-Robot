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
  Remedies,
  Report,
  StateView,
  Topology,
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
   * A site is covered when a resource is working it OR already on its way. The
   * prompt states the same rule for the model ("A resource in transit counts as
   * covered"); the fallback has to honour it too. Measured without this check:
   * it parked `generator-2` on `hosp-01`, which already had `generator-1`
   * assigned, and `tower-01` went critical at 21% battery with nothing left to
   * send.
   */
  function isCovered(elementId: string, state: StateView): boolean {
    return state.resources.some(
      (r) =>
        r.assignedElementId === elementId &&
        (r.status === "assigned" || r.status === "in_transit"),
    );
  }

  /**
   * Whether `data/remedies.json` declares a remedy this resource type offers for
   * this kind of site. Measured without this check: it sent `tanker-1` to
   * `sub-01`, a substation, for which no tanker remedy exists — a wasted trip
   * that also locked the tanker away from the sites it could actually help.
   */
  function remedyApplies(resourceType: string, elementType: string): boolean {
    return remedies.remedies.some(
      (r) => r.resource === resourceType && (r.appliesTo as readonly string[]).includes(elementType),
    );
  }

  /** Shared shape of every contingency-mode output: one site, one stated move */
  function playbook(input: {
    target: string;
    objective: string;
    reasoning: string;
    action: ProposedAction | null;
    reasons: string[];
  }): AgentOutput {
    const { target, objective, reasoning, action, reasons } = input;
    const lead = leadFor(target);
    return {
      evaluation: { discarded: [], actionable: reasons },
      objective,
      steps: action ? [{ description: action.message, elementId: target }] : [],
      // even without the LLM the site lead is warned: going silent is no option
      communications: lead
        ? [
            {
              recipient: lead,
              channel: "chat_message" as const,
              elementId: target,
              message: `Active incident at ${target}. ${action?.message ?? "the contingency playbook has no move available"}.`,
              reason: "Contingency mode: automatic notice to the site lead",
            },
          ]
        : [],
      decisions: [
        {
          elementId: target,
          priority: 1,
          reasoning,
          historyCitation: null,
          actions: action ? [action] : [],
        },
      ],
    };
  }

  /**
   * Contingency playbook: the same ordering the model is given (rule priority),
   * minus the judgement. It commits a resource only when the site is uncovered,
   * the remedy applies and the hard rules allow it; otherwise it states why it
   * is holding instead of inventing an assignment.
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

    // The first uncovered site a free, applicable and legal resource can take.
    for (const candidate of open) {
      const site = candidate.element;
      if (isCovered(site.id, state)) continue;
      const resource = state.resources.find(
        (r) =>
          r.status === "available" &&
          remedyApplies(r.type, site.type) &&
          validateAction(
            { type: "assign_resource", elementId: site.id, resourceId: r.id },
            context,
          ).allowed,
      );
      if (!resource) continue;

      return playbook({
        target: site.id,
        objective: `Contingency mode — rule priority: ${resource.id} to ${site.id} (score ${candidate.score})`,
        reasoning: `Contingency playbook: ${site.id} leads the computed priority (${candidate.score}), nothing covers it yet and ${resource.type} is the remedy declared for a ${site.type}.`,
        action: {
          type: "assign_resource",
          elementId: site.id,
          resourceId: resource.id,
          channel: null,
          recipient: null,
          message: `Commit ${resource.id} (${resource.type}) to ${site.id}: highest-priority uncovered site and the remedy applies`,
        },
        reasons,
      });
    }

    // Nothing sensible left to commit. Say so, on the most urgent site, with
    // the reason: a stated hold is a decision, an invented assignment is a bug.
    const uncovered = open.filter((c) => !isCovered(c.element.id, state));
    const target = (uncovered[0] ?? open[0]).element.id;
    const justification =
      uncovered.length === 0
        ? "every active site already has a resource assigned or in transit"
        : "no free resource whose declared remedy applies to the sites still uncovered";

    // `wait` is not automatically legal: `critical-ups-act` and
    // `hospital-power-deadline` veto it. Both demand the same thing — act or
    // escalate — and `contact` is the one action the validator never blocks, so
    // the playbook escalates rather than emit something its own validator vetoes.
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

    return playbook({
      target,
      objective: holding.allowed
        ? `Contingency mode — holding on ${target}: ${justification}`
        : `Contingency mode — escalating ${target}: ${justification}`,
      reasoning: holding.allowed
        ? `Contingency playbook: ${target} leads the computed priority, but ${justification}. Holding beats spending a resource that cannot help it.`
        : `Contingency playbook: ${target} cannot be left waiting (${holding.rule}) and ${justification}. Escalated to a human instead of committing a resource that does not fit.`,
      action,
      reasons,
    });
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

      if (reasons.length === 0 || state.paused) return;

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
      counter = 0;
    },
  };
}
