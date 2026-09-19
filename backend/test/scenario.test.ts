import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type FeedItem } from "@swarmup/shared";
import { createFeed, type Feed } from "../src/feed.js";
import { createWorld, type World } from "../src/world.js";
import { createSimulation, TIME_SCALE, type Simulation } from "../src/sim.js";
import {
  BAND_MAX,
  BAND_MIN,
  drawScenario,
  generateScenario,
  MIN_INCIDENT_SPACING_SECONDS,
  validateScenario,
  type Scenario,
} from "../src/scenario.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const topology = loadTopology(`${repoRoot}/data/topology.json`);
const remedies = loadRemedies(`${repoRoot}/data/remedies.json`);
const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("./scenario.golden.json", import.meta.url)), "utf8"),
) as unknown;

const SEEDS = Array.from({ length: 100 }, (_, i) => i);

/** Suppliers per site, recomputed here so the test does not trust the generator */
const SUPPLIERS = new Map(
  topology.edges.filter((e) => e.type === "supplies" && e.to !== "*").map((e) => [e.to, e.from]),
);

/** The draw without its free text: structure, timing and numbers are the spec */
function projection(scenario: Scenario): unknown {
  const { script, topologyGraph, contacts } = scenario;
  return {
    title: script.title,
    durationSeconds: script.durationSeconds,
    elements: script.elements.map((e) => ({ id: e.id, type: e.type })).sort((a, b) => a.id.localeCompare(b.id)),
    resources: script.resources.map((r) => r.id).sort(),
    topologyEdges: topologyGraph.edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort(),
    contactIds: contacts.map((c) => c.id).sort(),
    needleElementId: contacts.find((c) => c.id === "ventilator-citizen")?.elementId ?? null,
    timeline: [...script.timeline]
      .sort((a, b) => a.atSeconds - b.atSeconds)
      .map((e) =>
        e.kind === "sensor_event"
          ? {
              at: e.atSeconds,
              kind: e.kind,
              id: e.payload.id,
              elementId: e.payload.elementId,
              metric: e.payload.metric,
              value: e.payload.value,
              severity: e.payload.severity,
            }
          : {
              at: e.atSeconds,
              kind: e.kind,
              id: e.payload.id,
              elementId: e.payload.elementId,
              source: e.payload.source,
            },
      ),
  };
}

function assertSubsetInvariants(scenario: Scenario): void {
  const { script, contacts } = scenario;
  const active = new Set(script.elements.map((e) => e.id));
  const resourceIds = new Set(script.resources.map((r) => r.id));
  const countOfType = (type: string) => script.elements.filter((e) => e.type === type).length;

  assert.ok(script.elements.length >= 8 && script.elements.length <= 15, "subset of 8-15 sites");
  assert.ok(countOfType("substation") >= 2, "at least 2 substations");
  assert.ok(countOfType("hospital") >= 2, "at least 2 hospitals");
  assert.ok(countOfType("fuel_station") >= 1, "at least one fuel_station");
  assert.ok(countOfType("junction") >= 1, "at least one junction");

  // topological upward closure: a dependent in implies its substation in
  for (const element of script.elements) {
    const supplier = SUPPLIERS.get(element.id);
    if (supplier) assert.ok(active.has(supplier), `${element.id} without its substation ${supplier}`);
  }

  // no dangling contacts, and the needle always on a hospital of the subset
  for (const contact of contacts) {
    if (contact.elementId !== undefined) {
      assert.ok(active.has(contact.elementId), `contact ${contact.id} dangles on ${contact.elementId}`);
    }
    if (contact.resourceId !== undefined) {
      assert.ok(resourceIds.has(contact.resourceId), `contact ${contact.id} dangles on ${contact.resourceId}`);
    }
  }
  const needle = contacts.find((c) => c.id === "ventilator-citizen");
  assert.ok(needle, "the needle is always offered");
  const needleHospital = script.elements.find((e) => e.id === needle?.elementId);
  assert.equal(needleHospital?.type, "hospital", "the needle points at a hospital of the subset");
}

function assertTimelineWellFormed(scenario: Scenario): void {
  const { script } = scenario;
  const active = new Set(script.elements.map((e) => e.id));
  let lastAt = -1;
  for (const event of script.timeline) {
    assert.ok(event.atSeconds >= lastAt, "timeline is sorted");
    assert.ok(event.atSeconds <= script.durationSeconds, "events inside the window");
    lastAt = event.atSeconds;
    if (event.kind === "sensor_event") {
      assert.ok(active.has(event.payload.elementId), `event ${event.payload.id} on an inactive site`);
    } else if (event.kind === "report") {
      if (event.payload.elementId !== null) {
        assert.ok(active.has(event.payload.elementId), `report ${event.payload.id} on an inactive site`);
      }
    }
  }
}

