import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementView } from "@swarmup/shared";
import { createWorld, type WorldEvent } from "../src/world.js";
import { loadScript } from "../src/script.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

function substation(sensors: ElementView["sensors"]): ElementView {
  return element("sub-01", "substation", "Substation", 40.3057, -3.7327, sensors);
}

function hospital(
  sensors: ElementView["sensors"],
  status: ElementView["status"] = "critical",
): ElementView {
  return element("hosp-01", "hospital", "Hospital", 40.31, -3.71, sensors, status);
}

function element(
  id: string,
  type: ElementView["type"],
  name: string,
  lat: number,
  lng: number,
  sensors: ElementView["sensors"],
  status: ElementView["status"] = "critical",
): ElementView {
  return {
    id,
    type,
    name,
    lat,
    lng,
    status,
    severity: 60,
    sensors,
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: new Date().toISOString(),
  };
}

/** Runs the world up to `untilSeconds` in one-minute ticks and collects the events */
function run(
  world: ReturnType<typeof createWorld>,
  elements: ElementView[],
  untilSeconds: number,
  fromSeconds = 60,
): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let t = fromSeconds; t <= untilSeconds; t += 60) {
    events.push(...world.advance(t, elements));
  }
  return events;
}

function released(
  events: WorldEvent[],
  resourceId: string,
): Extract<WorldEvent, { type: "released" }> | undefined {
  return events.find(
    (ev): ev is Extract<WorldEvent, { type: "released" }> =>
      ev.type === "released" && ev.resourceId === resourceId,
  );
}

test("a one-shot crew is freed once its repair has taken hold", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("crew-1", "sub-01", 0).ok, true);

  // the substation stays dark throughout: what frees the crew is finishing the
  // repair, not the readings the site happens to report
  const events = run(world, [substation({ grid_voltage: 0 })], 1500);

  const event = released(events, "crew-1");
  assert.ok(event, "the crew must be freed after the repair");
  assert.equal(event.elementId, "sub-01");

  const crew = world.resources().find((r) => r.id === "crew-1");
  assert.equal(crew?.status, "available");
  assert.equal(crew?.assignedElementId, null);
});

test("a one-shot crew is NOT freed while it is still travelling", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("crew-1", "sub-01", 0).ok, true);

  // the site already has grid power — irrelevant to a one-shot: its job is
  // unfinished and a repair in progress is not spare capacity
  const events = run(world, [substation({ grid_voltage: 98 })], 60);

  assert.equal(released(events, "crew-1"), undefined);
  assert.equal(world.resources().find((r) => r.id === "crew-1")?.status, "in_transit");
});

test("a connected generator is NOT freed while the hospital has no grid", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);

  // far past the 5 minutes its remedy takes: the generator IS the supply here,
  // releasing it would put the hospital straight back in the dark
  const events = run(world, [hospital({ grid_voltage: 0, generator_battery: 95 })], 1200);

  assert.equal(released(events, "generator-1"), undefined);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "assigned");
});

test("that same generator IS freed once the grid comes back", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);

  const dark = [hospital({ grid_voltage: 0, generator_battery: 95 })];
  assert.equal(released(run(world, dark, 1200), "generator-1"), undefined);

  const powered = [hospital({ grid_voltage: 96, generator_battery: 95 }, "normal")];
  const event = released(run(world, powered, 1320, 1260), "generator-1");

  assert.ok(event, "with the grid restored the generator is spare capacity");
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "available");
});

test("a sustaining resource en route to a site that recovered stands down where it is", () => {
  const world = createWorld(script, remedies, topology);
  const assignment = world.assign("generator-2", "hosp-01", 0);
  assert.equal(assignment.ok, true);
  assert.ok(assignment.ok && assignment.etaSeconds > 60, "the test needs a route still in progress");

  // the grid returns mid-journey: finishing the trip would burn minutes of a
  // generator another site could be using
  const events = run(world, [hospital({ grid_voltage: 96 }, "normal")], 60);

  assert.ok(released(events, "generator-2"), "it must stand down instead of arriving");
  const generator = world.resources().find((r) => r.id === "generator-2");
  assert.equal(generator?.status, "available");
  assert.equal(generator?.assignedElementId, null);
  assert.notEqual(generator?.lat, 40.31, "it stays where it stopped, it does not teleport");
});

test("nothing is freed when the site reports no voltage at all", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);

  // a sensor that stopped reporting is not evidence the site was fixed
  const events = run(world, [hospital({ generator_battery: 40 }, "degraded")], 1200);

  assert.equal(released(events, "generator-1"), undefined);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "assigned");
});
