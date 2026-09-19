import express from "express";
import { z } from "zod";
import type {
  AgentView,
  ControlResponse,
  FeedResponse,
  HealthResponse,
  HistoricalIncident,
  RunSummaryView,
  StateView,
  TopologyView,
} from "@swarmup/shared";
import { loadHistory, loadRemedies, loadRoads } from "@swarmup/shared";
import { createAgent, type Agent } from "./agent.js";
import { createCallQueue } from "./call-queue.js";
import { config, redactSecrets } from "./config.js";
import { createActionRegistry, controlSchema } from "./control.js";
import { createFeed, parseSince } from "./feed.js";
import { toTopology, type Script } from "./script.js";
import { createHappyRobotClient, type ContactRequest } from "./happyrobot.js";
import { createLlmClient } from "./llm.js";
import { createRunStats } from "./stats.js";
import { createWorld, type World } from "./world.js";
import { startChroma } from "./rag/chroma.js";
import { createHistoryRag, type HistoryRag } from "./rag/history.js";
import { createSimulation, type IncidentClosure, type Simulation } from "./sim.js";
import { generateScenario } from "./scenario.js";

const repoRoot = new URL("../../", import.meta.url);
const feed = createFeed();
/** Physical facts about the remedies: what fixes what and who can be called */
const remedies = loadRemedies(new URL("data/remedies.json", repoRoot).pathname);

/** Real street network (© OpenStreetMap contributors) the resources drive on */
const roads = (() => {
  try {
    return loadRoads(new URL("data/roads.json", repoRoot).pathname);
  } catch (err: unknown) {
    console.error(
      `[world] road network unavailable, resources will move in straight lines: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
})();

/** Per-run counters: LLM latency/tokens and trigger-to-decision reaction times */
const stats = createRunStats();
/** Incidents closed this run; feeds the end-of-simulation summary */
let resolvedClosures = 0;
/** The end-of-run summary is published exactly once per run */
let summaryPublished = false;

/** History shipped with the repo, per site type: the seed of the incident memory */
const history: HistoricalIncident[] = [
  "datacenter",
  "hospital",
  "substation",
  "tower",
  "fuel_station",
  "junction",
].flatMap((type) => loadHistory(new URL(`data/history/${type}/incidents.json`, repoRoot).pathname));

/** Local Chroma (RAG): if it does not start, the demo goes on without loop closure */
const ragReady: Promise<HistoryRag | null> = startChroma({
  path: config.chroma.path,
  port: config.chroma.port,
})
  .then(async (chroma) => {
    const rag = createHistoryRag({
      client: chroma.client,
      llm: createLlmClient(config.llm.gateways),
    });
    /* Seeded on boot, not by a manual script: a fresh machine where nobody ran
       `npm run rag:preload` would retrieve nothing and nobody would notice —
       the demo would look fine and quietly cite no precedent. `preload` upserts
       by id, so booting again neither duplicates the seed nor touches the
       closures earlier runs wrote (their ids are their own). */
    try {
      const total = await rag.preload(history);
      console.log(`[rag] incident memory ready: ${total} incidents across the collections`);
    } catch (err: unknown) {
      console.error(
        `[rag] seeding failed, retrieval will use whatever is already on disk: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      );
    }
    return rag;
  })
  .catch((err: unknown) => {
    console.error(
      `[rag] Chroma unavailable, the agent runs on the static history: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    return null;
  });

function onResolved(closure: IncidentClosure): void {
  resolvedClosures += 1;
  void ragReady.then((rag) => {
    if (!rag) return;
    rag
      .recordClosure(closure)
      .then(() => console.log(`[rag] closure recorded in the history: ${closure.elementId}`))
      .catch((err: unknown) => {
        console.error(
          `[rag] could not record the closure of ${closure.elementId}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        );
      });
  });
}

const actionRegistry = createActionRegistry(feed);

