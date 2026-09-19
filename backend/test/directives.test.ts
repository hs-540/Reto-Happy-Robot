import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  loadRemedies,
  loadTopology,
  type ElementView,
  type FeedDirective,
  type FeedDirectiveResponse,
  type FeedSystem,
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

/* ─── Doubles ────────────────────────────────────────────────────────── */

/**
 * What the stubbed model answers. A holder, not a constant: every test fills
 * it in, so the same harness drives acknowledges, rejections and silence.
 */
const MODEL_OUTPUT: { data: unknown } = {
  data: {
    evaluation: { discarded: [], actionable: ["operator directive received"] },
    objective: "Answer the operator",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [],
  },
};

/** Captures the prompt: the only way to prove what the directives injected */
function stubLlm(prompts: string[], fail = false, during?: () => void): LlmClient {
  return {
    structured: async (messages: ChatCompletionMessageParam[]) => {
      if (fail) throw new Error("the gateway is down");
      prompts.push(messages.map((m) => String(m.content)).join("\n"));
      during?.();
      return {
        text: "{}",
        data: MODEL_OUTPUT.data as never,
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
  // the contingency playbook escalates by contacting someone: harmless here
  contact: () => {},
};

/* ─── World under crisis ─────────────────────────────────────────────── */

function element(
  id: string,
  type: ElementView["type"],
  name: string,
  status: ElementView["status"],
  severity: number,
): ElementView {
  return {
    id,
    type,
    name,
    lat: 40.31,
    lng: -3.71,
    status,
    severity,
    sensors: { grid_voltage: 4 },
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

function agentWith(prompts: string[], failLlm = false, during?: () => void) {
  const feed = createFeed();
  const agent = createAgent({
    world: createWorld(script, remedies, topology),
    feed,
    llm: stubLlm(prompts, failLlm, during),
    actionRegistry: createActionRegistry(feed),
    happyrobot,
    history: [],
    rag: null,
    topology,
    remedies,
    seconds: () => 0,
  });
  return { agent, feed };
}

/* ─── Tests ──────────────────────────────────────────────────────────── */

test("a directive wakes the engine and reaches the prompt", async () => {
  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts);
  agent.queueDirective("priority_pin", "dc-01", "keep the datacenter alive at all costs");

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  const prompt = prompts[0] ?? "";
  assert.match(prompt, /OPERATOR DIRECTIVES/, "the prompt carries the operator channel");
  assert.match(prompt, /\[dir-001\] PIN on dc-01 .*— AWAITING YOUR ANSWER/);
  assert.match(prompt, /keep the datacenter alive at all costs/);
  assert.match(prompt, /PINNED BY THE OPERATOR/, "the pinned site is flagged in its own line");
  const kinds = feed.since(0).map((i) => i.kind);
  assert.ok(kinds.includes("directive"), "the directive is published in the feed");
});

test("a directive alone is reason enough to deliberate, no status change needed", async () => {
  const prompts: string[] = [];
  const { agent } = agentWith(prompts);
  agent.queueDirective("order", null, "do not call anyone for five minutes");

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "normal", 5)]), []);

  assert.equal(prompts.length, 1, "the directive wakes the engine on its own");
});

test("the agent's answer is recorded and published, orders are one-shot", async () => {
  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts);
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Follow the operator's order",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [
      {
        directiveId: "dir-001",
        decision: "acknowledged",
        reasoning: "El tanker va primero al hospital.",
      },
    ],
  };
  agent.queueDirective("order", null, "send the tanker to the hospital first");

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  assert.deepEqual(agent.view().directives, [], "an answered order leaves the standing list");
  const responses = feed
    .since(0)
    .filter((i): i is FeedDirectiveResponse => i.kind === "directive_response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.directiveId, "dir-001");
  assert.equal(responses[0]?.decision, "acknowledged");
  assert.match(responses[0]?.reasoning ?? "", /tanker/);

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);
  assert.equal(prompts.length, 1, "an answered order does not wake the engine again");
});

test("a rejected pin stays visible, overruled, until the operator withdraws it", async () => {
  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts);
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Hold the current priority",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [
      {
        directiveId: "dir-001",
        decision: "rejected",
        reasoning: "El hospital tiene 18% de batería y su límite es de 8 minutos.",
      },
    ],
  };
  agent.queueDirective("priority_pin", "junction-01", "clear the junction first");

  await agent.observe(crisis([element("hosp-01", "hospital", "Hospital", "critical", 88)]), []);

  const directives = agent.view().directives;
  assert.equal(directives.length, 1, "a rejected pin is not dropped");
  assert.equal(directives[0]?.status, "rejected");
  assert.match(directives[0]?.responseReasoning ?? "", /hospital/);
  const responses = feed
    .since(0)
    .filter((i): i is FeedDirectiveResponse => i.kind === "directive_response");
  assert.equal(responses[0]?.decision, "rejected");

  // the overruled pin stays listed, but marked rejected: the judgement was made
  MODEL_OUTPUT.data = { ...MODEL_OUTPUT.data, directiveResponses: [] };
  await agent.observe(
    crisis([element("hosp-01", "hospital", "Hospital", "degraded", 55)]),
    [],
  );
  const prompt = prompts[1] ?? "";
  assert.match(
    prompt,
    /\[dir-001\] PIN on junction-01 .*— rejected/,
    "a rejected pin is listed as overruled, not as pending",
  );
  assert.ok(
    !prompt.includes("— AWAITING YOUR ANSWER"),
    "nothing is left to answer",
  );

  agent.unpin("junction-01");
  assert.deepEqual(agent.view().directives, [], "the operator withdraws the overruled pin");
  const system = feed.since(0).filter((i): i is FeedSystem => i.kind === "system");
  assert.ok(
    system.some((i) => i.message.includes("withdrew the pin on junction-01")),
    "the withdrawal is published",
  );
});

