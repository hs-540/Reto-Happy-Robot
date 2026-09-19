import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRemedies, loadTopology } from "@swarmup/shared";
import { createWorld } from "../src/world.js";
import { loadScript } from "../src/script.js";

const root = new URL("../../", import.meta.url);
const script = loadScript(new URL("data/scripts/madrid-blackout.json", root));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));

function world() {
  return createWorld(script, remedies, topology);
}

/** Minutes the catalog declares for a (resource, site type) pair */
function remedyMinutes(resource: string, type: string): number {
  const remedy = remedies.remedies.find(
    (r) => r.resource === resource && (r.appliesTo as readonly string[]).includes(type),
  );
  assert.ok(remedy, `no ${resource} remedy for ${type}`);
  return remedy.minutes;
}

test("a site nobody is fixing has no countdown", () => {
  assert.equal(world().repairEstimate("hosp-01", 0), null);
});

test("while it travels, the countdown is the journey plus the whole job", () => {
  const w = world();
  w.assign("generator-1", "hosp-01", 0);

  const estimate = w.repairEstimate("hosp-01", 0);
  assert.ok(estimate);
  assert.equal(estimate.resourceId, "generator-1");
  assert.equal(estimate.viaElementId, "hosp-01");
  assert.ok(estimate.travelSeconds > 0, "it has not arrived yet");
  assert.equal(estimate.workSeconds, remedyMinutes("generator", "hospital") * 60);
  assert.equal(estimate.totalSeconds, estimate.travelSeconds + estimate.workSeconds);
});

test("the countdown falls as the clock advances, and never below zero", () => {
  const w = world();
  w.assign("generator-1", "hosp-01", 0);

  let previous = Infinity;
  for (let t = 0; t <= 2400; t += 120) {
    w.advance(t, []);
    const estimate = w.repairEstimate("hosp-01", t);
    assert.ok(estimate, `lost the estimate at t=${t}`);
    assert.ok(estimate.totalSeconds <= previous, `went up at t=${t}`);
    assert.ok(estimate.totalSeconds >= 0, `negative at t=${t}`);
    previous = estimate.totalSeconds;
  }
  assert.equal(previous, 0, "it should end at zero, with the remedy applied");
});

test("once it arrives there is no journey left, only work", () => {
  const w = world();
  w.assign("generator-1", "hosp-01", 0);
  for (let t = 60; t <= 1200; t += 60) w.advance(t, []);

  const estimate = w.repairEstimate("hosp-01", 1200);
  assert.ok(estimate);
  assert.equal(estimate.travelSeconds, 0);
  assert.equal(estimate.totalSeconds, estimate.workSeconds);
});

test("a resource sent where its remedy does not apply gets no countdown", () => {
  const w = world();
  // remedies.json declares no tanker remedy for a substation: it fixes nothing
  // there, and a counter ticking down to nothing would be a lie
  assert.equal(w.assign("tanker-1", "sub-01", 0).ok, true);
  assert.equal(w.repairEstimate("sub-01", 0), null);
});

test("repairing the substation is the countdown of everything hanging off it", () => {
  const w = world();
  w.assign("crew-1", "sub-01", 0);

  const dependents = ["hosp-01", "dc-01", "tower-01", "fuel-01", "junction-01"];
  for (const id of dependents) {
    const estimate = w.repairEstimate(id, 0);
    assert.ok(estimate, `${id} should inherit the substation repair`);
    assert.equal(estimate.viaElementId, "sub-01", `${id} should point at the upstream node`);
    assert.equal(estimate.resourceId, "crew-1");
  }
});

test("a site's own resource wins over the one inherited from upstream", () => {
  const w = world();
  w.assign("crew-1", "sub-01", 0);
  w.assign("generator-1", "hosp-01", 0);

  const estimate = w.repairEstimate("hosp-01", 0);
  assert.ok(estimate);
  assert.equal(estimate.viaElementId, "hosp-01", "its own generator, not the substation repair");
  assert.equal(estimate.resourceId, "generator-1");
});
