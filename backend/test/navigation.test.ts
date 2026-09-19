import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadRoads, loadTopology } from "@swarmup/shared";
import { loadScript } from "../src/script.js";
import { createWorld } from "../src/world.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));
const roads = loadRoads(fileURLToPath(new URL("data/roads.json", root)));

const depot = { lat: 40.302, lng: -3.722 };
const hospital = { lat: 40.31, lng: -3.71 };

function flatKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

test("an en route resource follows the streets, not the straight line", () => {
  const world = createWorld(script, remedies, topology, roads);
  assert.ok(world.assign("generator-1", "hosp-01", 0).ok);

  const enRoute = world.resources().find((r) => r.id === "generator-1");
  assert.ok(enRoute?.route, "the journey exposes its road polyline");
  assert.ok(enRoute.route.length > 4, "the polyline visits intermediate streets");

  // sampling the movement traces a path clearly longer than the straight line
  const straight = flatKm(depot, hospital);
  let travelled = 0;
  let previous = depot;
  for (let t = 0; t <= 400; t += 10) {
    world.advance(t, []);
    const current = world.resources().find((r) => r.id === "generator-1");
    if (!current) continue;
    travelled += flatKm(previous, current);
    previous = { lat: current.lat, lng: current.lng };
  }
  assert.ok(
    travelled > straight * 1.2,
    `travelled ${travelled.toFixed(2)} km must exceed the straight ${straight.toFixed(2)} km`,
  );
});

test("the journey ends exactly at the destination", () => {
  const world = createWorld(script, remedies, topology, roads);
  assert.ok(world.assign("crew-1", "sub-01", 0).ok);

  for (let t = 0; t <= 600; t += 5) world.advance(t, []);
  const arrived = world.resources().find((r) => r.id === "crew-1");
  assert.equal(arrived?.status, "assigned");
  assert.ok(arrived);
  assert.ok(Math.abs(arrived.lat - 40.3057) < 1e-9);
  assert.ok(Math.abs(arrived.lng - -3.7327) < 1e-9);
  assert.equal(arrived.route, undefined, "no route is exposed once deployed");
});

test("without a road network the world still moves in straight lines", () => {
  const world = createWorld(script, remedies, topology);
  assert.ok(world.assign("generator-1", "hosp-01", 0).ok);

  world.advance(60, []);
  const moving = world.resources().find((r) => r.id === "generator-1");
  assert.ok(moving?.route, "the fallback still exposes a polyline to draw");
  assert.equal(moving.route.length, 2, "the fallback is a bare origin-destination segment");
  assert.ok(moving);
  const progress = flatKm(depot, moving);
  const straight = flatKm(depot, hospital);
  assert.ok(
    progress < straight && progress > 0,
    "the resource is between origin and destination",
  );
});
