import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESOURCE_CAPACITY,
  MAX_MINUTES_WITHOUT_POWER,
  AGENT_RULES,
  calculatePriority,
  deriveStatus,
  deriveElementStatus,
  deriveMetricStatus,
  validateAction,
  type ValidationContext,
  type ValidatableElement,
  type ValidatableResource,
} from "../src/rules.js";

function element(
  id: string,
  type: ValidatableElement["type"],
  overrides: Partial<Omit<ValidatableElement, "id" | "type">> = {},
): ValidatableElement {
  return {
    id,
    type,
    status: "normal",
    metrics: {},
    secondsWithoutPower: 0,
    ...overrides,
  };
}

function resource(
  id: string,
  type: ValidatableResource["type"],
  overrides: Partial<Omit<ValidatableResource, "id" | "type">> = {},
): ValidatableResource {
  return {
    id,
    type,
    status: "available",
    assignedElementId: null,
    ...overrides,
  };
}

function ruleOf(r: ReturnType<typeof validateAction>) {
  return r.allowed === false ? r.rule : null;
}

test("catalog capacities and limits", () => {
  assert.equal(RESOURCE_CAPACITY.crew, 1);
  assert.equal(RESOURCE_CAPACITY.generator, 2);
  assert.equal(MAX_MINUTES_WITHOUT_POWER.hospital, 8);
  assert.equal(MAX_MINUTES_WITHOUT_POWER.datacenter, 12);
  assert.equal(MAX_MINUTES_WITHOUT_POWER.substation, 20);
});

test("severity cuts → status", () => {
  assert.equal(deriveStatus(29), "normal");
  assert.equal(deriveStatus(30), "degraded");
  assert.equal(deriveStatus(59), "degraded");
  assert.equal(deriveStatus(60), "critical");
});

test("per-metric thresholds (script events)", () => {
  assert.equal(deriveMetricStatus("grid_voltage", 12), "critical");
  assert.equal(deriveMetricStatus("temperature", 41), "degraded");
  assert.equal(deriveMetricStatus("temperature", 45), "critical");
  assert.equal(deriveMetricStatus("ups_load", 12), "critical");
  assert.equal(deriveMetricStatus("ups_load", 90), "normal");
});

test("final status: the worst between severity and metrics", () => {
  assert.equal(deriveElementStatus(10, { temperature: 46 }), "critical");
  assert.equal(deriveElementStatus(35, { ups_load: 90 }), "degraded");
});

test("no-double-assignment: rejects a busy or nonexistent resource", () => {
  const ctx: ValidationContext = {
    elements: [element("hosp-01", "hospital"), element("dc-01", "datacenter")],
    resources: [
      resource("crew-1", "crew", { status: "assigned", assignedElementId: "hosp-01" }),
    ],
  };
  const busy = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "crew-1" },
    ctx,
  );
  assert.equal(busy.allowed, false);
  assert.equal(ruleOf(busy), "no-double-assignment");

  const nonexistent = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "crew-9" },
    ctx,
  );
  assert.equal(nonexistent.allowed, false);
  assert.equal(ruleOf(nonexistent), "no-double-assignment");

  const ctxReleased: ValidationContext = {
    elements: [element("hosp-01", "hospital"), element("dc-01", "datacenter")],
    resources: [resource("crew-1", "crew")],
  };
  assert.deepEqual(
    validateAction(
      { type: "assign_resource", elementId: "dc-01", resourceId: "crew-1" },
      ctxReleased,
    ),
    { allowed: true },
  );
});

test("hospital-power-priority: generators only to the critical hospital without backup", () => {
  const ctx: ValidationContext = {
    elements: [
      element("hosp-01", "hospital", { status: "critical", secondsWithoutPower: 120 }),
      element("dc-01", "datacenter", { status: "degraded" }),
    ],
    resources: [resource("generator-1", "generator")],
  };
  const toDatacenter = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "generator-1" },
    ctx,
  );
  assert.equal(toDatacenter.allowed, false);
  assert.equal(ruleOf(toDatacenter), "hospital-power-priority");

  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "hosp-01", resourceId: "generator-1" }, ctx),
    { allowed: true },
  );
});

/**
 * Reproduces the corner the agent was driven into: a generator is already on
 * its way to a hospital past its limit, so the hospital is answered for — but
 * the deadline rule ignored inbound generators and vetoed every other option,
 * leaving "send the second generator to the hospital too" as the only legal
 * move. The tower, meanwhile, was dying with no generator left.
 */
test("a generator already en route answers for the hospital: the fleet is free", () => {
  const pastDeadline = (MAX_MINUTES_WITHOUT_POWER.hospital + 1) * 60;
  const ctx: ValidationContext = {
    elements: [
      element("hosp-01", "hospital", { status: "critical", secondsWithoutPower: pastDeadline }),
      element("tower-01", "tower", { status: "critical", secondsWithoutPower: 400 }),
    ],
    resources: [
      resource("generator-1", "generator", {
        status: "in_transit",
        assignedElementId: "hosp-01",
      }),
      resource("generator-2", "generator"),
    ],
  };

  assert.deepEqual(
    validateAction(
      { type: "assign_resource", elementId: "tower-01", resourceId: "generator-2" },
      ctx,
    ),
    { allowed: true },
    "the second generator must be free to save the tower",
  );
  assert.deepEqual(
    validateAction({ type: "wait", elementId: "tower-01" }, ctx),
    { allowed: true },
    "holding elsewhere is legitimate once the hospital has its answer coming",
  );
});

