import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { loadRemedies, loadTopology, type ElementView, type StateView } from "@swarmup/shared";
import { createAgent } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

/**
 * On a live run, four units stood down between deliberations and two of them
 * waited for the LAST deliberation of the simulation — their ETAs landing
 * after the crisis was over. Nothing wakes the engine for a freed unit: no
 * sensor moves, and the one `released` event was already consumed. These
 * tests pin the mechanical answer: on a tick with NO reason to deliberate,
 * free units are paired with uncovered sites directly, without an LLM call.
 */

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const silentHappyRobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

/** A model that plans but moves nothing: the gap is left for the idle pass */
function planningLlm(calls: { count: number }[]): LlmClient {
  return {
    chat: () => Promise.reject(new Error("not used in this test")),
    structured: async (_messages: ChatCompletionMessageParam[]) => {
      calls.count += 1;
      return {
        text: "{}",
        data: {
          evaluation: { discarded: [], actionable: ["the model's triage"] },
          objective: "Watch: no moves committed by the model",
          steps: [],
          communications: [],
          decisions: [
            {
              elementId: "tower-01",
              priority: 1,
              reasoning: "the model holds, as judgement calls may",
              historyCitation: null,
              actions: [],
            },
          ],
        } as never,
        gateway: "test",
        model: "test",
        latencyMs: 1,
      };
    },
    embeddings: () => Promise.reject(new Error("not used in this test")),
  };
}

function element(id: string, overrides: Partial<ElementView> = {}): ElementView {
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
    sensors: {},
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(elements: ElementView[]) {
  const feed = createFeed();
  const world = createWorld(script, remedies, topology);
  const calls = { count: 0 };
  const agent = createAgent({
    world,
    feed,
    llm: planningLlm(calls),
    actionRegistry: createActionRegistry(feed),
    happyrobot: silentHappyRobot,
    history: [],
    topology,
    remedies,
    seconds: () => 0,
  });
  const state = (): StateView => ({
    tick: 1,
    paused: false,
    started: true,
    simulationClock: new Date().toISOString(),
    lastSeq: feed.lastSeq(),
    elements,
    resources: world.resources(),
  });
  return { feed, world, agent, state, calls };
}

function parkEverythingOn(world: ReturnType<typeof createWorld>, elementId: string, except: string[] = []): void {
  for (const r of world.resources()) {
    if (except.includes(r.id)) continue;
    assert.equal(world.assign(r.id, elementId, 0).ok, true, `${r.id} should park on ${elementId}`);
  }
}

function covering(world: ReturnType<typeof createWorld>, elementId: string): string[] {
  return world
    .resources()
    .filter((r) => r.assignedElementId === elementId && r.status !== "available")
    .map((r) => r.id);
}

function systemMessages(feed: ReturnType<typeof createFeed>): string[] {
  return feed
    .since(0)
    .filter((i) => i.kind === "system")
    .map((i) => (i.kind === "system" ? i.message : ""));
}

test("free units reach uncovered sites without a deliberation", async () => {
  const elements = [
    element("tower-01", { sensors: { tower_battery: 21 } }),
    element("junction-01", {}),
    element("fuel-01", { status: "normal", severity: 10 }),
  ];
  const { feed, world, agent, state, calls } = setup(elements);
  parkEverythingOn(world, "fuel-01", ["generator-2", "generator-3", "police-1"]);

  // first tick: the engine deliberates (the model holds, moves nothing)
  await agent.observe(state(), []);
  assert.equal(calls.count, 1);

  // second tick: nothing changed — no trigger, no status change, no backlog
  await agent.observe(state(), []);

  assert.equal(calls.count, 1, "the idle pass must not deliberate");
  assert.deepEqual(covering(world, "tower-01"), ["generator-2"]);
  assert.deepEqual(covering(world, "junction-01"), ["police-1"]);
  const gen3 = world.resources().find((r) => r.id === "generator-3");
  assert.equal(gen3?.status, "available", "no unit is spent beyond the gaps");

  const decision = agent.view().decisions[0];
  assert.match(decision?.reasoning ?? "", /Idle capacity/);
  const messages = systemMessages(feed);
  assert.ok(
    messages.some((m) => m.includes("Idle-capacity watch")),
    `the pass must announce itself, got ${JSON.stringify(messages)}`,
  );
  assert.ok(
    !messages.some((m) => m.includes("Contingency mode engaged")),
    "this is not a fallback: the deliberation machinery never failed",
  );
});

test("with no free unit that fits, the idle pass does nothing", async () => {
  const elements = [
    element("sub-01"),
    element("junction-01", {}),
    element("fuel-01", { status: "normal", severity: 10 }),
  ];
  const { feed, world, agent, state, calls } = setup(elements);
  // the tanker fits neither a substation nor a junction: no pairing exists
  parkEverythingOn(world, "fuel-01", ["tanker-1"]);

  await agent.observe(state(), []);
  await agent.observe(state(), []);

  assert.equal(calls.count, 1, "no deliberation may be burned on an unpairable gap");
  assert.deepEqual(covering(world, "sub-01"), []);
  assert.deepEqual(covering(world, "junction-01"), []);
  assert.equal(
    world.resources().find((r) => r.id === "tanker-1")?.status,
    "available",
    "the tanker is not driven to a site its remedy does not declare",
  );
  assert.ok(
    !systemMessages(feed).some((m) => m.includes("Idle-capacity watch")),
    "no pairing, no announcement",
  );
});
