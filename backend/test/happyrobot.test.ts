import assert from "node:assert/strict";
import test from "node:test";
import type { CallClosure, Contact } from "@swarmup/shared";
import { credentialUsable, createHappyRobotClient } from "../src/happyrobot.js";

const chief: Contact = {
  id: "crew-chief",
  name: "Ángel Rivas",
  role: "Electrical crew chief",
  resourceId: "crew-1",
};

function simulatedClient(onClosed: (c: CallClosure) => void) {
  return createHappyRobotClient({ apiKey: "PENDIENTE", baseUrl: "https://x.test", onClosed });
}

test("a placeholder credential does not count as usable", () => {
  assert.equal(credentialUsable("PENDIENTE"), false);
  assert.equal(credentialUsable("  "), false);
  assert.equal(credentialUsable("hr_real_key"), true);
});

test("with no credential it simulates, and the chain stays whole", () => {
  assert.equal(simulatedClient(() => {}).mode, "simulated");
});

test("the crew chief refuses the first time and reports his delay", async () => {
  const closures: CallClosure[] = [];
  const client = simulatedClient((c) => closures.push(c));

  client.contact({
    actionId: "act-001",
    contact: chief,
    channel: "voice_call",
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
