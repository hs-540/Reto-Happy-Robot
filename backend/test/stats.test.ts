import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunStats } from "../src/stats.js";

test("llm stats track latency min/mean/max and sum token usage", () => {
  const stats = createRunStats();
  stats.recordLlmCall(100, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  stats.recordLlmCall(300, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  stats.recordLlmCall(200, null);
  const snapshot = stats.snapshot();
  assert.equal(snapshot.llm.calls, 3);
  assert.equal(snapshot.llm.minLatencyMs, 100);
  assert.equal(snapshot.llm.maxLatencyMs, 300);
  assert.equal(snapshot.llm.meanLatencyMs, 200);
  assert.equal(snapshot.llm.promptTokens, 11);
  assert.equal(snapshot.llm.completionTokens, 22);
  assert.equal(snapshot.llm.totalTokens, 33);
});

test("empty stats report null aggregates instead of fake zeros", () => {
  const snapshot = createRunStats().snapshot();
  assert.equal(snapshot.llm.calls, 0);
  assert.equal(snapshot.llm.minLatencyMs, null);
  assert.equal(snapshot.llm.maxLatencyMs, null);
  assert.equal(snapshot.llm.meanLatencyMs, null);
  assert.equal(snapshot.llm.totalTokens, 0);
  assert.equal(snapshot.reactions, 0);
  assert.equal(snapshot.meanReactionMs, null);
});

test("reaction mean averages every trigger-to-decision interval and reset clears the run", () => {
  const stats = createRunStats();
  stats.recordReaction(1000);
  stats.recordReaction(3000);
  assert.equal(stats.snapshot().meanReactionMs, 2000);
  stats.reset();
  const snapshot = stats.snapshot();
  assert.equal(snapshot.llm.calls, 0);
  assert.equal(snapshot.reactions, 0);
  assert.equal(snapshot.meanReactionMs, null);
});