/**
 * Staleness gate for the call queue, evaluated when a queued call is about to
 * be dialled: the site it was worth calling may have resolved while the call
 * waited for a line. Reads the current runtime, so calls still queued from a
 * previous generation fall out instead of dialling a world that is gone.
 */
function isStillRelevant(request: ContactRequest): boolean {
  const element = runtime.sim.state().elements.find((e) => e.id === request.context.elementId);
  return element !== undefined && element.status !== "resolved";
}

/** Missions the hook accepted this run: the outcome poller only closes these */
const dispatchedMissions = new Set<string>();

/**
 * The channel to the real world. Created once and receiving the closure by
 * callback: a call takes a minute to resolve and the engine does not wait for
 * it. The call queue sits between the agent and the client: one phone line by
 * default, so a deliberation returning eight calls does not dial eight people
 * at once. `onClosed` reads the current runtime, so a hang-up that lands after
 * a reset closes on the run that owns the action.
 */
const happyrobot = createCallQueue(
  createHappyRobotClient({
    webhookUrl: config.happyrobot.webhookUrl,
    onClosed: (closure) => happyrobot.onClosed(closure),
    onDispatched: (missionId) => dispatchedMissions.add(missionId),
  }),
  {
    feed,
    maxInFlight: config.happyrobot.maxConcurrentCalls,
    maxQueued: config.happyrobot.maxQueuedCalls,
    slotTimeoutMs: config.happyrobot.callSlotTimeoutMs,
    onClosed: (closure) => runtime.agent.closeCall(closure),
    isStillRelevant,
  },
);

/** One generation of the crisis: everything a reset throws away and rebuilds */
interface Runtime {
  /** the drawn crisis this generation runs on */
  script: Script;
  world: World;
  sim: Simulation;
  agent: Agent;
  /** served by `GET /api/topology`; derived from this generation's script */
  topology: TopologyView;
}

/**
 * Builds a runtime generation from a freshly drawn scenario. The seed is drawn
 * here and stays implicit for now: each reset is a different, validated crisis,
 * reproduced only by whoever noted the seed down.
 */
function createRuntime(): Runtime {
  const { script, topologyGraph, contacts } = generateScenario(
    Math.floor(Math.random() * 2 ** 31),
  );
  const world = createWorld(script, remedies, topologyGraph, roads);
  const sim = createSimulation(script, Date.now(), feed, world, onResolved, (report) =>
    agent.queueReport(report),
  );
  const agent = createAgent({
    world,
    feed,
    llm: createLlmClient(config.llm.gateways, stats),
    actionRegistry,
    happyrobot,
    history,
    rag: ragReady,
    topology: topologyGraph,
    // the agent can only reach people who exist in this generation of the world
    remedies: { ...remedies, contacts },
    seconds: () => sim.seconds(),
    stats,
  });
  return { script, world, sim, agent, topology: toTopology(script) };
}

let runtime: Runtime = createRuntime();

/**
 * End-of-run report: what happened, how the agent reacted and what it cost.
 * Built live from the feed, the world and the per-run stats; served by
 * GET /api/summary and logged + feed-summarized once when the script ends.
 */
function buildRunSummary(): RunSummaryView {
  const items = feed.since(0);
  const byKind = new Map<string, number>();
  for (const item of items) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }
  // A queued call carries one action entry at birth and one when it is dialled
  // or discarded: count actions, not action entries
  const actionIds = new Set(items.flatMap((i) => (i.kind === "action" ? [i.actionId] : [])));
  const { sim } = runtime;
  const state = sim.state();
  const open = state.elements.filter((e) => e.status === "critical" || e.status === "degraded");
  const snapshot = stats.snapshot();
  return {
    available: sim.finished,
    events: {
      total: items.length,
      alarms: byKind.get("alarm") ?? 0,
      reports: byKind.get("report") ?? 0,
      decisions: byKind.get("decision") ?? 0,
      actions: actionIds.size,
      outcomes: byKind.get("outcome") ?? 0,
      system: byKind.get("system") ?? 0,
    },
    incidents: { resolved: resolvedClosures, open: open.length },
    llm: snapshot.llm,
    meanReactionMs: snapshot.meanReactionMs,
  };
}

