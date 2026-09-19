import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadHistory,
  loadRemedies,
  loadTopology,
  type ElementType,
  type ElementView,
  type HistoricalIncident,
  type StateView,
} from "@swarmup/shared";
import { createAgent, type AgentOptions } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import type { HistoryRag, RetrievedIncident } from "../src/rag/history.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));
const history: HistoricalIncident[] = ["hospital", "datacenter", "substation"].flatMap((type) =>
  loadHistory(fileURLToPath(new URL(`data/history/${type}/incidents.json`, root))),
);

/** The per-turn cap of `agent.ts`; the prompt must never carry more than this */
const MAX_HISTORY_PER_TURN = 3;

/* ─── Doubles ────────────────────────────────────────────────────────── */

const AGENT_OUTPUT = {
  evaluation: { discarded: [], actionable: ["the hospital is critical"] },
  objective: "Cover the hospital",
  steps: [],
  communications: [],
  decisions: [
    {
      elementId: "hosp-01",
      priority: 1,
      reasoning: "decision from the stubbed model",
      historyCitation: null,
      actions: [],
    },
  ],
};

/** Captures the prompt: the only way to prove what the retrieval actually injected */
function stubLlm(prompts: string[]): LlmClient {
  return {
    chat: async () => {
      throw new Error("not used in this test");
    },
    structured: async (messages: ChatCompletionMessageParam[]) => {
      prompts.push(messages.map((m) => String(m.content)).join("\n"));
      return {
        text: "{}",
        data: AGENT_OUTPUT as never,
        gateway: "test",
        model: "test",
        latencyMs: 1,
      };
    },
    embeddings: async () => {
      throw new Error("not used in this test");
    },
  };
}

const happyrobot: HappyRobotClient = {
  mode: "simulated",
  contact: () => {
    throw new Error("this test does not communicate");
  },
};

function incident(id: string, type: ElementType): HistoricalIncident {
  return {
    id,
    type,
    title: `Retrieved incident ${id}`,
    summary: `Summary of ${id}`,
    outcome: `Conclusion of ${id}`,
    date: "2026-04-01",
  };
}

interface SearchCall {
  type: ElementType;
  query: string;
  k: number;
}

/** A memory that answers whatever the test needs, and remembers being asked */
function stubRag(
  calls: SearchCall[],
  answer: (type: ElementType) => Promise<RetrievedIncident[]>,
): HistoryRag {
  return {
    preload: async () => 0,
    recordClosure: async () => {},
    search: (type, query, k) => {
      calls.push({ type, query, k });
      return answer(type);
    },
  };
}

/* ─── World under crisis ─────────────────────────────────────────────── */

function element(
  id: string,
  type: ElementType,
  name: string,
  status: ElementView["status"],
  severity: number,
  sensors: ElementView["sensors"],
): ElementView {
  return {
    id,
    type,
    name,
    lat: 40.31,
    lng: -3.71,
    status,
    severity,
    sensors,
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: "2026-09-19T10:00:00.000Z",
  };
}

function crisis(elements: ElementView[]): StateView {
  return {
    tick: 1,
    paused: false,
    started: true,
    simulationClock: "2026-09-19T10:00:00.000Z",
    lastSeq: 0,
    elements,
    resources: [],
  };
}

const hospital = element("hosp-01", "hospital", "Getafe-Sur Regional Hospital", "critical", 88, {
  grid_voltage: 4,
  ups: 22,
});
const substation = element("sub-01", "substation", "Getafe-Sur Substation", "degraded", 55, {
  grid_voltage: 31,
});

/** A site in normal status must not drag its type into the retrieval */
const datacenter = element("dc-01", "datacenter", "Getafe Metropolitan Datacenter", "normal", 5, {
  grid_voltage: 99,
});

function agentWith(rag: AgentOptions["rag"], prompts: string[]) {
  const feed = createFeed();
  return createAgent({
    world: createWorld(script, remedies, topology),
    feed,
    llm: stubLlm(prompts),
    actionRegistry: createActionRegistry(feed),
    happyrobot,
    history,
    rag,
    topology,
    remedies,
    seconds: () => 0,
  });
}

/** The stubbed model's decision arriving means the deliberation ran to the end */
function deliberated(agent: ReturnType<typeof createAgent>): boolean {
  return agent.view().decisions[0]?.reasoning === "decision from the stubbed model";
}

/* ─── Tests ──────────────────────────────────────────────────────────── */

