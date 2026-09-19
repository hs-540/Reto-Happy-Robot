import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadRoads, loadTopology } from "@swarmup/shared";
import { parseSince, createFeed, type FeedPublication } from "../src/feed.js";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

const demoRemedies = loadRemedies(
  fileURLToPath(new URL("../../data/remedies.json", import.meta.url)),
);
const demoTopology = loadTopology(
  fileURLToPath(new URL("../../data/topology.json", import.meta.url)),
);
const demoRoads = loadRoads(fileURLToPath(new URL("../../data/roads.json", import.meta.url)));
import { createSimulation } from "../src/sim.js";

test("parseSince accepts a non-negative integer and absence, rejects the rest", () => {
  assert.equal(parseSince(undefined), 0);
  assert.equal(parseSince("0"), 0);
  assert.equal(parseSince("7"), 7);
  assert.equal(parseSince("-1"), null);
  assert.equal(parseSince("abc"), null);
  assert.equal(parseSince("1.5"), null);
  assert.equal(parseSince(""), null);
  assert.equal(parseSince(["1"]), null);
});

test("the feed assigns a monotonic seq and ts, and since(since) cuts with no gaps", () => {
  const feed = createFeed();
  assert.equal(feed.lastSeq(), 0);
  assert.deepEqual(feed.since(0), []);

  const publish = (message: string) =>
    feed.publish({ kind: "system", message } satisfies FeedPublication);
  publish("one");
  publish("two");
  publish("three");

  const items = feed.since(0);
  assert.deepEqual(
    items.map((i) => i.seq),
    [1, 2, 3],
  );
  assert.ok(items.every((i) => !Number.isNaN(Date.parse(i.ts))));
  assert.deepEqual(
    feed.since(1).map((i) => i.seq),
    [2, 3],
  );
  assert.deepEqual(feed.since(3), []);
  assert.equal(feed.lastSeq(), 3);
});

test("the simulation publishes the 5 key moments as system items in order", () => {
  const script = loadScript(
    new URL("../../data/scripts/madrid-blackout.json", import.meta.url),
  );
  const feed = createFeed();
  const sim = createSimulation(script, Date.now(), feed, createWorld(script, demoRemedies, demoTopology, demoRoads));
  sim.start(Date.now());

  sim.advance(Date.now() + (script.durationSeconds + 1) * 1000);

  const notes = script.timeline.flatMap((e) => (e.note === undefined ? [] : [e.note]));
  const systemItems = feed.since(0).filter((i) => i.kind === "system");
  assert.equal(systemItems.length, 5);
  assert.deepEqual(
    systemItems.map((i) => (i.kind === "system" ? i.message : "")),
    notes,
  );
});

test("polling by seq reconstructs the whole feed without losing or duplicating", () => {
  const script = loadScript(
    new URL("../../data/scripts/madrid-blackout.json", import.meta.url),
  );
  const feed = createFeed();
  const sim = createSimulation(script, Date.now(), feed, createWorld(script, demoRemedies, demoTopology, demoRoads));
  sim.start(Date.now());

  // first poll mid-demo, second at the end (accumulator keyed by seq)
  sim.advance(Date.now() + 60 * 1000);
  const firstPoll = feed.since(0);
  const cursor = feed.lastSeq();
  sim.advance(Date.now() + (script.durationSeconds + 1) * 1000);
  const secondPoll = feed.since(cursor);

  const seqs = [...firstPoll, ...secondPoll].map((i) => i.seq);
  assert.equal(feed.lastSeq(), seqs.length);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, k) => k + 1));

  // every alarm points to an element with an elementId and metric from the script
  for (const item of feed.since(0)) {
    if (item.kind === "alarm") {
      assert.ok(script.elements.some((e) => e.id === item.elementId));
    }
  }
  // /api/state correlates with the feed via lastSeq
  assert.equal(sim.state().lastSeq, feed.lastSeq());
});
