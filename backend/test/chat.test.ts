import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementView, type StateView } from "@swarmup/shared";
import { createAgent } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import type { OperatorIntent } from "../src/prompt.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

/**
 * The operator channel. The agent decides alone, but a human watching the same
 * map can order it around — and those orders face the same validator the
 * model's own proposals do. These tests pin both halves: an order that is
 * legal moves the world, and an order that is not comes back naming the rule
 * that refused it, with nothing moved.
 */

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const silentHappyRobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

/** The chat path never reaches the model in these tests: intents arrive already parsed */
const unusedLlm: LlmClient = {
  structured: () => Promise.reject(new Error("not used in this test")),
  embeddings: () => Promise.reject(new Error("not used in this test")),
};

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
    llm: unusedLlm,
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
    finished: false,
    simulationClock: new Date().toISOString(),
    lastSeq: feed.lastSeq(),
    elements,
    resources: world.resources(),
  });
  return { feed, world, agent, state };
}

function intent(overrides: Partial<OperatorIntent> & { kind: OperatorIntent["kind"] }): OperatorIntent {
  return { elementId: null, resourceId: null, note: "the operator says so", ...overrides };
}

function scoreOf(
  world: ReturnType<typeof createWorld>,
  elements: ElementView[],
  elementId: string,
): number {
  const found = world.priorities(elements).find((p) => p.elementId === elementId);
  assert.ok(found, `${elementId} must be in the ranking`);
  return found.score;
}

test("an assignment the operator orders is executed and recorded as a decision of its own", () => {
  const elements = [element("tower-01"), element("hosp-01", { status: "degraded" })];
  const { agent, world, state } = setup(elements);

  const [directive] = agent.command(
    state(),
    [intent({ kind: "assign", elementId: "tower-01", resourceId: "crew-1" })],
  );

  assert.equal(directive.accepted, true);
  assert.equal(directive.reason, null);
  const crew = world.resources().find((r) => r.id === "crew-1");
  assert.equal(crew?.assignedElementId, "tower-01");

  // the panel must show who decided it: an operator move with no decision
  // behind it reads later as a resource the agent moved for no reason
  const decision = agent.view().decisions[0];
  assert.equal(decision.elementId, "tower-01");
  assert.match(decision.reasoning, /Operator order/);
  assert.deepEqual(
    decision.assignments.map((a) => [a.resourceId, a.ok]),
    [["crew-1", true]],
  );
});

test("an order the hard rules refuse moves nothing and comes back naming the rule", () => {
  const elements = [element("tower-01"), element("tower-02")];
  const { agent, world, state } = setup(elements);

  assert.equal(world.assign("crew-1", "tower-01", 0).ok, true);
  const before = world.resources().find((r) => r.id === "crew-1")?.assignedElementId;

  const [directive] = agent.command(
    state(),
    [intent({ kind: "assign", elementId: "tower-02", resourceId: "crew-1" })],
  );

  assert.equal(directive.accepted, false);
  assert.match(directive.reason ?? "", /no-double-assignment/);
  assert.equal(world.resources().find((r) => r.id === "crew-1")?.assignedElementId, before);
  assert.equal(agent.view().decisions.length, 0);
});

test("an order naming a site or a unit that does not exist is refused, not guessed", () => {
  const elements = [element("tower-01")];
  const { agent, state } = setup(elements);

  const directives = agent.command(state(), [
    intent({ kind: "assign", elementId: "moon-base", resourceId: "crew-1" }),
    intent({ kind: "assign", elementId: "tower-01", resourceId: "helicopter-9" }),
  ]);

  assert.deepEqual(
    directives.map((d) => d.accepted),
    [false, false],
  );
  assert.match(directives[0].reason ?? "", /no site called/);
  assert.match(directives[1].reason ?? "", /no unit called/);
});

test("a priority order moves the site in the ranking every consumer reads, and stands", () => {
  const elements = [element("junction-01", { status: "degraded" }), element("tower-01")];
  const { agent, world, state } = setup(elements);
  const before = scoreOf(world, elements, "junction-01");

  const [directive] = agent.command(
    state(),
    [intent({ kind: "prioritize", elementId: "junction-01", note: "a school is being evacuated through it" })],
  );

  assert.equal(directive.accepted, true);
  assert.ok(
    scoreOf(world, elements, "junction-01") > before,
    "the ordered site must outrank what it was worth before",
  );
  // it shapes every deliberation from now on, not only the tick it was given in
  assert.deepEqual(
    agent.standing().map((d) => [d.kind, d.elementId]),
    [["prioritize", "junction-01"]],
  );
});

test("a note carries into the next deliberations and moves nothing by itself", () => {
  const elements = [element("hosp-01")];
  const { agent, world, state } = setup(elements);

  const [directive] = agent.command(
    state(),
    [intent({ kind: "note", elementId: "hosp-01", note: "the ICU is already on a private generator" })],
  );

  assert.equal(directive.accepted, true);
  assert.equal(agent.standing().length, 1);
  assert.deepEqual(
    world.resources().filter((r) => r.status !== "available"),
    [],
    "a note commits nothing",
  );
});

test("standing orders are dropped on reset: a new run inherits no orders from the last one", () => {
  const elements = [element("tower-01")];
  const { agent, state } = setup(elements);

  agent.command(state(), [intent({ kind: "prioritize", elementId: "tower-01" })]);
  assert.equal(agent.standing().length, 1);

  agent.reset();
  assert.deepEqual(agent.standing(), []);
});
