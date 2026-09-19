import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadRoads, loadTopology, type FeedItem } from "@swarmup/shared";
import { createFeed, type Feed } from "../src/feed.js";
import { loadScript, type Script } from "../src/script.js";
import { createWorld } from "../src/world.js";
import {
  TIME_SCALE,
  createSimulation,
  TICK_SECONDS,
  type IncidentClosure,
} from "../src/sim.js";

const scriptPath = fileURLToPath(new URL("../../data/scripts/madrid-blackout.json", import.meta.url));
const demoRemedies = loadRemedies(
  fileURLToPath(new URL("../../data/remedies.json", import.meta.url)),
);
const demoTopology = loadTopology(
  fileURLToPath(new URL("../../data/topology.json", import.meta.url)),
);
const demoRoads = loadRoads(fileURLToPath(new URL("../../data/roads.json", import.meta.url)));
const START_MS = Date.parse("2026-09-19T10:00:00.000Z");
/** REAL seconds the demo lasts: the script runs in crisis seconds and the
 *  simulation advances at TIME_SCALE, so walking it costs 1/scale. */
const DURATION = Math.ceil(loadScript(scriptPath).durationSeconds / TIME_SCALE);

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
type ExpectedReport = { kind: "report"; source: string; text: string; elementId: string | null };
type ExpectedItem = ExpectedAlarm | ExpectedSystem | ExpectedReport;

function expectedItems(script: Script): ExpectedItem[] {
  return [...script.timeline]
    .sort((a, b) => a.atSeconds - b.atSeconds)
    .flatMap((ev) => {
      if (ev.kind === "narrative") {
        return ev.note === undefined ? [] : [{ kind: "system" as const, message: ev.note }];
      }
      if (ev.kind === "report") {
        return [
          {
            kind: "report" as const,
            source: ev.payload.source,
            text: ev.payload.text,
            elementId: ev.payload.elementId,
          },
        ];
      }
      const items: ExpectedItem[] = [
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
function content(items: FeedItem[]): ExpectedItem[] {
  return items.map((i) => {
    if (i.kind === "alarm") {
      return {
        kind: i.kind,
        elementId: i.elementId,
        metric: i.metric,
        value: i.value,
        severity: i.severity,
      };
    }
    if (i.kind === "report") {
      return { kind: i.kind, source: i.source, text: i.text, elementId: i.elementId };
    }
    return { kind: i.kind as "system", message: "message" in i ? i.message : "" };
  });
}

function freshSim(): { sim: ReturnType<typeof createSimulation>; feed: Feed } {
  const feed = createFeed();
  const script = loadScript(scriptPath);
  const sim = createSimulation(script, START_MS, feed, createWorld(script, demoRemedies, demoTopology, demoRoads));
  return { sim, feed };
}

function runThrough(sim: ReturnType<typeof createSimulation>, until: number = DURATION): void {
  for (let sec = TICK_SECONDS; sec <= until; sec += TICK_SECONDS) {
    sim.advance(START_MS + sec * 1000);
  }
}

test("finished only turns true once the script has fully played out", () => {
  const { sim } = freshSim();
  assert.equal(sim.finished, false);
  sim.start(START_MS);
  sim.advance(START_MS + 60_000);
  assert.equal(sim.finished, false);
  runThrough(sim);
  assert.equal(sim.finished, true);
  assert.equal(sim.state().finished, true);
  // the clock freezes at the script's duration: the run is over, the world stops
  sim.advance(START_MS + 600_000);
  assert.equal(sim.seconds(), loadScript(scriptPath).durationSeconds);
  sim.reset();
  assert.equal(sim.finished, false);
});

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
  assert.ok(moments.length >= 5);

  const { sim, feed } = freshSim();
  sim.start(START_MS);

  let published = 0;
  for (const moment of moments) {
    sim.advance(START_MS + (moment.atSeconds / TIME_SCALE) * 1000);
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
  // the script no longer hands over the resolution: with no agent action the
  // substation is still down at the end. Recovering it is the agent's doing.
  sim.advance(START_MS + DURATION * 1000);
  const sub = sim.state().elements.find((e) => e.id === "sub-01");
  assert.notEqual(sub?.status, "resolved", "nobody repaired anything: it cannot be resolved");
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
  const world = createWorld(script, demoRemedies, demoTopology, demoRoads);
  const sim = createSimulation(script, START_MS, feed, world, (closure) => closures.push(closure));
  sim.start(START_MS);
  sim.advance(START_MS + 2_000);

  // the crew repairs the substation: the ACTION resolves it, not the script
  assert.equal(world.assign("crew-1", "sub-01", sim.seconds()).ok, true);
  for (let real = 5; real <= DURATION; real += 5) {
    sim.advance(START_MS + real * 1000);
    for (const ev of world.advance(sim.seconds(), sim.state().elements)) {
      if (ev.type === "remedy_applied" || ev.type === "recovery") {
        sim.inject({
          elementId: ev.elementId,
          metric: ev.metric,
          value: ev.value,
          severity: ev.severity,
        });
      }
    }
  }

  assert.ok(closures.length > 0, "repairing the substation must close its incident");
  assert.equal(closures[0]?.elementId, "sub-01");
  assert.equal(closures[0]?.type, "substation");
  assert.equal(closures[0]?.maxSeverity, 90);
  // The closure carries what the next run needs: who resolved the incident and
  // how long it lasted, not only the peak severity.
  assert.equal(closures[0]?.resolvedBy, "crew-1");
  assert.ok(
    (closures[0]?.durationSeconds ?? 0) > 0,
    "the incident duration must be measured from its onset",
  );

  const ids = closures.map((c) => c.elementId);
  assert.deepEqual(ids, [...new Set(ids)], "each element delivers a single closure");
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
  assert.equal(dc?.updatedAt, isoClock(10 * TIME_SCALE));

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
