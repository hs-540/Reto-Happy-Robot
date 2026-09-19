import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementType, type ElementView, type StateView } from "@swarmup/shared";
import { createAgent, type Agent } from "../src/agent.js";
import { createFeed } from "../src/feed.js";
import { createActionRegistry } from "../src/control.js";
import { createWorld, type World } from "../src/world.js";
import { loadScript } from "../src/script.js";
import type { LlmClient } from "../src/llm.js";
import type { HappyRobotClient } from "../src/happyrobot.js";

/**
 * The contingency playbook is not exported: it is what `observe` falls back to.
 * These tests reach it the only way production does — by making the LLM fail —
 * and then read the world and the plan the agent left behind.
 */

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const brokenLlm: LlmClient = {
  chat: () => Promise.reject(new Error("gateway down")),
  structured: () => Promise.reject(new Error("gateway down")),
  embeddings: () => Promise.resolve([]),
};

const silentHappyRobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

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
  const agent = createAgent({
    world,
    feed,
    llm: brokenLlm,
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

  return { feed, world, agent, state };
}

/**
 * Parks every resource on a site its remedy can actually serve, away from the
 * incident under test. Assigning a resource where its remedy does not apply is
 * refused now (it would park the resource forever), so the setup has to be a
 * legal move too.
 */
const PARKING_TYPE: Record<string, ElementType> = {
  crew: "substation",
  generator: "hospital",
  tanker: "fuel_station",
  police: "junction",
};

function parkEverythingOn(world: World, avoid: string[] = [], except: string[] = []): void {
  for (const r of world.resources()) {
    if (except.includes(r.id)) continue;
    const target = script.elements.find(
      (e) => e.type === PARKING_TYPE[r.type] && !avoid.includes(e.id),
    );
    assert.ok(target, `the scenario needs a ${PARKING_TYPE[r.type]} to park ${r.id}`);
    assert.equal(world.assign(r.id, target.id, 0).ok, true, `${r.id} should park on ${target.id}`);
  }
}

/** Resources the world says are committed to `elementId`, deployed or en route */
function coveringResources(world: World, elementId: string): string[] {
  return world
    .resources()
    .filter((r) => r.assignedElementId === elementId && r.status !== "available")
    .map((r) => r.id);
}

function objectiveOf(agent: Agent): string {
  const plan = agent.view().currentPlan;
  assert.ok(plan, "the contingency playbook must publish a plan");
  return plan.objective;
}

test("the playbook does not send a second resource to an already covered site", async () => {
  const elements = [
    element("hosp-01", { sensors: { grid_voltage: 5, generator_battery: 30 } }),
    element("tower-01", { sensors: { tower_battery: 21 } }),
  ];
  const { agent, world, state } = setup(elements);

  // generator-1 is on its way: hosp-01 is covered although nothing is there yet
  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "in_transit");

  await agent.observe(state(), []);

  assert.deepEqual(
    coveringResources(world, "hosp-01"),
    ["generator-1"],
    "a resource in transit counts as covered: no second resource goes to hosp-01",
  );
  assert.equal(
    agent.view().decisions[0]?.elementId,
    "tower-01",
    "the playbook should move on to the highest-priority site nobody covers",
  );
  assert.match(objectiveOf(agent), /tower-01/);
});

test("the playbook only assigns a resource whose remedy applies to the site type", async () => {
  // sub-01 is a substation: remedies.json declares no tanker remedy for it.
  const elements = [
    element("sub-01", { sensors: { grid_voltage: 4 } }),
    element("fuel-01", { status: "normal", severity: 10 }),
  ];
  const { agent, world, state } = setup(elements);

  // the tanker is the only thing left free, so a naive "first available
  // resource" pick would drive it to a substation it cannot help
  parkEverythingOn(world, ["sub-01"], ["tanker-1"]);
  assert.equal(world.resources().find((r) => r.id === "tanker-1")?.status, "available");

  await agent.observe(state(), []);

  assert.deepEqual(
    coveringResources(world, "sub-01"),
    [],
    "no tanker remedy exists for a substation: the trip must not be made",
  );
  assert.equal(
    world.resources().find((r) => r.id === "tanker-1")?.status,
    "available",
    "the tanker stays free for a site it can actually serve",
  );
  assert.match(objectiveOf(agent), /Contingency mode — holding on sub-01/);
  assert.match(objectiveOf(agent), /no free resource whose declared remedy applies/);
});

test("with nothing sensible to commit the playbook holds, and states why", async () => {
  const elements = [
    element("tower-01", { sensors: { tower_battery: 21 } }),
    element("fuel-01", { status: "normal", severity: 10 }),
  ];
  const { agent, world, state } = setup(elements);

  parkEverythingOn(world, ["tower-01"]);

  await agent.observe(state(), []);

  assert.deepEqual(
    coveringResources(world, "tower-01"),
    [],
    "with everything committed elsewhere nothing may be conjured up",
  );
  assert.match(objectiveOf(agent), /Contingency mode — holding on tower-01/);

  const decision = agent.view().decisions[0];
  assert.ok(decision, "a hold is still a decision and must be published");
  assert.match(decision.reasoning, /Contingency playbook: tower-01/);
  assert.match(decision.reasoning, /no free resource whose declared remedy applies/);
});

test("the playbook never emits an action its own validator would veto", async () => {
  // dc-01 at ups_load 9% is below the act threshold: `critical-ups-act` forbids
  // waiting on it, so a plain `wait` would be vetoed by the agent's own rules.
  const elements = [
    element("dc-01", { sensors: { grid_voltage: 8, ups_load: 9, temperature: 41 } }),
    element("fuel-01", { status: "normal", severity: 10 }),
  ];
  const { agent, world, state } = setup(elements);

  parkEverythingOn(world, ["dc-01"]);

  await agent.observe(state(), []);

  assert.match(objectiveOf(agent), /Contingency mode — escalating dc-01/);
  // `contact` is the one action type `validateAction` never blocks
  const escalations = agent.view().decisions.flatMap((d) => d.actions);
  assert.ok(
    escalations.some((a) => a.type === "voice_call" && a.targetElementId === "dc-01"),
    `the escalation must leave the agent as a real call, got ${JSON.stringify(escalations)}`,
  );
  assert.match(agent.view().decisions[0]?.reasoning ?? "", /critical-ups-act/);
});

test("contingency mode announces itself as a designed degraded mode", async () => {
  const elements = [element("tower-01", { sensors: { tower_battery: 21 } })];
  const { agent, feed, state } = setup(elements);

  await agent.observe(state(), []);

  const messages = feed
    .since(0)
    .filter((i) => i.kind === "system")
    .map((i) => (i.kind === "system" ? i.message : ""));
  assert.ok(
    messages.some((m) => m.includes("Contingency mode engaged")),
    `the jury must read a designed mode, not a crash; got ${JSON.stringify(messages)}`,
  );
  assert.ok(
    !messages.some((m) => m.includes("LLM unavailable")),
    "the old crash-sounding wording is gone",
  );
});
