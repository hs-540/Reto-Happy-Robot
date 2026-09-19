import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeedItem } from "@swarmup/shared";
import { createFeed, type Feed } from "../src/feed.js";
import { loadScript, type Script } from "../src/script.js";
import { createWorld } from "../src/world.js";
import { createSimulation, TICK_SECONDS, type IncidentClosure } from "../src/sim.js";

const scriptPath = fileURLToPath(new URL("../../data/scripts/madrid-blackout.json", import.meta.url));
const START_MS = Date.parse("2026-09-19T10:00:00.000Z");
const DURATION = 300;

function isoClock(sec: number): string {
  return new Date(START_MS + sec * 1000).toISOString();
}

type ExpectedAlarm = {
  kind: "alarm";
  elementId: string;
  metric: string;
  value: number;
  severity: number;
};
type ExpectedSystem = { kind: "system"; message: string };

function expectedItems(script: Script): (ExpectedAlarm | ExpectedSystem)[] {
  return [...script.timeline]
    .sort((a, b) => a.atSeconds - b.atSeconds)
    .flatMap((ev) => {
      if (ev.kind === "narrative") {
        return ev.note === undefined ? [] : [{ kind: "system" as const, message: ev.note }];
      }
      const items: (ExpectedAlarm | ExpectedSystem)[] = [
        {
          kind: "alarm" as const,
          elementId: ev.payload.elementId,
          metric: ev.payload.metric,
          value: ev.payload.value,
          severity: ev.payload.severity,
        },
      ];
      if (ev.note !== undefined) items.push({ kind: "system" as const, message: ev.note });
      return items;
    });
}

/** feed without the log stamp (seq/ts): the content is the reproducible part */
function content(items: FeedItem[]): (ExpectedAlarm | ExpectedSystem)[] {
  return items.map((i) =>
    i.kind === "alarm"
      ? {
          kind: i.kind,
          elementId: i.elementId,
          metric: i.metric,
          value: i.value,
          severity: i.severity,
        }
      : { kind: i.kind, message: i.message },
  );
}

function freshSim(): { sim: ReturnType<typeof createSimulation>; feed: Feed } {
  const feed = createFeed();
  const script = loadScript(scriptPath);
  const sim = createSimulation(script, START_MS, feed, createWorld(script));
  return { sim, feed };
}

function runThrough(sim: ReturnType<typeof createSimulation>, until: number = DURATION): void {
  for (let sec = TICK_SECONDS; sec <= until; sec += TICK_SECONDS) {
    sim.advance(START_MS + sec * 1000);
  }
}

test("without starting, the simulation does not advance nor emit feed", () => {
  const { sim, feed } = freshSim();
  sim.advance(START_MS + 60_000);
  sim.advance(START_MS + 120_000);
  const state = sim.state();
  assert.equal(state.started, false);
  assert.equal(state.tick, 0);
  assert.equal(state.simulationClock, isoClock(0));
  assert.deepEqual(feed.since(0), []);
  assert.equal(feed.lastSeq(), 0);
});

test("the 300s script generates the full timeline in order", () => {
  const script = loadScript(scriptPath);
  const { sim, feed } = freshSim();
  sim.start(START_MS);
  runThrough(sim);

  const items = feed.since(0);
  assert.deepEqual(content(items), expectedItems(script));
  items.forEach((item, i) => assert.equal(item.seq, i + 1, `seq of item ${i}`));
  assert.equal(sim.state().lastSeq, items.length);
});

