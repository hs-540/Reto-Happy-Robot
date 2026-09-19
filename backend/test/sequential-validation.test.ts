import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementView, type StateView } from "@swarmup/shared";
import { createAgent, stripIllegalActions, validateSequentially } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";
import type { ValidationContext } from "@swarmup/shared";

/**
 * A whole proposal used to be validated against the SAME pre-execution
 * snapshot, so two actions could promise the same unit: both passed
 * validation, the first `world.assign` took it, and the second died at
 * execution — a rejection the retry loop never got to fix. These tests pin
 * the sequential semantics: each action is judged against the state its
 * predecessors leave behind.
 */

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const silentHappyRobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

interface PlannedOutput {
  evaluation: { discarded: string[]; actionable: string[] };
  objective: string;
  steps: { description: string; elementId: string | null }[];
  communications: unknown[];
  decisions: {
    elementId: string;
    priority: number;
    reasoning: string;
    historyCitation: string | null;
    actions: {
      type: "assign_resource" | "contact" | "wait";
      elementId: string;
      resourceId: string | null;
      channel: string | null;
      recipient: string | null;
      message: string;
    }[];
  }[];
}

function outputWithAssignments(pairs: [resourceId: string, elementId: string][]): PlannedOutput {
  return {
    evaluation: { discarded: [], actionable: ["the model's triage"] },
    objective: `Cover ${pairs.map(([, e]) => e).join(", ")}`,
    steps: [],
    communications: [],
    decisions: pairs.map(([resourceId, elementId]) => ({
      elementId,
      priority: 1,
      reasoning: "decision from the stubbed model",
      historyCitation: null,
      actions: [
        {
          type: "assign_resource" as const,
          elementId,
          resourceId,
          channel: null,
          recipient: null,
          message: `Commit ${resourceId} to ${elementId}`,
        },
      ],
    })),
  };
}

/** Answers with the scripted outputs in order, and counts the calls */
function scriptedLlm(outputs: PlannedOutput[]): { llm: LlmClient; calls: () => number } {
  let count = 0;
  return {
    calls: () => count,
    llm: {
      chat: () => Promise.reject(new Error("not used in this test")),
      structured: async () => {
        const data = outputs[Math.min(count, outputs.length - 1)];
        count += 1;
        return { text: "{}", data: data as never, gateway: "test", model: "test", latencyMs: 1 };
      },
      embeddings: () => Promise.reject(new Error("not used in this test")),
    },
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

function setup(elements: ElementView[], llm: LlmClient) {
  const feed = createFeed();
  const world = createWorld(script, remedies, topology);
  const agent = createAgent({
    world,
    feed,
    llm,
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

test("a duplicated assignment inside one proposal is rejected, not executed twice", async () => {
  // the model promises generator-1 to hosp-01 twice; the second promise must
  // come back as a rejection instead of dying silently at world.assign
  const { llm, calls } = scriptedLlm([
    outputWithAssignments([
      ["generator-1", "hosp-01"],
      ["generator-1", "hosp-01"],
    ]),
  ]);
  const elements = [element("hosp-01"), element("fuel-01", { status: "normal", severity: 10 })];
  const { feed, world, agent, state } = setup(elements, llm);
  parkEverythingOn(world, "fuel-01", ["generator-1"]);

  await agent.observe(state(), []);

  assert.equal(calls(), 2, "the rejection must be handed back for one retry");
  assert.deepEqual(
    covering(world, "hosp-01"),
    ["generator-1"],
    "exactly one assignment survives",
  );
  const decision = agent.view().decisions.find((d) => d.elementId === "hosp-01");
  assert.ok(decision);
  const okAssignments = agent
    .view()
    .decisions.filter((d) => d.elementId === "hosp-01")
    .flatMap((d) => d.assignments)
    .filter((a) => a.ok).length;
  assert.equal(
    okAssignments,
    1,
    "the executed proposal carries exactly one successful assignment",
  );
  const blocked = feed
    .since(0)
    .filter((i) => i.kind === "system")
    .map((i) => (i.kind === "system" ? i.message : ""))
    .filter((m) => m.includes("Action blocked by hard rules"));
  assert.ok(
    blocked.some((m) => m.includes("no-double-assignment") && m.includes("in_transit")),
    `the duplicate must be rejected against the state the first one left behind, got ${JSON.stringify(blocked)}`,
  );
});

test("a surplus generator reaches a second site in the same proposal", async () => {
  // two free generators, one hospital at risk: the ration must not stop the
  // surplus from covering the datacenter in the same deliberation
  const { llm, calls } = scriptedLlm([
    outputWithAssignments([
      ["generator-1", "hosp-01"],
      ["generator-2", "dc-01"],
    ]),
  ]);
  const elements = [element("hosp-01"), element("dc-01"), element("fuel-01", { status: "normal", severity: 10 })];
  const { world, agent, state } = setup(elements, llm);
  parkEverythingOn(world, "fuel-01", ["generator-1", "generator-2"]);

  await agent.observe(state(), []);

  assert.equal(calls(), 1, "a legal proposal must not burn the retry");
  assert.deepEqual(covering(world, "hosp-01"), ["generator-1"]);
  assert.deepEqual(covering(world, "dc-01"), ["generator-2"]);
});

test("the hospital ration re-engages mid-proposal once the surplus is consumed", () => {
  // three free generators, one hospital at risk: the first two actions spend
  // the surplus on the datacenter and the tower, so by the third action the
  // hospital is still uncovered and its ration holds — judged against the
  // fleet the first two left behind, not against the pre-execution snapshot
  // that would have waved all three through
  const context: ValidationContext = {
    elements: [
      {
        id: "hosp-01",
        type: "hospital",
        status: "critical",
        metrics: { grid_voltage: 4 },
        // 5 min: past zero, so the hospital is at risk and the ration is on,
        // but under the 8-minute limit so `hospital-power-deadline` (which
        // pins EVERYTHING while the hospital is unanswered) stays out of the
        // way — this test is about the priority ration re-engaging
        secondsWithoutPower: 300,
      },
      {
        id: "dc-01",
        type: "datacenter",
        status: "critical",
        metrics: {},
        secondsWithoutPower: 300,
      },
      {
        id: "tower-01",
        type: "tower",
        status: "critical",
        metrics: {},
        secondsWithoutPower: 300,
      },
    ],
    resources: [
      { id: "generator-1", type: "generator", status: "available", assignedElementId: null },
      { id: "generator-2", type: "generator", status: "available", assignedElementId: null },
      { id: "generator-3", type: "generator", status: "available", assignedElementId: null },
    ],
  };
  const proposal = outputWithAssignments([
    ["generator-1", "dc-01"],
    ["generator-2", "tower-01"],
    ["generator-3", "dc-01"],
  ]);

  const rejections = validateSequentially(proposal as never, context);
  assert.equal(rejections.length, 1);
  assert.match(rejections[0] ?? "", /\[hospital-power-priority\]/);
  assert.match(rejections[0] ?? "", /rationed/);

  const stripped = stripIllegalActions(proposal as never, context);
  const kept = stripped.decisions.flatMap((d) => d.actions.map((a) => `${a.resourceId}→${a.elementId}`));
  assert.deepEqual(
    kept,
    ["generator-1→dc-01", "generator-2→tower-01"],
    "the surplus goes out, the generator the hospital still needs stays",
  );
});
