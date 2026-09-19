import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { CallClosure, Contact } from "@swarmup/shared";
import { buildPrompt, createHappyRobotClient, type ContactRequest } from "../src/happyrobot.js";

const chief: Contact = {
  id: "crew-chief",
  name: "Ángel Rivas",
  role: "Electrical crew chief",
  resourceId: "crew-1",
};

const HOOK_URL = "https://workflows.example/hooks/dev/abc123";

function simulatedClient(onClosed: (c: CallClosure) => void) {
  return createHappyRobotClient({ onClosed });
}

function realRequest(overrides: Partial<ContactRequest> = {}): ContactRequest {
  return {
    actionId: "act-001",
    contact: chief,
    channel: "voice_call",
    priority: 10,
    message: "Leave the splice and head to the hospital",
    context: { elementId: "sub-01", situation: "hospital 4 min from its limit" },
    ...overrides,
  };
}

test("with no hook configured it simulates, and the chain stays whole", () => {
  assert.equal(simulatedClient(() => {}).mode, "simulated");
});

test("the crew chief refuses the first time and reports his delay", async () => {
  const closures: CallClosure[] = [];
  const client = simulatedClient((c) => closures.push(c));

  client.contact({
    actionId: "act-001",
    contact: chief,
    channel: "voice_call",
    priority: 10,
    message: "Leave the splice and head to the hospital",
    context: { elementId: "sub-01", situation: "hospital 4 min from its limit" },
  });

  await new Promise((r) => setTimeout(r, 9_000));
  assert.equal(closures.length, 1);
  assert.equal(closures[0].outcome, "refused");
  assert.equal(closures[0].delayMinutes, 22, "a refusal must carry its cost in minutes");
  assert.match(closures[0].summary, /22 minutes/);
});

test("when pressed, he accepts with a smaller delay", async () => {
  const closures: CallClosure[] = [];
  const client = simulatedClient((c) => closures.push(c));
  const request = {
    contact: chief,
    channel: "voice_call" as const,
    priority: 10,
    message: "I insist: the hospital cannot hold",
    context: { elementId: "sub-01", situation: "second attempt" },
  };

  client.contact({ actionId: "act-001", ...request });
  client.contact({ actionId: "act-002", ...request });

  await new Promise((r) => setTimeout(r, 9_000));
  assert.deepEqual(
    closures.map((c) => c.outcome),
    ["refused", "accepted_with_delay"],
  );
  assert.equal(closures[1].delayMinutes, 8);
});

test("the real client dispatches exactly prompt and missionId to the hook", async () => {
  const dispatches: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
  );
  try {
    const client = createHappyRobotClient({
      webhookUrl: HOOK_URL,
      onClosed: () => {},
      onDispatched: (missionId) => dispatches.push(missionId),
    });

    client.contact(realRequest());
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(String(url), HOOK_URL, "the hook URL goes out verbatim");
    assert.equal(init?.method, "POST");
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.missionId, "act-001");
    assert.equal(sent.prompt, buildPrompt(realRequest()));
    assert.deepEqual(dispatches, ["act-001"]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("the brief carries recipient, mission, situation, message and the ask", () => {
  const prompt = buildPrompt(realRequest());

  // A bare fragment is what left a run with no transcript at all; each of these
  // is a piece the voice agent needs to place the call and come back with something
  assert.match(prompt, /Ángel Rivas, Electrical crew chief/, "who is on the other side");
  assert.match(prompt, /Mission act-001\./, "the mission id closes the loop with the summary event");
  assert.match(prompt, /hospital 4 min from its limit/, "why the call is happening");
  assert.match(prompt, /sub-01/, "the site it is about");
  assert.match(prompt, /"Leave the splice and head to the hospital"/, "the message, verbatim");
  assert.match(prompt, /commitment in minutes/, "what the agent must come back with");
});

test("a brief with no situation drops the clause instead of leaving it dangling", () => {
  const prompt = buildPrompt(realRequest({ context: { elementId: "sub-01", situation: "" } }));

  assert.doesNotMatch(prompt, /Situation:/);
  assert.match(prompt, /Affected site: sub-01\./);
});

test("a guarded hook gets its key as x-api-key, an unguarded one gets no header", async () => {
  for (const [apiKey, expected] of [
    ["hook-secret", "hook-secret"],
    ["", undefined],
    [undefined, undefined],
  ] as const) {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    try {
      const client = createHappyRobotClient({ webhookUrl: HOOK_URL, apiKey, onClosed: () => {} });

      client.contact(realRequest());
      await new Promise((r) => setTimeout(r, 10));

      const [, init] = fetchMock.mock.calls[0].arguments;
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(
        headers?.["x-api-key"],
        expected,
        "an empty key must not travel: a guarded hook would reject it and an unguarded one needs none",
      );
      assert.equal(headers?.["Content-Type"], "application/json");
    } finally {
      fetchMock.mock.restore();
    }
  }
});

test("a hook rejection or a transport failure closes the call as no_answer", async () => {
  for (const failure of [
    async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 500 }),
    async (_url: string | URL, _init?: RequestInit) => {
      throw new Error("connection refused");
    },
  ]) {
    const closures: CallClosure[] = [];
    const dispatches: string[] = [];
    const fetchMock = mock.method(globalThis, "fetch", failure);
    try {
      const client = createHappyRobotClient({
        webhookUrl: HOOK_URL,
        onClosed: (c) => closures.push(c),
        onDispatched: (missionId) => dispatches.push(missionId),
      });

      client.contact(realRequest());
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(closures.length, 1);
      assert.equal(closures[0].actionId, "act-001");
      assert.equal(closures[0].outcome, "no_answer");
      assert.deepEqual(dispatches, [], "a failed mission must not count as dispatched");
    } finally {
      fetchMock.mock.restore();
    }
  }
});
