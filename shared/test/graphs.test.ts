import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CRITICAL_FUEL_THRESHOLD,
  dependentsOf,
  loadRemedies,
  loadTopology,
  validateAction,
  type ValidationContext,
} from "../src/index.js";

const root = new URL("../../", import.meta.url);
const topology = loadTopology(fileURLToPath(new URL("data/topology.json", root)));
const remedies = loadRemedies(fileURLToPath(new URL("data/remedies.json", root)));

test("the topology models the cascade: sub-01 falling drags everything it supplies", () => {
  const affected = dependentsOf(topology, "sub-01");
  for (const id of ["hosp-01", "dc-01", "tower-01", "fuel-01", "junction-01"]) {
    assert.ok(affected.includes(id), `${id} should hang off sub-01`);
  }
});

test("the north and west rings cascade through sub-02 and sub-03", () => {
  const north = dependentsOf(topology, "sub-02");
  for (const id of ["hosp-02", "dc-02", "tower-02", "fuel-02"]) {
    assert.ok(north.includes(id), `${id} should hang off sub-02`);
  }
  const west = dependentsOf(topology, "sub-03");
  for (const id of ["hosp-03", "tower-03", "junction-02"]) {
    assert.ok(west.includes(id), `${id} should hang off sub-03`);
  }
});

test("each tanker has a station that refuels it", () => {
  for (const tanker of ["tanker-1", "tanker-2"]) {
    const edge = topology.edges.find((e) => e.type === "refuels" && e.to === tanker);
    assert.ok(edge, `${tanker} has no refuelling station`);
    assert.ok(edge.from.startsWith("fuel-"), `${tanker} refuels at ${edge.from}`);
  }
});

test("the global couplings of tower and junction are declared", () => {
  const comms = topology.edges.find((e) => e.type === "enables_comms");
  const transit = topology.edges.find((e) => e.type === "enables_transit");
  assert.equal(comms?.from, "tower-01");
  assert.equal(comms?.to, "*", "the tower enables comms for the whole scenario");
  assert.equal(transit?.from, "junction-01");
  assert.equal(transit?.to, "*");
});

test("only the crew repairs a substation; a generator is no substitute", () => {
  const forSubstation = remedies.remedies.filter((r) => r.appliesTo.includes("substation"));
  assert.deepEqual(
    forSubstation.map((r) => r.resource),
    ["crew"],
    "a substation is repaired, not powered",
  );
});

test("remedies with a prerequisite declare it explicitly", () => {
  const generator = remedies.remedies.find((r) => r.resource === "generator");
  const tanker = remedies.remedies.find((r) => r.resource === "tanker");
  assert.equal(generator?.requires, "fuel");
  assert.equal(tanker?.requires, "operational_fuel_station");
});

test("every contact points at a resource or an element, never at nothing", () => {
  for (const c of remedies.contacts) {
    const scope = c.resourceId ?? c.elementId ?? c.id;
    assert.ok(scope.length > 0, `${c.id} has no scope`);
    assert.ok(c.name.length > 0 && c.role.length > 0, `${c.id} has no name or role`);
  }
  assert.ok(remedies.contacts.some((c) => c.resourceId === "crew-1"), "the crew chief is missing");
  assert.ok(
    remedies.contacts.some((c) => c.resourceId === "crew-2"),
    "the second crew has no chief to call",
  );
});

test("generator-without-fuel blocks deploying a dry generator", () => {
  const context: ValidationContext = {
    elements: [
      {
        id: "dc-01",
        type: "datacenter",
        status: "critical",
        metrics: { fuel: CRITICAL_FUEL_THRESHOLD - 1 },
        secondsWithoutPower: 120,
      },
    ],
    resources: [
      { id: "generator-1", type: "generator", status: "available", assignedElementId: null },
    ],
  };
  const verdict = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "generator-1" },
    context,
  );
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) {
    assert.equal(verdict.rule, "generator-without-fuel");
    assert.match(verdict.reason, /tanker/);
  }
});

test("with fuel above the threshold the same deployment is allowed", () => {
  const context: ValidationContext = {
    elements: [
      {
        id: "dc-01",
        type: "datacenter",
        status: "critical",
        metrics: { fuel: CRITICAL_FUEL_THRESHOLD + 50 },
        secondsWithoutPower: 120,
      },
    ],
    resources: [
      { id: "generator-1", type: "generator", status: "available", assignedElementId: null },
    ],
  };
  assert.equal(
    validateAction(
      { type: "assign_resource", elementId: "dc-01", resourceId: "generator-1" },
      context,
    ).allowed,
    true,
  );
});
