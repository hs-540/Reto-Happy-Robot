import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { z } from "zod";
import type { CallClosure } from "@swarmup/shared";
import type { LlmClient } from "../src/llm.js";
import { createOutcomePoller, type OutcomePollerOptions } from "../src/outcome-poll.js";

const API = "https://events.example";

let eventSeq = 0;

function callSummary(overrides: Record<string, unknown> = {}) {
  eventSeq += 1;
  const now = new Date().toISOString();
  return {
    id: `ev-${String(eventSeq).padStart(3, "0")}`,
    summary: "The supplier offers four units, ready in 30 minutes.",
    missionId: "act-001",
    context: "the prompt the call was launched with",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function verdict(data: {
  outcome: "accepted" | "refused" | "accepted_with_delay" | "no_answer";
  delayMinutes: number | null;
  commitment: string | null;
}): LlmClient {
  return {
    /** Runs the canned verdict through the real schema: the stub cannot drift */
    structured: async <T>(_messages: unknown, schema: z.ZodType<T>, _name: string) => ({
      text: "",
      gateway: "test",
      model: "test-model",
      latencyMs: 0,
      data: schema.parse(data),
    }),
    embeddings: async () => [],
  };
}

function harness(overrides: Partial<OutcomePollerOptions> = {}) {
  const closures: CallClosure[] = [];
  const urls: string[] = [];
  const state = { status: 200, events: [] as unknown[] };
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, _init?: RequestInit) => {
      urls.push(String(url));
      if (state.status !== 200) return new Response(null, { status: state.status });
      return new Response(JSON.stringify({ count: state.events.length, events: state.events }), {
        status: 200,
      });
    },
  );
  const tracked = new Set(["act-001", "act-002"]);
  const poller = createOutcomePoller({
    url: API,
    apiKey: "secret-key",
    pollMs: 10_000,
    llm: verdict({ outcome: "accepted_with_delay", delayMinutes: 30, commitment: "Ready in 30 minutes" }),
    isTrackedMission: (missionId) => tracked.has(missionId),
    onClosed: (closure) => closures.push(closure),
    ...overrides,
  });
  return {
    poller,
    closures,
    urls,
    state,
    restore: () => fetchMock.mock.restore(),
  };
}

test("only summaries of missions this process dispatched close a call", async () => {
  const h = harness();
  try {
    h.state.events = [
      callSummary(),
      callSummary({ id: "ev-x", missionId: "act-999", summary: "somebody else's call" }),
      callSummary({ id: "ev-y", missionId: null }),
    ];
    await h.poller.poll();

    assert.equal(h.closures.length, 1);
    assert.deepEqual(h.closures[0], {
      actionId: "act-001",
      outcome: "accepted_with_delay",
      delayMinutes: 30,
      commitment: "Ready in 30 minutes",
      summary: "The supplier offers four units, ready in 30 minutes.",
    });
    assert.match(h.urls[0], new RegExp(`^${API}/api/get-events\\?since=`));
    assert.match(h.urls[0], /limit=50$/);
  } finally {
    h.restore();
  }
});

test("an event is closed exactly once, even when the window re-reads it", async () => {
  const h = harness();
  try {
    h.state.events = [callSummary()];
    // The cursor starts at poller creation and has millisecond precision:
    // without a gap the first poll still reads the creation instant and there
    // is nothing to observe advancing
    await new Promise((r) => setTimeout(r, 5));
    await h.poller.poll();
    await h.poller.poll();

    assert.equal(h.closures.length, 1);
    const first = new URL(h.urls[0]).searchParams.get("since");
    const second = new URL(h.urls[1]).searchParams.get("since");
    assert.notEqual(first, second, "the cursor advanced after a good response");
  } finally {
    h.restore();
  }
});

test("a refused verdict carries its cost in minutes", async () => {
  const h = harness({
    llm: verdict({ outcome: "refused", delayMinutes: 22, commitment: "Finishes the splice first" }),
  });
  try {
    h.state.events = [callSummary()];
    await h.poller.poll();

    assert.equal(h.closures[0].outcome, "refused");
    assert.equal(h.closures[0].delayMinutes, 22);
    assert.equal(h.closures[0].commitment, "Finishes the splice first");
  } finally {
    h.restore();
  }
});

test("a classification failure falls back to accepted and keeps the summary", async () => {
  const failing: LlmClient = {
    structured: async () => {
      throw new Error("gateway down");
    },
    embeddings: async () => [],
  };
  const h = harness({ llm: failing });
  try {
    h.state.events = [callSummary()];
    await h.poller.poll();

    assert.equal(h.closures.length, 1);
    assert.equal(h.closures[0].outcome, "accepted");
    assert.equal(h.closures[0].delayMinutes, null);
    assert.equal(h.closures[0].summary, "The supplier offers four units, ready in 30 minutes.");
  } finally {
    h.restore();
  }
});

test("a failed poll does not throw and retries the same window", async () => {
  const h = harness();
  try {
    h.state.status = 500;
    await h.poller.poll();
    assert.equal(h.closures.length, 0, "the failure stays contained");

    h.state.status = 200;
    h.state.events = [callSummary()];
    await h.poller.poll();
    assert.equal(h.closures.length, 1, "the same window is retried after the failure");
    assert.equal(new URL(h.urls[0]).searchParams.get("since"), new URL(h.urls[1]).searchParams.get("since"));
  } finally {
    h.restore();
  }
});
