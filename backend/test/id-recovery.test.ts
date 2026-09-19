import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadRemedies,
  loadTopology,
  type ElementView,
  type ResourceView,
  type StateView,
} from "@swarmup/shared";
import { createAgent, reanchorOutput, resolveElementId } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

/**
 * On a live run the model wrote "sub-O2" — letter O — into an action whose
 * reasoning correctly said "Sub-02": the decision was sound, the label was
 * not, and `world.assign` bounced the move as "nonexistent element". These
 * tests pin the recovery: ids are re-anchored to the world before anything
 * judges or executes the proposal.
 */

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const silentHappyRobot: HappyRobotClient = { mode: "simulated", contact: () => {} };

/* ─── resolveElementId ───────────────────────────────────────────────── */

const SITE_IDS = ["sub-01", "sub-02", "sub-03", "hosp-01", "hosp-02", "hosp-03", "tower-01"].map(
  (id) => ({ id }),
);

test("a letter-for-digit typo recovers the intended site", () => {
  assert.equal(resolveElementId("sub-O2", SITE_IDS), "sub-02");
  assert.equal(resolveElementId("hosp-O2", SITE_IDS), "hosp-02");
});

test("case, zero-padding and separators are folded on both sides", () => {
  assert.equal(resolveElementId("HOSP-2", SITE_IDS), "hosp-02");
  assert.equal(resolveElementId("hosp-2", SITE_IDS), "hosp-02");
  assert.equal(resolveElementId("Sub_02", SITE_IDS), "sub-02");
  assert.equal(resolveElementId("sub-02", SITE_IDS), "sub-02", "exact ids pass through");
});

test("resource ids recover the same way", () => {
  const units = ["crew-1", "generator-1", "generator-2"].map((id) => ({ id }));
  assert.equal(resolveElementId("crew-O1", units), "crew-1");
  assert.equal(resolveElementId("Generator-2", units), "generator-2");
});

test("ambiguous or unknown ids come back unchanged, never guessed", () => {
  assert.equal(resolveElementId("sub-9", SITE_IDS), "sub-9", "no such site");
  assert.equal(resolveElementId("sub", SITE_IDS), "sub", "three substations share the prefix");
  assert.equal(resolveElementId("tower-0", SITE_IDS), "tower-0", "no digit follows to anchor");
  assert.equal(resolveElementId("", SITE_IDS), "", "empty stays empty");
});

/* ─── Through the agent ──────────────────────────────────────────────── */

function typedLlm(calls: string[]): LlmClient {
  return {
    chat: () => Promise.reject(new Error("not used in this test")),
    structured: async (messages: ChatCompletionMessageParam[]) => {
      calls.push(messages.map((m) => String(m.content)).join("\n"));
      return {
        text: "{}",
        data: {
          evaluation: { discarded: [], actionable: ["sub-02 is the only critical node"] },
          objective: "Send the crew to sub-02",
          steps: [{ description: "Send crew-1 to sub-02", elementId: "sub-O2" }],
          communications: [],
          decisions: [
            {
              elementId: "sub-O2",
              priority: 1,
              reasoning: "Sub-02 feeds four sites; one crew restores them all at once",
              historyCitation: null,
              actions: [
                {
                  type: "assign_resource" as const,
                  elementId: "sub-O2",
                  resourceId: "crew-O1",
                  channel: null,
                  recipient: null,
                  message: "Commit crew-1 to sub-02",
                },
              ],
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
  const calls: string[] = [];
  const agent = createAgent({
    world,
    feed,
    llm: typedLlm(calls),
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

test("a mistyped assignment reaches the site it was meant for", async () => {
  const elements = [element("sub-02"), element("fuel-01", { status: "normal", severity: 10 })];
  const { feed, world, agent, state } = setup(elements);

  await agent.observe(state(), []);

  const crew = world.resources().find((r) => r.id === "crew-1");
  assert.equal(crew?.assignedElementId, "sub-02", "crew-O1 → crew-1 → sub-O2 → sub-02");
  assert.equal(crew?.status, "in_transit");

  const decision = agent.view().decisions[0];
  assert.ok(decision, "the decision is recorded");
  assert.equal(decision.assignments[0]?.ok, true, "the assignment executed");
  assert.equal(decision.assignments[0]?.elementId, "sub-02");

  const messages = feed
    .since(0)
    .filter((i) => i.kind === "system")
    .map((i) => (i.kind === "system" ? i.message : ""));
  assert.ok(
    messages.some((m) => m.includes("crew-1 → sub-02")),
    `the recovery must publish a successful assignment, got ${JSON.stringify(messages)}`,
  );
  assert.ok(
    !messages.some((m) => m.includes("Could not assign")),
    "the move must not bounce as a nonexistent element",
  );
});

test("the citation recovers against the retrieved incidents", () => {
  const elements = [element("sub-02")];
  const { world } = setup(elements);
  const state = (): StateView => ({
    tick: 1,
    paused: false,
    started: true,
    simulationClock: new Date().toISOString(),
    lastSeq: 0,
    elements,
    resources: world.resources() as ResourceView[],
  });
  const reanchored = reanchorOutput(
    {
      evaluation: { discarded: [], actionable: [] },
      objective: "o",
      steps: [],
      communications: [],
      decisions: [
        {
          elementId: "sub-O2",
          priority: 1,
          reasoning: "r",
          historyCitation: "hist-sub-OO2",
          actions: [],
        },
      ],
    },
    state(),
    [{ incident: { id: "hist-sub-002" } }],
  );
  assert.equal(reanchored.decisions[0]?.elementId, "sub-02");
  assert.equal(reanchored.decisions[0]?.historyCitation, "hist-sub-002");
});
