import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadRemedies,
  loadTopology,
  type ElementView,
  type StateView,
} from "@swarmup/shared";
import { createAgent } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const happyrobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

/** A model that insists on a tanker for a substation: the catalog says it cannot help */
const badProposal = {
  evaluation: { discarded: [], actionable: [] },
  objective: "Tanker to the substation",
  steps: [],
  communications: [],
  decisions: [
    {
      elementId: "sub-01",
      priority: 1,
      reasoning: "send the tanker to the substation",
      historyCitation: null,
      actions: [
        {
          type: "assign_resource",
          elementId: "sub-01",
          resourceId: "tanker-1",
          channel: null,
          recipient: null,
          message: "tanker-1 to sub-01",
        },
      ],
    },
  ],
  directiveResponses: [],
};

const llm: LlmClient = {
  structured: async (_messages: ChatCompletionMessageParam[]) => ({
    text: "{}",
    data: badProposal as never,
    gateway: "test",
    model: "test",
    latencyMs: 1,
  }),
  embeddings: async () => [],
};

function element(id: string): ElementView {
  const seed = script.elements.find((e) => e.id === id);
  assert.ok(seed, `the scenario must contain ${id}`);
  return {
    id: seed.id,
    type: seed.type,
    name: seed.name,
    lat: seed.lat,
    lng: seed.lng,
    status: "critical",
    severity: 85,
    sensors: { grid_voltage: 4 },
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: new Date().toISOString(),
  };
}

test("an assignment whose remedy does not apply is rejected and never executed", async () => {
  const feed = createFeed();
  const world = createWorld(script, remedies, topology);
  const agent = createAgent({
    world,
    feed,
    llm,
    actionRegistry: createActionRegistry(feed),
    happyrobot,
    history: [],
    topology,
    remedies,
    seconds: () => 0,
  });
  const state: StateView = {
    tick: 1,
    paused: false,
    started: true,
    simulationClock: new Date().toISOString(),
    lastSeq: 0,
    elements: [element("sub-01")],
    resources: world.resources(),
  };

  await agent.observe(state, []);

  const system = feed
    .since(0)
    .filter((i) => i.kind === "system")
    .map((i) => (i.kind === "system" ? i.message : ""));
  assert.ok(
    system.some((m) => m.includes("[remedy-not-applicable]") && m.includes("tanker-1")),
    `the model must be told why, got ${JSON.stringify(system)}`,
  );
  assert.ok(
    !system.some((m) => m.startsWith("tanker-1 →")),
    "the trip is never committed",
  );
  assert.equal(
    world.resources().find((r) => r.id === "tanker-1")?.status,
    "available",
    "the tanker stays free for a site it can serve",
  );
});