function assertFleetComplete(scenario: Scenario): void {
  const byType = (type: string) => scenario.script.resources.filter((r) => r.type === type).length;
  assert.equal(scenario.script.resources.length, 10);
  assert.equal(byType("crew"), 2);
  assert.equal(byType("generator"), 4);
  assert.equal(byType("tanker"), 2);
  assert.equal(byType("police"), 2);
}

test("the same seed always yields the same crisis", () => {
  assert.deepEqual(generateScenario(2026), generateScenario(2026));
});

test("fixed seed produces the expected output", () => {
  const scenario = generateScenario(2026);
  assert.deepEqual(projection(scenario), GOLDEN);
});

test("every accepted scenario satisfies the invariants, coverage and pacing", () => {
  let accepted = 0;
  for (const seed of SEEDS) {
    const draft = drawScenario(seed);
    const problems = validateScenario(draft);
    const scenario = generateScenario(seed);

    // structure holds for every draw, accepted or not
    assertSubsetInvariants(scenario);
    assertTimelineWellFormed(scenario);
    assertFleetComplete(scenario);

    if (problems.length === 0) {
      accepted += 1;
      // when the raw draw passes, the generator returns exactly that draw
      assert.deepEqual(scenario.script, draft.script);
      // the difficulty band and the spacing, checked literally
      assert.ok(
        draft.meta.demandRatio >= BAND_MIN && draft.meta.demandRatio <= BAND_MAX,
        `seed ${seed}: demand ${(draft.meta.demandRatio * 100).toFixed(0)}% outside the band`,
      );
      const [root] = draft.meta.incidentStarts;
      assert.equal(root, 0, "the root blackout always fires at t = 0");
      for (let i = 1; i < draft.meta.incidentStarts.length; i++) {
        const gap = (draft.meta.incidentStarts[i] as number) - (draft.meta.incidentStarts[i - 1] as number);
        assert.ok(gap >= MIN_INCIDENT_SPACING_SECONDS, `seed ${seed}: incidents ${gap}s apart`);
      }
    }
  }
  // the retry loop must not be quietly falling back on every seed
  assert.ok(accepted >= 40, `only ${accepted}/100 raw draws accepted`);
});

test("the needle lands mid-crisis on a hospital whose substation is down", () => {
  for (const seed of SEEDS) {
    const draft = drawScenario(seed);
    const needleEvents = draft.script.timeline.filter(
      (e) =>
        e.kind === "report" &&
        e.payload.elementId === draft.meta.needleHospitalId &&
        e.payload.text.includes("ventilator"),
    );
    assert.equal(needleEvents.length, 1, `seed ${seed}: exactly one needle report`);
    const needleAt = (needleEvents[0] as { atSeconds: number }).atSeconds;
    assert.ok(needleAt >= 420 && needleAt <= 1080, `seed ${seed}: needle at ${needleAt}`);
    const contact = draft.contacts.find((c) => c.id === "ventilator-citizen");
    assert.equal(contact?.elementId, draft.meta.needleHospitalId, `seed ${seed}: contact reassigned`);
    const hospital = draft.script.elements.find((e) => e.id === draft.meta.needleHospitalId);
    assert.equal(hospital?.type, "hospital", `seed ${seed}: needle on a hospital`);
  }
});

test("a generated scenario plays through the whole window", () => {
  for (const seed of [3, 42, 2026]) {
    const { script, topologyGraph } = generateScenario(seed);
    const feed: Feed = createFeed();
    const world: World = createWorld(script, remedies, topologyGraph);
    const sim: Simulation = createSimulation(script, Date.now(), feed, world);
    sim.start(Date.now());
    const steps = Math.ceil(script.durationSeconds / TIME_SCALE);
    for (let i = 0; i <= steps; i++) {
      sim.advance(Date.now() + i * 1000);
      world.advance(sim.seconds(), sim.state().elements);
    }
    const state = sim.state();
    assert.equal(state.elements.length, script.elements.length);
    for (const element of state.elements) {
      assert.ok(["normal", "degraded", "critical", "resolved"].includes(element.status));
    }
    const published: FeedItem[] = feed.since(0);
    for (const item of published) {
      if (item.kind === "alarm") {
        assert.ok(
          script.elements.some((e) => e.id === item.elementId),
          `alarm for inactive site ${item.elementId}`,
        );
      }
    }
  }
});
