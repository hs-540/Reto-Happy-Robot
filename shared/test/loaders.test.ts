import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScript, loadHistory, parseScript } from "../src/loaders.js";

const scriptPath = fileURLToPath(new URL("../../data/scripts/madrid-blackout.json", import.meta.url));

const historyPath = (type: string) =>
  fileURLToPath(new URL(`../../data/history/${type}/incidents.json`, import.meta.url));

test("the current script validates without errors", () => {
  const script = loadScript(scriptPath);
  assert.equal(script.title, "Cascading blackout — Getafe, Community of Madrid");
  assert.equal(script.durationSeconds, 1800);
  assert.equal(script.elements.length, 15);
  assert.equal(script.resources.length, 10);
  assert.equal(script.timeline.length, 93);
});

test("the current histories validate without errors", () => {
  for (const type of ["hospital", "datacenter", "substation", "tower", "fuel_station", "junction"]) {
    const incidents = loadHistory(historyPath(type));
    // 10-15 per type so the retrieval can rank a real subset, not return everything
    assert.ok(
      incidents.length >= 10 && incidents.length <= 15,
      `${type} must carry 10-15 incidents, got ${incidents.length}`,
    );
    assert.ok(incidents.every((i) => i.type === type));
    assert.equal(new Set(incidents.map((i) => i.id)).size, incidents.length);
  }
});

test("an invalid field reports the field and the received value", () => {
  const broken = {
    title: "Blackout",
    durationSeconds: 300,
    elements: [],
    resources: [],
    timeline: [
      {
        atSeconds: 0,
        kind: "sensor_event",
        payload: {
          id: "evt-001",
          elementId: "sub-01",
          metric: "grid_voltage",
          value: 12,
          severity: "very high",
        },
      },
    ],
  };
  assert.throws(() => parseScript(broken), /timeline\.0\.payload\.severity/);
  assert.throws(() => parseScript(broken), /received: "very high"/);
});

test("malformed JSON fails with an actionable message", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarmup-data-"));
  try {
    const path_ = path.join(dir, "broken.json");
    writeFileSync(path_, "{ title: broken }", "utf8");
    assert.throws(() => loadScript(path_), /broken\.json' is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