test("a directive landed mid-deliberation waits for the next one instead of being swallowed", async () => {
  const prompts: string[] = [];
  const holder: { agent?: ReturnType<typeof createAgent> } = {};
  let fired = false;
  const { agent, feed } = agentWith(prompts, false, () => {
    // the operator types while the model is already thinking: the directive is
    // NOT in the prompt this call is answering
    if (fired) return;
    fired = true;
    holder.agent?.queueDirective("order", null, "queued while you were thinking");
  });
  holder.agent = agent;
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Triage",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [],
  };

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  const first = agent.view().directives;
  assert.equal(first.length, 1, "the order is not swallowed");
  assert.equal(first[0]?.status, "open", "a deliberation that never read it cannot answer it");
  assert.ok(
    !feed.since(0).some((i) => i.kind === "directive_response"),
    "no answer is published on the model's behalf",
  );

  // the next deliberation does read it and answers it
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Triage",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [
      { directiveId: "dir-001", decision: "acknowledged", reasoning: "Recibido." },
    ],
  };
  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  assert.match(prompts[1] ?? "", /queued while you were thinking/, "the order reaches the next prompt");
  assert.equal(agent.view().directives.length, 0, "once answered, the one-shot order leaves");
  assert.ok(feed.since(0).some((i) => i.kind === "directive_response" && i.directiveId === "dir-001"));
});

test("the contingency playbook never answers directives: they wait for the LLM", async () => {
  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts, true);
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Triage",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [],
  };
  agent.queueDirective("order", null, "hold the tanker for now");

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  const directives = agent.view().directives;
  assert.equal(directives.length, 1, "the order stays standing");
  assert.equal(directives[0]?.status, "open", "a playbook that never read it cannot answer it");
  assert.ok(
    !feed.since(0).some((i) => i.kind === "directive_response"),
    "no answer is published on the model's behalf",
  );
});

test("a silent model still answers the operator: fallback marks it acknowledged", async () => {  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts);
  MODEL_OUTPUT.data = {
    evaluation: { discarded: [], actionable: [] },
    objective: "Triage",
    steps: [],
    communications: [],
    decisions: [],
    directiveResponses: [],
  };
  agent.queueDirective("priority_pin", "dc-01", "watch the datacenter");

  await agent.observe(crisis([element("dc-01", "datacenter", "Datacenter", "degraded", 55)]), []);

  const directives = agent.view().directives;
  assert.equal(directives[0]?.status, "acknowledged", "no directive is left open forever");
  assert.ok(directives[0]?.responseReasoning, "the fallback states its reason");
  const system = feed.since(0).filter((i): i is FeedSystem => i.kind === "system");
  assert.ok(
    system.some((i) => i.message.includes("No explicit answer to directive dir-001")),
    "the silence is published, not hidden",
  );
});

test("re-pinning a site replaces its standing pin instead of stacking a second one", async () => {
  const prompts: string[] = [];
  const { agent } = agentWith(prompts);
  agent.queueDirective("priority_pin", "dc-01", "watch it");
  agent.queueDirective("priority_pin", "dc-01", "watch it closer");

  const directives = agent.view().directives;
  assert.equal(directives.length, 1);
  assert.equal(directives[0]?.id, "dir-002", "the newest pin stands");
  assert.equal(directives[0]?.text, "watch it closer");
});

test("unpinning before any deliberation removes the pin without a trace of doubt", async () => {
  const prompts: string[] = [];
  const { agent, feed } = agentWith(prompts);
  agent.queueDirective("priority_pin", "dc-01", "watch the datacenter");
  agent.unpin("dc-01");

  assert.deepEqual(agent.view().directives, []);
  const published = feed.since(0).filter((i): i is FeedDirective => i.kind === "directive");
  assert.equal(published.length, 1, "the pin was published, the withdrawal too");
  const system = feed.since(0).filter((i): i is FeedSystem => i.kind === "system");
  assert.ok(system.some((i) => i.message.includes("withdrew the pin on dc-01")));
});
