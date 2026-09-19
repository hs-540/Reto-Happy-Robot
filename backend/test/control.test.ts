import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionRegistry, controlSchema } from "../src/control.js";
import { createFeed } from "../src/feed.js";

function setup() {
  const feed = createFeed();
  const registry = createActionRegistry(feed);
  const propose = (status: "queued" | "executed") =>
    registry.record(
      {
        type: status === "queued" ? "voice_call" : "chat_message",
        targetElementId: "hosp-01",
        recipient: "hospital_manager",
        message: "We will cut power for 10 min to connect the generator.",
      },
      status,
    );
  return { feed, registry, propose };
}

function actionStatuses(feed: ReturnType<typeof createFeed>): string[] {
  return feed
    .since(0)
    .filter((i) => i.kind === "action")
    .map((i) => (i.kind === "action" ? i.status : ""));
}

test("actions are recorded with the born status the caller states, no human gate", () => {
  const { feed, propose } = setup();

  const queuedCall = propose("queued");
  assert.equal(queuedCall.status, "queued");
  assert.ok(queuedCall.id.startsWith("act-"));
  const message = propose("executed");
  assert.equal(message.status, "executed");
  assert.deepEqual(actionStatuses(feed), ["queued", "executed"]);
});

test("controlSchema validates the control actions and the inject payload", () => {
  assert.ok(controlSchema.safeParse({ action: "start" }).success);
  assert.ok(controlSchema.safeParse({ action: "reset" }).success);
  assert.ok(controlSchema.safeParse({ action: "pause" }).success);
  assert.ok(controlSchema.safeParse({ action: "resume" }).success);
  assert.ok(!controlSchema.safeParse({ action: "confirm", id: "act-007" }).success);
  assert.ok(!controlSchema.safeParse({ action: "run" }).success);

  const injection = {
    action: "inject",
    payload: { elementId: "dc-01", metric: "temperature", value: 55, severity: 80 },
  };
  assert.ok(controlSchema.safeParse(injection).success);
  assert.ok(
    !controlSchema.safeParse({ ...injection, payload: { ...injection.payload, metric: "pressure" } })
      .success,
  );
  assert.ok(
    !controlSchema.safeParse({ ...injection, payload: { ...injection.payload, severity: 101 } })
      .success,
  );
  assert.ok(!controlSchema.safeParse({ action: "inject" }).success);
});

test("controlSchema validates the operator directives", () => {
  assert.ok(
    controlSchema.safeParse({
      action: "prioritize",
      payload: { elementId: "dc-01", note: "keep it alive" },
    }).success,
  );
  assert.ok(
    controlSchema.safeParse({ action: "prioritize", payload: { elementId: "dc-01" } }).success,
    "the note is optional",
  );
  assert.ok(!controlSchema.safeParse({ action: "prioritize" }).success);
  assert.ok(
    !controlSchema.safeParse({
      action: "prioritize",
      payload: { elementId: "dc-01", note: "x".repeat(281) },
    }).success,
  );

  assert.ok(controlSchema.safeParse({ action: "unprioritize", payload: { elementId: "dc-01" } }).success);
  assert.ok(!controlSchema.safeParse({ action: "unprioritize" }).success);

  assert.ok(controlSchema.safeParse({ action: "order", payload: { text: "hold the tanker" } }).success);
  assert.ok(!controlSchema.safeParse({ action: "order", payload: { text: "" } }).success);
  assert.ok(
    !controlSchema.safeParse({ action: "order", payload: { text: "x".repeat(501) } }).success,
  );
  assert.ok(!controlSchema.safeParse({ action: "order" }).success);
});