function publishRunSummary(): void {
  const summary = buildRunSummary();
  const { events, incidents, llm } = summary;
  const fmtSeconds = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
  const fmtInt = (n: number) => n.toLocaleString("en-US");

  console.log(
    `[summary] simulation complete at crisis second ${Math.round(runtime.sim.seconds())} of ${runtime.script.durationSeconds}`,
  );
  console.log(
    `[summary] events: ${events.total} total — ` +
      `${events.alarms} alarms, ${events.reports} raw signals, ` +
      `${events.decisions} decisions, ${events.actions} actions, ` +
      `${events.outcomes} call outcomes, ${events.system} system`,
  );
  console.log(`[summary] incidents: ${incidents.resolved} resolved, ${incidents.open} still open`);
  console.log(
    `[summary] llm: ${llm.calls} calls, latency min ${fmtSeconds(llm.minLatencyMs)} / ` +
      `avg ${fmtSeconds(llm.meanLatencyMs)} / max ${fmtSeconds(llm.maxLatencyMs)}, ` +
      `tokens ${fmtInt(llm.totalTokens)} total ` +
      `(${fmtInt(llm.promptTokens)} prompt / ${fmtInt(llm.completionTokens)} completion)`,
  );
  console.log(`[summary] mean reaction time (trigger to decision executed): ${fmtSeconds(summary.meanReactionMs)}`);

  feed.publish({
    kind: "system",
    message:
      `Run complete: ${events.total} events processed, ${incidents.resolved} incidents resolved, ` +
      `${llm.calls} LLM calls (min/avg/max ${fmtSeconds(llm.minLatencyMs)}/` +
      `${fmtSeconds(llm.meanLatencyMs)}/${fmtSeconds(llm.maxLatencyMs)}), ` +
      `${fmtInt(llm.totalTokens)} tokens, mean reaction ${fmtSeconds(summary.meanReactionMs)}.`,
  });
}

/**
 * One tick of the system: the sim applies the script's due events and the world
 * advances the physical state over that snapshot. The events returned by `world`
 * are replan triggers (RULES.md §7) and the decision engine consumes them.
 */