test("a deliberation searches the memory and injects what it retrieves", async () => {
  const calls: SearchCall[] = [];
  const prompts: string[] = [];
  const rag = stubRag(calls, async (type) => [
    { incident: incident(`mem-${type}-1`, type), distance: 0.2, source: "curated" },
  ]);
  const agent = agentWith(Promise.resolve(rag), prompts);

  await agent.observe(crisis([hospital, datacenter]), []);

  assert.equal(calls.length, 1, "one search per affected element type");
  assert.equal(calls[0]?.type, "hospital");
  assert.equal(calls[0]?.k, MAX_HISTORY_PER_TURN);

  const query = calls[0]?.query ?? "";
  assert.match(query, /hospital/, "the query names the affected type");
  assert.match(query, /critical/, "the query carries the live status");
  assert.match(query, /grid_voltage 4/, "the query carries the sensor readings");
  assert.match(query, /no plan yet/, "the query carries why the engine woke up");
  assert.doesNotMatch(query, /datacenter/, "a site in normal status is not part of the query");

  const prompt = prompts[0] ?? "";
  assert.match(prompt, /mem-hospital-1/, "the retrieved incident reaches the prompt");
  assert.match(prompt, /Retrieved because: similar to what is happening at hosp-01/);
  assert.match(prompt, /Conclusion: Conclusion of mem-hospital-1/);
  assert.ok(deliberated(agent));
});

test("one search per affected type, merged and ranked by distance", async () => {
  const calls: SearchCall[] = [];
  const prompts: string[] = [];
  const rag = stubRag(calls, async (type) =>
    type === "hospital"
      ? [
          { incident: incident("close-hosp", "hospital"), distance: 0.1, source: "curated" },
          { incident: incident("far-hosp", "hospital"), distance: 0.9, source: "curated" },
        ]
      : [{ incident: incident("close-sub", "substation"), distance: 0.2, source: "curated" }],
  );
  const agent = agentWith(Promise.resolve(rag), prompts);

  await agent.observe(crisis([hospital, substation]), []);

  assert.deepEqual(
    calls.map((c) => c.type).sort(),
    ["hospital", "substation"],
    "every affected type is searched",
  );
  const prompt = prompts[0] ?? "";
  const order = ["close-hosp", "close-sub", "far-hosp"].map((id) => prompt.indexOf(`[${id}]`));
  assert.ok(
    order.every((position, i) => position > 0 && (i === 0 || position > order[i - 1])),
    `the closest matches come first, got positions ${order.join(", ")}`,
  );
});

test("the per-turn history cap holds even if the memory over-answers", async () => {
  const calls: SearchCall[] = [];
  const prompts: string[] = [];
  const rag = stubRag(calls, async (type) =>
    Array.from({ length: 10 }, (_, i) => ({
      incident: incident(`mem-${type}-${i}`, type),
      distance: i / 10,
      source: "curated" as const,
    })),
  );
  const agent = agentWith(Promise.resolve(rag), prompts);

  await agent.observe(crisis([hospital, substation]), []);

  const prompt = prompts[0] ?? "";
  const injected = prompt.match(/Retrieved because:/g) ?? [];
  assert.equal(
    injected.length,
    MAX_HISTORY_PER_TURN,
    "over-filling the context empties the communications field: the cap is measured",
  );
});

test("without a memory the deliberation runs on the static history", async () => {
  const prompts: string[] = [];
  const agent = agentWith(null, prompts);

  await agent.observe(crisis([hospital]), []);

  const prompt = prompts[0] ?? "";
  assert.match(prompt, /hist-hosp-001/, "the JSON history takes over");
  assert.match(prompt, /same site type as the sites in trouble/);
  assert.ok(deliberated(agent), "the deliberation finishes, no fallback to rules");
});

test("a memory that never came up degrades to the static history", async () => {
  const prompts: string[] = [];
  const agent = agentWith(Promise.resolve(null), prompts);

  await agent.observe(crisis([hospital]), []);

  assert.match(prompts[0] ?? "", /hist-hosp-001/);
  assert.ok(deliberated(agent));
});

test("a memory that throws never breaks the deliberation", async () => {
  const prompts: string[] = [];
  const failing: HistoryRag = {
    preload: async () => 0,
    recordClosure: async () => {},
    search: async () => {
      throw new Error("chroma is not answering");
    },
  };
  const agent = agentWith(Promise.resolve(failing), prompts);

  await agent.observe(crisis([hospital]), []);

  assert.match(prompts[0] ?? "", /hist-hosp-001/, "the static history takes over");
  assert.ok(deliberated(agent), "the deliberation finishes, no fallback to rules");
});

test("a slow memory is skipped, it does not delay the decision", async () => {
  const prompts: string[] = [];
  const stalled: HistoryRag = {
    preload: async () => 0,
    recordClosure: async () => {},
    search: () =>
      new Promise((resolve) => {
        // longer than any deliberation: if it were awaited, this test would hang
        setTimeout(() => resolve([]), 120_000).unref();
      }),
  };
  const agent = agentWith(Promise.resolve(stalled), prompts);

  const start = Date.now();
  await agent.observe(crisis([hospital]), []);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 10_000, `the retrieval must be cut short, it took ${elapsed} ms`);
  assert.match(prompts[0] ?? "", /hist-hosp-001/, "the static history takes over");
  assert.ok(deliberated(agent));
});
