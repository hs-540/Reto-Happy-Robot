import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { CallClosure, Contact } from "@swarmup/shared";
import { createHappyRobotClient, type ContactRequest } from "../src/happyrobot.js";

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
    assert.deepEqual(JSON.parse(String(init?.body)), {
      prompt: "hospital 4 min from its limit Leave the splice and head to the hospital",
      missionId: "act-001",
    });
    assert.deepEqual(dispatches, ["act-001"]);
  } finally {
    fetchMock.mock.restore();
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