function advance(): void {
  const { sim, world, agent } = runtime;
  sim.advance(Date.now());
  const events = world.advance(sim.seconds(), sim.state().elements);
  for (const ev of events) {
    if (ev.type === "arrival") {
      feed.publish({ kind: "system", message: `${ev.resourceId} has arrived at ${ev.elementId}` });
    } else if (ev.type === "eta_missed") {
      feed.publish({
        kind: "system",
        message: `${ev.resourceId} misses its ETA to ${ev.elementId} (+${ev.delaySeconds}s)`,
      });
    } else if (ev.type === "deadline_exceeded") {
      feed.publish({
        kind: "system",
        message: `${ev.elementId} exceeds its limit without power (${ev.minutesWithoutPower} min)`,
      });
    } else if (ev.type === "remedy_applied") {
      // the agent's action changes the world: applied as a real reading
      sim.inject({
        elementId: ev.elementId,
        metric: ev.metric,
        value: ev.value,
        severity: ev.severity,
      });
      feed.publish({
        kind: "system",
        message: `${ev.resourceId} takes effect on ${ev.elementId}: ${ev.effect}`,
      });
    } else if (ev.type === "released") {
      // no reading to inject: the site did not change, the fleet did. Checked
      // before the final `else`, which assumes whatever is left is a sensor
      // reading and would hand `sim.inject` an event with no metric.
      feed.publish({
        kind: "system",
        message: `${ev.resourceId} stands down from ${ev.elementId}: ${ev.reason}`,
      });
    } else {
      // recovery: silent, it does not clutter the feed but the world improves
      sim.inject({
        elementId: ev.elementId,
        metric: ev.metric,
        value: ev.value,
        severity: ev.severity,
      });
    }
  }
  // the engine decides over the already-advanced snapshot; it does not wait for it to finish
  void agent.observe(fullState(), events).catch((err: unknown) => {
    console.error(`[agent] observation failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  });
  if (sim.finished && !summaryPublished) {
    summaryPublished = true;
    publishRunSummary();
  }
}

/** `attention` is derived and computed by the backend (CONTRACT.md, golden rule 4) */
function fullState(): StateView {
  const { sim, world, agent } = runtime;
  const state = sim.state();
  return {
    ...state,
    elements: state.elements.map((e) => ({
      ...e,
      attention: agent.attention(e.id, e.status),
      repair: e.status === "resolved" ? null : world.repairEstimate(e.id, sim.seconds()),
    })),
  };
}

const app = express();
app.use(express.json());

function errorResponse(error: string): ControlResponse {
  return { ok: false, error };
}

app.get("/api/topology", (_req, res) => {
  res.json(runtime.topology);
});

app.get("/api/state", (_req, res) => {
  advance();
  res.json(fullState());
});

app.get("/api/agent", (_req, res) => {
  advance();
  const { sim, agent } = runtime;
  const view: AgentView = { ...agent.view(), tick: sim.tick(), paused: sim.paused };
  res.json(view);
});

app.get("/api/feed", (req, res) => {
  const since = parseSince(req.query.since);
  if (since === null) {
    res.status(400).json({ error: "since must be an integer >= 0" });
    return;
  }
  const response: FeedResponse = { items: feed.since(since), lastSeq: feed.lastSeq() };
  res.json(response);
});

app.get("/api/health", (_req, res) => {
  advance();
  const { sim } = runtime;
  const health: HealthResponse = {
    status: "ok",
    tick: sim.tick(),
    paused: sim.paused,
    started: sim.started,
  };
  res.json(health);
});

app.get("/api/summary", (_req, res) => {
  advance();
  res.json(buildRunSummary());
});

/**
 * The return path of a real call. HappyRobot invokes it on hang-up with what the
 * person answered; if they refused or asked for more time, `delayMinutes`
 * invalidates the plan's ETA and the agent replans on the next tick.
 */
const callClosureSchema = z.object({
  actionId: z.string().min(1),
  outcome: z.enum(["accepted", "accepted_with_delay", "refused", "no_answer"]),
  delayMinutes: z.number().int().min(0).nullable().default(null),
  commitment: z.string().min(1).nullable().default(null),
  summary: z.string().min(1),
});

app.post("/api/call/outcome", (req, res) => {
  advance();
  const parsed = callClosureSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    res.status(400).json(errorResponse(`invalid body: ${details}`));
    return;
  }
  // Through the queue: the closure frees the call's slot before it reaches the
  // agent of the current runtime
  happyrobot.onClosed(parsed.data);
  res.json({ ok: true });
});

app.post("/api/control", (req, res) => {
  advance();
  const parsed = controlSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    res.status(400).json(errorResponse(`invalid body: ${details}`));
    return;
  }
  const body = parsed.data;
  const { sim } = runtime;
  switch (body.action) {
    case "start":
      sim.start(Date.now());
      break;
    case "reset":
      // a new generation of the crisis, not a rewind of this one; the shared
      // feed is cleared here because its `seq` must stay monotonic across runs
      feed.reset();
      runtime = createRuntime();
      stats.reset();
      resolvedClosures = 0;
      summaryPublished = false;
      break;
    case "pause":
      sim.pause();
      break;
    case "resume":
      sim.resume();
      break;
    case "inject":
      try {
        sim.inject(body.payload);
      } catch (err) {
        res.status(400).json(errorResponse(err instanceof Error ? err.message : String(err)));
        return;
      }
      break;
  }
  res.json({ ok: true });
});

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(`[backend] ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  res.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);

setInterval(advance, config.tickMs);

app.listen(config.port, () => {
  console.log(`Backend listening at http://localhost:${config.port}`);
});
