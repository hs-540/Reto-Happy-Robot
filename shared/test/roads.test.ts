import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRoadRouter, haversineKm, type RoadNetwork } from "../src/roads.js";
import { loadRoads } from "../src/loaders.js";

const roadsPath = fileURLToPath(new URL("../../data/roads.json", import.meta.url));

test("the committed street network validates and is substantial", () => {
  const network = loadRoads(roadsPath);
  assert.equal(network.source, "© OpenStreetMap contributors");
  assert.ok(network.nodes.length > 1000, `nodes: ${network.nodes.length}`);
  assert.ok(network.edges.length > 1000, `edges: ${network.edges.length}`);
});

test("routes follow real streets and are longer than the straight line", () => {
  const router = createRoadRouter(loadRoads(roadsPath));
  const depot = { lat: 40.302, lng: -3.722 };
  const hospital = { lat: 40.31, lng: -3.71 };

  const route = router.route(depot, hospital);
  assert.ok(route, "depot to hospital must be routable");

  const straight = haversineKm(depot, hospital);
  assert.ok(route.km > straight, `road km ${route.km} must exceed straight km ${straight}`);
  assert.ok(route.km < straight * 3, `road km ${route.km} must stay plausible`);

  assert.deepEqual(route.waypoints[0], depot);
  assert.deepEqual(route.waypoints[route.waypoints.length - 1], hospital);
  assert.ok(route.waypoints.length > 4, "the route must visit intermediate streets");
});

test("every scenario journey is routable in both directions", () => {
  const router = createRoadRouter(loadRoads(roadsPath));
  const depot = { lat: 40.302, lng: -3.722 };
  const sites = [
    { lat: 40.3057, lng: -3.7327 }, // substation
    { lat: 40.31, lng: -3.71 }, // hospital
    { lat: 40.2957, lng: -3.7136 }, // datacenter
    { lat: 40.3125, lng: -3.7285 }, // tower
    { lat: 40.2998, lng: -3.7352 }, // fuel station
    { lat: 40.3082, lng: -3.7156 }, // junction
  ];
  for (const site of sites) {
    assert.ok(router.route(depot, site), `depot -> ${site.lat},${site.lng}`);
    assert.ok(router.route(site, depot), `${site.lat},${site.lng} -> depot`);
  }
});

test("a point far from any road cannot be snapped", () => {
  const router = createRoadRouter(loadRoads(roadsPath));
  const far = { lat: 40.6, lng: -3.9 };
  assert.equal(router.route({ lat: 40.302, lng: -3.722 }, far), null);
});

test("oneway walls fall back to the undirected network instead of failing", () => {
  const oneway: RoadNetwork = {
    source: "test",
    bbox: { south: 39.99, west: -3.02, north: 40.02, east: -2.98 },
    nodes: [
      [40.0, -3.0],
      [40.0, -3.01],
      [40.01, -3.01],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 1],
    ],
  };
  const router = createRoadRouter(oneway);
  assert.ok(router.route({ lat: 40.0, lng: -3.0 }, { lat: 40.01, lng: -3.01 }));
  // returning against the oneway is still routable through the fallback
  assert.ok(router.route({ lat: 40.01, lng: -3.01 }, { lat: 40.0, lng: -3.0 }));
});

test("two disconnected roads yield no route", () => {
  const disconnected: RoadNetwork = {
    source: "test",
    bbox: { south: 39.99, west: -3.02, north: 40.02, east: -2.98 },
    nodes: [
      [40.0, -3.0],
      [40.0, -3.01],
      [40.008, -3.005],
    ],
    edges: [[0, 1]],
  };
  const router = createRoadRouter(disconnected);
  const route = router.route({ lat: 40.0, lng: -3.0 }, { lat: 40.008, lng: -3.005 });
  assert.equal(route, null);
});
