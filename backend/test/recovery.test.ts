import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology, type ElementView } from "@swarmup/shared";
import { createWorld } from "../src/world.js";
import { loadScript } from "../src/script.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

function tower(sensors: ElementView["sensors"]): ElementView {
  return {
    id: "tower-01",
    type: "tower",
    name: "Tower",
    lat: 40.3125,
    lng: -3.7285,
    status: "degraded",
    severity: 40,
    sensors,
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: new Date().toISOString(),
  };
}

test("with the grid restored, the tower battery recharges on its own", () => {
  const world = createWorld(script, remedies, topology);
  const sensors = { grid_voltage: 96, tower_battery: 21 };
  const seen: number[] = [];

  for (let t = 60; t <= 600; t += 60) {
    for (const ev of world.advance(t, [tower(sensors)])) {
      if (ev.type === "recovery" && ev.metric === "tower_battery") {
        sensors.tower_battery = ev.value;
        seen.push(ev.value);
      }
    }
  }

  assert.ok(seen.length > 0, "it should emit recovery steps");
  assert.ok(
    seen.every((v, i) => i === 0 || v > seen[i - 1]),
    `the battery must rise monotonically, got ${seen.join(" → ")}`,
  );
  assert.ok(sensors.tower_battery >= 90, `stops at ${sensors.tower_battery}, should reach ~95`);
});

test("without grid power nothing recovers: a fault stays a fault", () => {
  const world = createWorld(script, remedies, topology);
  const sensors = { grid_voltage: 8, tower_battery: 21 };
  let steps = 0;
  for (let t = 60; t <= 600; t += 60) {
    for (const ev of world.advance(t, [tower(sensors)])) {
      if (ev.type === "recovery") steps++;
    }
  }
  assert.equal(steps, 0, "with no voltage nothing can recharge");
});

test("fuel does NOT recover on its own: that needs the tanker", () => {
  const world = createWorld(script, remedies, topology);
  const sensors = { grid_voltage: 96, fuel: 22 };
  let steps = 0;
  for (let t = 60; t <= 600; t += 60) {
    for (const ev of world.advance(t, [tower(sensors)])) {
      if (ev.type === "recovery" && ev.metric === "fuel") steps++;
    }
  }
  assert.equal(steps, 0, "a tank does not refill because the lights came back");
});

test("a resource en route already covers the site: distinct from deployed", () => {
  const world = createWorld(script, remedies, topology);
  assert.equal(world.assign("generator-1", "hosp-01", 0).ok, true);

  const enRoute = world.resources().find((r) => r.id === "generator-1");
  assert.equal(enRoute?.status, "in_transit");
  assert.equal(enRoute?.assignedElementId, "hosp-01");

  // after the journey it becomes deployed, not before
  const elements = [tower({ grid_voltage: 8 })];
  for (let t = 60; t <= 1200; t += 60) world.advance(t, elements);
  assert.equal(world.resources().find((r) => r.id === "generator-1")?.status, "assigned");
});
