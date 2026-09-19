import express from "express";
import type {
  AgentView,
  ControlResponse,
  FeedResponse,
  HealthResponse,
  HistoricalIncident,
  StateView,
  TopologyView,
} from "@swarmup/shared";
import { loadHistory } from "@swarmup/shared";
import { createAgent } from "./agent.js";
import { config, redactSecrets } from "./config.js";
import { createActionRegistry, controlSchema } from "./control.js";
import { createFeed, parseSince } from "./feed.js";
import { toTopology, loadScript } from "./script.js";
import { createLlmClient } from "./llm.js";
import { createWorld } from "./world.js";
import { startChroma } from "./rag/chroma.js";
import { createHistoryRag, type HistoryRag } from "./rag/history.js";
import { createSimulation, type IncidentClosure } from "./sim.js";

const repoRoot = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", repoRoot));
const feed = createFeed();
const world = createWorld(script);

/** Local Chroma (RAG): if it does not start, the demo goes on without loop closure */
const ragReady: Promise<HistoryRag | null> = startChroma({
  path: config.chroma.path,
  port: config.chroma.port,
})
  .then((chroma) =>
    createHistoryRag({ client: chroma.client, llm: createLlmClient(config.llm.gateways) }),
  )
  .catch((err: unknown) => {
    console.error(
      `[rag] Chroma unavailable, resolved incidents will not be recorded: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    return null;
  });

function onResolved(closure: IncidentClosure): void {
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

const sim = createSimulation(script, Date.now(), feed, world, onResolved);
const actionRegistry = createActionRegistry(feed);
const topology: TopologyView = toTopology(script);

/** History pre-loaded per site type: agent context from the first tick */
const history: HistoricalIncident[] = ["hospital", "datacenter", "substation"].flatMap((type) =>
  loadHistory(new URL(`data/history/${type}/incidents.json`, repoRoot).pathname),
);

const agent = createAgent({
  world,
  feed,
  llm: createLlmClient(config.llm.gateways),
  actionRegistry,
  history,
  seconds: () => sim.seconds(),
});

/**
 * One tick of the system: the sim applies the script's due events and the world
 * advances the physical state over that snapshot. The events returned by `world`
 * are replan triggers (RULES.md §7) and the decision engine consumes them.
 */
function advance(): void {
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
    } else {
      feed.publish({
        kind: "system",
        message: `${ev.elementId} exceeds its limit without power (${ev.minutesWithoutPower} min)`,
      });
    }
  }
  // the engine decides over the already-advanced snapshot; it does not wait for it to finish
  void agent.observe(fullState(), events);
}

/** `attention` is derived and computed by the backend (CONTRACT.md, golden rule 4) */
function fullState(): StateView {
  const state = sim.state();
  return {
    ...state,
    elements: state.elements.map((e) => ({ ...e, attention: agent.attention(e.id) })),
  };
}

const app = express();
app.use(express.json());

function errorResponse(error: string): ControlResponse {
  return { ok: false, error };
}

app.get("/api/topology", (_req, res) => {
  res.json(topology);
});

app.get("/api/state", (_req, res) => {
  advance();
  res.json(fullState());
});

app.get("/api/agent", (_req, res) => {
  advance();
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
  const health: HealthResponse = {
    status: "ok",
    tick: sim.tick(),
    paused: sim.paused,
    started: sim.started,
  };
  res.json(health);
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
  switch (body.action) {
    case "start":
      sim.start(Date.now());
      break;
    case "reset":
      sim.reset();
      agent.reset();
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
