import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { CallClosure, FeedAction, FeedItem } from "@swarmup/shared";
import { createCallQueue, type CallQueueOptions } from "../src/call-queue.js";
import { createFeed } from "../src/feed.js";
import type { ContactRequest, HappyRobotClient } from "../src/happyrobot.js";

function request(actionId: string, priority: number): ContactRequest {
  return {
    actionId,
    contact: { id: `person-${actionId}`, name: `Contact ${actionId}`, role: "Site manager" },
    channel: "voice_call",
    priority,
    message: `Mobilise now (${actionId})`,
    context: { elementId: `site-${actionId}`, situation: "test" },
  };
}

function closureFor(actionId: string, outcome: CallClosure["outcome"] = "accepted"): CallClosure {
  return { actionId, outcome, delayMinutes: null, commitment: null, summary: "done" };
}

/* Controlled clock for the whole file, one singleton per process: mock timers
   are not real handles, so the 120 s backstop armed by every dial never keeps
   the test process alive, and it only advances where a test ticks it. */
mock.timers.enable({ apis: ["setTimeout"] });

function harness(overrides: Partial<CallQueueOptions> = {}) {
  const feed = createFeed();
  const dialled: ContactRequest[] = [];
  const closures: CallClosure[] = [];
  const client: HappyRobotClient = {
    mode: "real",
    contact(req) {
      dialled.push(req);
    },
  };
  const queue = createCallQueue(client, {
    feed,
    maxInFlight: 1,
    maxQueued: 3,
    slotTimeoutMs: 120_000,
    onClosed: (closure) => closures.push(closure),
    isStillRelevant: () => true,
    ...overrides,
  });
  return { queue, feed, dialled, closures };
}

function systemMessages(feed: ReturnType<typeof createFeed>): string[] {
  return feed
    .since(0)
    .filter((i): i is Extract<FeedItem, { kind: "system" }> => i.kind === "system")
    .map((i) => i.message);
}

function discardedActionIds(feed: ReturnType<typeof createFeed>): string[] {
  return feed
    .since(0)
    .filter((i): i is FeedAction => i.kind === "action" && i.status === "discarded")
    .map((i) => i.actionId);
}

test("capacity 1: the second call waits and dials when the first closes", () => {
  const h = harness();
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 5));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001"]);

  h.queue.onClosed(closureFor("act-001"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-002"]);
  assert.deepEqual(h.closures.map((c) => c.actionId), ["act-001"]);
});

test("a closure for an unknown or released actionId is forwarded but not accounted", () => {
  const h = harness();
  h.queue.contact(request("act-001", 10));

  h.queue.onClosed(closureFor("act-999"));
  assert.deepEqual(h.closures.map((c) => c.actionId), ["act-999"]);
  // the unknown closure held no slot: the line is still busy with act-001
  h.queue.contact(request("act-002", 5));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001"]);

  h.queue.onClosed(closureFor("act-001"));
  h.queue.onClosed(closureFor("act-001"));
  assert.equal(h.closures.length, 3);
  h.queue.contact(request("act-003", 5));
  // the freed slot went to the queued act-002; act-003 waits behind it
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-002"]);
});

test("chat_message passes straight through even with every voice slot taken", () => {
  const h = harness();
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 5));
  h.queue.contact({ ...request("act-003", 1), channel: "chat_message" });
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-003"]);

  // the chat consumed no line: the slot went to the queued voice call
  h.queue.onClosed(closureFor("act-001"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-003", "act-002"]);
});

test("a full queue evicts its least urgent call for a more urgent one and drops a less urgent one", () => {
  const h = harness({ maxQueued: 2 });
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 5));
  h.queue.contact(request("act-003", 3));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001"]);

  h.queue.contact(request("act-004", 8));
  const systems = systemMessages(h.feed);
  assert.equal(systems.length, 1);
  assert.match(systems[0], /Contact act-003/);
  assert.match(systems[0], /Contact act-004/);
  assert.deepEqual(discardedActionIds(h.feed), ["act-003"]);

  h.queue.contact(request("act-005", 1));
  assert.match(systemMessages(h.feed)[1], /Contact act-005/);

  // never more than maxQueued pending: exactly the two survivors dial, urgency first
  h.queue.onClosed(closureFor("act-001"));
  h.queue.onClosed(closureFor("act-004"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-004", "act-002"]);
  assert.deepEqual(h.closures.map((c) => c.actionId), ["act-001", "act-004"]);
});

test("dequeue follows urgency, then arrival order", () => {
  const h = harness({ maxQueued: 4 });
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 4));
  h.queue.contact(request("act-003", 8));
  h.queue.contact(request("act-004", 4));
  h.queue.contact(request("act-005", 6));

  h.queue.onClosed(closureFor("act-001"));
  h.queue.onClosed(closureFor("act-003"));
  h.queue.onClosed(closureFor("act-005"));
  h.queue.onClosed(closureFor("act-002"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), [
    "act-001",
    "act-003",
    "act-005",
    "act-002",
    "act-004",
  ]);
});

test("the slot timeout releases the slot and emits a no_answer closure", () => {
  const h = harness({ slotTimeoutMs: 120_000 });
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 5));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001"]);

  mock.timers.tick(120_000);
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-002"]);
  assert.deepEqual(h.closures.map((c) => c.actionId), ["act-001"]);
  assert.equal(h.closures[0].outcome, "no_answer");
});

test("a call whose element resolved while queued is discarded at dequeue and the slot passes on", () => {
  const resolved = new Set<string>(["site-act-002"]);
  const h = harness({ isStillRelevant: (r) => !resolved.has(r.context.elementId) });
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 5));
  h.queue.contact(request("act-003", 3));

  h.queue.onClosed(closureFor("act-001"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-003"]);
  assert.deepEqual(discardedActionIds(h.feed), ["act-002"]);
  const systems = systemMessages(h.feed);
  assert.equal(systems.length, 1);
  assert.match(systems[0], /Contact act-002/);
});

test("capacity 3: three calls go out at once and the fourth waits", () => {
  const h = harness({ maxInFlight: 3 });
  h.queue.contact(request("act-001", 10));
  h.queue.contact(request("act-002", 9));
  h.queue.contact(request("act-003", 8));
  h.queue.contact(request("act-004", 7));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-002", "act-003"]);

  h.queue.onClosed(closureFor("act-002"));
  assert.deepEqual(h.dialled.map((r) => r.actionId), ["act-001", "act-002", "act-003", "act-004"]);
});