test("with nothing on its way, the hospital deadline still binds everything", () => {
  const pastDeadline = (MAX_MINUTES_WITHOUT_POWER.hospital + 1) * 60;
  const unanswered: ValidationContext = {
    elements: [
      element("hosp-01", "hospital", { status: "critical", secondsWithoutPower: pastDeadline }),
      element("tower-01", "tower", { status: "critical" }),
    ],
    resources: [resource("generator-2", "generator"), resource("tanker-1", "tanker")],
  };

  // a tanker competes with the hospital but is not a generator, so it reaches
  // the deadline rule instead of being stopped earlier by the priority one
  const tankerAway = validateAction(
    { type: "assign_resource", elementId: "tower-01", resourceId: "tanker-1" },
    unanswered,
  );
  assert.equal(tankerAway.allowed, false, "the rule must still protect an unanswered hospital");
  assert.equal(ruleOf(tankerAway), "hospital-power-deadline");

  assert.equal(
    validateAction({ type: "wait", elementId: "tower-01" }, unanswered).allowed,
    false,
    "nor may it stand and watch while the hospital has nothing coming",
  );

  // the same tanker is free again as soon as a generator is on its way
  const answered: ValidationContext = {
    ...unanswered,
    resources: [
      resource("generator-2", "generator", {
        status: "in_transit",
        assignedElementId: "hosp-01",
      }),
      resource("tanker-1", "tanker"),
    ],
  };
  assert.deepEqual(
    validateAction(
      { type: "assign_resource", elementId: "tower-01", resourceId: "tanker-1" },
      answered,
    ),
    { allowed: true },
  );
});

test("hospital-power-deadline only binds resources that compete with the hospital", () => {
  const ctx: ValidationContext = {
    elements: [
      element("hosp-01", "hospital", {
        status: "critical",
        secondsWithoutPower: (MAX_MINUTES_WITHOUT_POWER.hospital + 1) * 60,
      }),
      element("dc-01", "datacenter", { status: "degraded" }),
      element("sub-01", "substation", { status: "critical" }),
    ],
    resources: [
      resource("crew-1", "crew"),
      resource("generator-1", "generator"),
      resource("tanker-1", "tanker"),
      resource("police-1", "police"),
    ],
  };
  const waitDatacenter = validateAction({ type: "wait", elementId: "dc-01" }, ctx);
  assert.equal(waitDatacenter.allowed, false);
  assert.equal(ruleOf(waitDatacenter), "hospital-power-deadline");

  // a generator does compete with the hospital: still blocked elsewhere
  const generatorToDatacenter = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "generator-1" },
    ctx,
  );
  assert.equal(generatorToDatacenter.allowed, false);

  // so does the tanker, which refuels hospitals too
  const tankerToDatacenter = validateAction(
    { type: "assign_resource", elementId: "dc-01", resourceId: "tanker-1" },
    ctx,
  );
  assert.equal(tankerToDatacenter.allowed, false);
  assert.equal(ruleOf(tankerToDatacenter), "hospital-power-deadline");

  // a traffic patrol is no substitute for a generator: blocking it only
  // paralyses the agent without giving the hospital anything
  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "junction-01", resourceId: "police-1" }, ctx),
    { allowed: true },
  );
  // nor is the crew, which repairs the root cause
  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "dc-01", resourceId: "crew-1" }, ctx),
    { allowed: true },
  );

  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "hosp-01", resourceId: "crew-1" }, ctx),
    { allowed: true },
  );
  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "sub-01", resourceId: "crew-1" }, ctx),
    { allowed: true },
  );
  const generatorToSubstation = validateAction(
    { type: "assign_resource", elementId: "sub-01", resourceId: "generator-1" },
    ctx,
  );
  assert.equal(generatorToSubstation.allowed, false);
  assert.equal(ruleOf(generatorToSubstation), "hospital-power-priority");
  assert.deepEqual(validateAction({ type: "wait", elementId: "hosp-01" }, ctx), {
    allowed: true,
  });
});

test("critical-ups-act: waiting forbidden with low ups_load", () => {
  const ctx: ValidationContext = {
    elements: [
      element("hosp-01", "hospital"),
      element("dc-01", "datacenter", { status: "critical", metrics: { ups_load: 10 } }),
    ],
    resources: [resource("generator-1", "generator")],
  };
  const wait = validateAction({ type: "wait", elementId: "dc-01" }, ctx);
  assert.equal(wait.allowed, false);
  assert.equal(ruleOf(wait), "critical-ups-act");

  assert.deepEqual(
    validateAction({ type: "assign_resource", elementId: "dc-01", resourceId: "generator-1" }, ctx),
    { allowed: true },
  );
  assert.deepEqual(validateAction({ type: "contact", elementId: "dc-01" }, ctx), {
    allowed: true,
  });
});

test("calculatePriority: critical hospital without power beats degraded datacenter", () => {
  const hospital = calculatePriority({
    type: "hospital",
    status: "critical",
    criticality: 95,
    secondsWithoutPower: 10 * 60,
  });
  const datacenter = calculatePriority({
    type: "datacenter",
    status: "degraded",
    criticality: 60,
    secondsWithoutPower: 0,
  });
  const substation = calculatePriority({
    type: "substation",
    status: "normal",
    criticality: 70,
    secondsWithoutPower: 0,
  });

  assert.equal(hospital, 0.5 * 95 + 60 + 30 + 2 * 10);
  assert.equal(datacenter, 0.5 * 60 + 20 + 10);
  assert.ok(hospital > datacenter);
  assert.ok(datacenter > substation);
});

test("AGENT_RULES is serializable to be injected into the LLM prompt", () => {
  const json = JSON.parse(JSON.stringify(AGENT_RULES));
  assert.equal(json.blockingRules.length, 5);
  assert.equal(json.priority.typeOrder[0], "hospital");
  assert.equal(json.maxMinutesWithoutPower.hospital, MAX_MINUTES_WITHOUT_POWER.hospital);
});