test("the 5 key moments happen in order and at their exact second", () => {
  const script = loadScript(scriptPath);
  const moments = script.timeline
    .filter((e) => e.note !== undefined)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  assert.equal(moments.length, 5);

  const { sim, feed } = freshSim();
  sim.start(START_MS);

  let published = 0;
  for (const moment of moments) {
    sim.advance(START_MS + moment.atSeconds * 1000);
    const fresh = feed.since(published);
    published = feed.lastSeq();
    assert.ok(fresh.length > 0, `the moment t=${moment.atSeconds}s published nothing`);

    if (moment.kind === "sensor_event") {
      const alarm = fresh.find(
        (i) =>
          i.kind === "alarm" &&
          i.elementId === moment.payload.elementId &&
          i.value === moment.payload.value,
      );
      assert.ok(alarm, `missing the alarm of moment t=${moment.atSeconds}s`);
      // exact second according to the simulated clock
      const element = sim.state().elements.find((e) => e.id === moment.payload.elementId);
      assert.equal(element?.updatedAt, isoClock(moment.atSeconds));
    }

    const last = fresh[fresh.length - 1];
    if (last.kind !== "system") assert.fail("the moment's note must come out as system");
    assert.equal(last.message, moment.note);
  }

  // moment 5: the substation has been 60s stable with restored voltage → incident closed
  sim.advance(START_MS + DURATION * 1000);
  const sub = sim.state().elements.find((e) => e.id === "sub-01");
  assert.equal(sub?.status, "resolved");
});

test("reset leaves the reproducible initial state and an identical repetition", () => {
  const { sim, feed } = freshSim();
  sim.start(START_MS);
  runThrough(sim);
  const finalState = sim.state();
  const finalFeed = content(feed.since(0));
  const finalSeq = feed.lastSeq();
  assert.ok(finalFeed.length > 0);

  sim.reset();
  // the cursor never goes back: the frontend accumulator never sees reused seqs
  assert.equal(feed.lastSeq(), finalSeq);
  assert.deepEqual(feed.since(0), []);
  // the world is left exactly like a freshly created one (except the feed cursor)
  const resetState = sim.state();
  const fresh = freshSim();
  assert.deepEqual(resetState, { ...fresh.sim.state(), lastSeq: resetState.lastSeq });

  sim.start(START_MS);
  runThrough(sim);
  assert.deepEqual(content(feed.since(finalSeq)), finalFeed);
  assert.deepEqual(sim.state(), { ...finalState, lastSeq: feed.lastSeq() });
});

test("when an incident is resolved a single closure is delivered per element", () => {
  const closures: IncidentClosure[] = [];
  const feed = createFeed();
  const script = loadScript(scriptPath);
  const sim = createSimulation(
    script,
    START_MS,
    feed,
    createWorld(script),
    (closure) => closures.push(closure),
  );
  sim.start(START_MS);
  runThrough(sim);

  // moment 5: only the substation reaches `resolved` within the script (stable since t=240)
  assert.deepEqual(closures.map((c) => c.elementId), ["sub-01"]);
  assert.equal(closures[0].type, "substation");
  assert.equal(closures[0].maxSeverity, 90);

  // the datacenter closes once it reaches its own stability; the substation is not repeated
  sim.advance(START_MS + 325 * 1000);
  assert.deepEqual(closures.map((c) => c.elementId), ["sub-01", "dc-01"]);
});

test("inject applies an immediate sensor event and emits it in the feed", () => {
  const { sim, feed } = freshSim();
  sim.start(START_MS);
  sim.advance(START_MS + 10_000);
  const seqBefore = feed.lastSeq();

  sim.inject({ elementId: "dc-01", metric: "temperature", value: 55, severity: 80 });

  const dc = sim.state().elements.find((e) => e.id === "dc-01");
  assert.equal(dc?.sensors.temperature, 55);
  assert.equal(dc?.severity, 80);
  assert.equal(dc?.status, "critical");
  assert.equal(dc?.updatedAt, isoClock(10));

  const fresh = feed.since(seqBefore);
  assert.equal(fresh.length, 1);
  const item = fresh[0];
  if (item.kind !== "alarm") assert.fail("the injection must emit an alarm");
  assert.equal(item.elementId, "dc-01");
  assert.equal(item.metric, "temperature");
  assert.equal(item.value, 55);
  assert.equal(item.severity, 80);

  assert.throws(
    () => sim.inject({ elementId: "does-not-exist", metric: "temperature", value: 1, severity: 1 }),
    /unknown/,
  );
});
