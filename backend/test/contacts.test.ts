import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementView, type StateView } from "@swarmup/shared";
import { createAgent, resolveContact } from "../src/agent.js";
import { createActionRegistry } from "../src/control.js";
import { createFeed } from "../src/feed.js";
import type { ContactRequest, HappyRobotClient } from "../src/happyrobot.js";
import type { LlmClient } from "../src/llm.js";
import { createWorld } from "../src/world.js";
import { loadScript } from "../src/script.js";
import type { AgentOutput } from "../src/prompt.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

const contacts = remedies.contacts;

/**
 * Verbatim from a full run: every one of these was written by the agent and
 * dropped by an exact-id lookup, and nobody was called.
 */
const AS_THE_MODEL_WROTE_THEM = [
  ["emergency-coordinator (Madrid 112)", "emergency-coordinator"],
  ["Iván Pombo (datacenter-operator)", "datacenter-operator"],
  ["Dr. Elena Duarte (hospital-lead)", "hospital-lead"],
  ["Lucía Marín (ventilator-citizen)", "ventilator-citizen"],
] as const;

test("a bare id still resolves to itself", () => {
  for (const c of contacts) {
    assert.equal(resolveContact(contacts, c.id)?.id, c.id);
  }
});

test("the recipients a real run dropped now resolve", () => {
  for (const [written, expected] of AS_THE_MODEL_WROTE_THEM) {
    assert.equal(resolveContact(contacts, written)?.id, expected, `failed on "${written}"`);
  }
});

test("a name alone is enough, accents and title included", () => {
  assert.equal(resolveContact(contacts, "Ángel Rivas")?.id, "crew-chief");
  assert.equal(resolveContact(contacts, "call Marta Saez now")?.id, "tanker-driver");
});

test("a role alone is enough when no id and no name are given", () => {
  assert.equal(resolveContact(contacts, "the Hospital duty lead")?.id, "hospital-lead");
});

test("a numbered id written in prose does not fall back to the shorter one", () => {
  assert.equal(resolveContact(contacts, "put me through to crew-chief-2")?.id, "crew-chief-2");
  assert.equal(resolveContact(contacts, "call tanker-driver-2 now")?.id, "tanker-driver-2");
  assert.equal(
    resolveContact(contacts, "hospital-lead-2 wants an update")?.id,
    "hospital-lead-2",
  );
  assert.equal(resolveContact(contacts, "traffic-patrol-2 reports jams")?.id, "traffic-patrol-2");
});

test("someone who is not in the catalog is still refused", () => {
  assert.equal(resolveContact(contacts, "the mayor of Madrid"), null);
  assert.equal(resolveContact(contacts, "   "), null);
});

/* ─── End to end: the warning reaches the phone ─────────────────────────── */

function elementAt(id: string, type: ElementView["type"]): ElementView {
  return {
    id,
    type,
    name: id,
    lat: 40.3,
    lng: -3.72,
    status: "critical",
    severity: 80,
    sensors: { grid_voltage: 8 },
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: new Date(0).toISOString(),
  };
}

function outputWith(recipients: readonly string[]): AgentOutput {
  return {
    evaluation: { discarded: [], actionable: [] },
    objective: "Cover the hospital before its deadline",
    steps: [],
    communications: recipients.map((recipient) => ({
      recipient,
      channel: "chat_message" as const,
      elementId: "hosp-01",
      message: `Message for ${recipient}`,
      reason: "They need to know now",
    })),
    decisions: [],
  };
}

function agentDispatching(output: AgentOutput): { calls: ContactRequest[]; run: () => Promise<void> } {
  const feed = createFeed();
  const world = createWorld(script, remedies, topology);
  const calls: ContactRequest[] = [];
  const happyrobot: HappyRobotClient = {
    mode: "simulated",
    contact: (request) => void calls.push(request),
  };
  const llm = {
    structured: async () => ({ data: output, text: "", gateway: "stub", model: "stub", latencyMs: 1 }),
  } as unknown as LlmClient;

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
    tick: 0,
    paused: false,
    started: true,
    simulationClock: new Date(0).toISOString(),
    lastSeq: 0,
    elements: [elementAt("hosp-01", "hospital")],
    resources: world.resources(),
  };

  return { calls, run: () => agent.observe(state, []) };
}

test("every warning the model addressed in prose still rings a phone", async () => {
  const written = AS_THE_MODEL_WROTE_THEM.map(([text]) => text);
  const { calls, run } = agentDispatching(outputWith(written));

  await run();

  // The 112 coordinator is among the written recipients and must NOT be called
  assert.equal(calls.length, written.length - 1, "every warning goes out but the emergency one");
  assert.deepEqual(calls.map((c) => c.contact.id).sort(), [
    "datacenter-operator",
    "hospital-lead",
    "ventilator-citizen",
  ]);
  assert.ok(!calls.some((c) => c.contact.emergencyService), "112 is never dialled");
});

test("an emergency service is never dialled, however the model addresses it", async () => {
  // Resolution is the easy half: whichever way the model names 112 — bare id,
  // prose, or the control room's own name — none of them may reach a phone
  const { calls, run } = agentDispatching(
    outputWith([
      "emergency-coordinator",
      "emergency-coordinator (Madrid 112)",
      "Madrid 112 control room",
    ]),
  );

  await run();

  assert.equal(calls.length, 0, "no variant of the 112 coordinator may reach the phone");
});

test("the same person and text twice is one call, however they were addressed", async () => {
  const { calls, run } = agentDispatching({
    ...outputWith([]),
    communications: ["hospital-lead", "Dr. Elena Duarte (hospital-lead)"].map((recipient) => ({
      recipient,
      channel: "chat_message" as const,
      elementId: "hosp-01",
      message: "Same warning, same person",
      reason: "duplicate",
    })),
  });

  await run();

  assert.equal(calls.length, 1, "deduplication must key on the resolved contact, not the prose");
});

test("an unknown recipient is still reported and nobody is called", async () => {
  const { calls, run } = agentDispatching(outputWith(["the mayor of Madrid"]));

  await run();

  assert.equal(calls.length, 0);
});
