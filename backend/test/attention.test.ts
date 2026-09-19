import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology } from "@swarmup/shared";
import { createAgent } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { createWorld, type World } from "../src/world.js";
import { loadScript } from "../src/script.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

function agentOver(world: World) {
  const feed = createFeed();
  const happyrobot: HappyRobotClient = { mode: "simulated", contact: () => {} };
  return createAgent({
    world,
    feed,
    llm: {} as unknown as LlmClient,
    actionRegistry: createActionRegistry(feed),
    happyrobot,
    history: [],
    topology,
    remedies,
    seconds: () => 0,
  });
}

test("a site nobody is looking at is unattended", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(agentOver(world).attention("hosp-01", "critical").state, "unattended");
});

test("a resource still driving is en route, not deployed", () => {
  const world = createWorld(script, remedies, topology);
  const agent = agentOver(world);

  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "in_transit");

  const attention = agent.attention("hosp-01", "critical");
  assert.equal(attention.state, "resource_en_route");
  assert.equal(attention.resourceId, "generator-1");
});

test("once it arrives it counts as deployed", () => {
  const world = createWorld(script, remedies, topology);
  const agent = agentOver(world);

  world.assign("generator-1", "hosp-01", 0);
  for (let t = 60; t <= 1200; t += 60) world.advance(t, []);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "assigned");

  assert.equal(agent.attention("hosp-01", "critical").state, "resource_assigned");
});

test("a resolved site says so, even with its resource still on site", () => {
  const world = createWorld(script, remedies, topology);
  const agent = agentOver(world);

  world.assign("generator-1", "hosp-01", 0);
  for (let t = 60; t <= 1200; t += 60) world.advance(t, []);

  assert.equal(agent.attention("hosp-01", "resolved").state, "resolved");
});

test("a resolved site whose resource was released is not reported as uncovered", () => {
  const world = createWorld(script, remedies, topology);
  const agent = agentOver(world);

  world.assign("generator-1", "hosp-01", 0);
  world.release("generator-1");

  // this is the trap: no resource and no decision used to read as NOT COVERED,
  // which invites sending help back to a site that is already fixed
  assert.equal(agent.attention("hosp-01", "resolved").state, "resolved");
});
