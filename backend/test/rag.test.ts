import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { loadHistory, type ElementView } from "@swarmup/shared";
import type { LlmClient } from "../src/llm.js";
import { startChroma, type LocalChroma } from "../src/rag/chroma.js";
import { createHistoryRag } from "../src/rag/history.js";
import { retrieveHistory } from "../src/rag/retrieval.js";
import type { IncidentClosure } from "../src/sim.js";

const dataPath = mkdtempSync(path.join(tmpdir(), "rag-test-"));
const PORT = 21_000 + Math.floor(Math.random() * 8_000);

function incidentsOf(type: string) {
  return loadHistory(
    fileURLToPath(new URL(`../../data/history/${type}/incidents.json`, import.meta.url)),
  );
}

/** Real embeddings come from the gateway (config); a deterministic one is enough here */
const testLlm: LlmClient = {
  structured: async () => {
    throw new Error("not used in tests");
  },
  embeddings: async (texts) => texts.map((t) => [t.length, t.length % 7, 1]),
};

let chroma: LocalChroma;
let rag: ReturnType<typeof createHistoryRag>;

before(async () => {
  chroma = await startChroma({ path: dataPath, port: PORT });
  rag = createHistoryRag({ client: chroma.client, llm: testLlm });
});

after(async () => {
  await chroma.stop();
  rmSync(dataPath, { recursive: true, force: true });
});

async function countOf(type: string): Promise<number> {
  const collection = await chroma.client.getOrCreateCollection({
    name: type,
    embeddingFunction: null,
  });
  return collection.count();
}

test("the preload is idempotent: re-running does not duplicate", async () => {
  const all = ["hospital", "datacenter", "substation"].flatMap(incidentsOf);
  const first = await rag.preload(all);
  const second = await rag.preload(all);

  assert.equal(first, 9);
  assert.equal(second, 9);
  assert.equal(await countOf("hospital"), 3);
  assert.equal(await countOf("datacenter"), 3);
  assert.equal(await countOf("substation"), 3);
});

test("the search for a hospital only returns incidents from the hospital collection", async () => {
  const res = await rag.search("hospital", "power cut in the emergency wing", 10);

  assert.ok(res.length > 0, "the search must return results");
  assert.ok(res.length <= 10);
  for (const { incident } of res) {
    assert.equal(incident.type, "hospital");
  }
  assert.ok(
    res.some(({ incident }) => incident.id === "hist-hosp-001"),
    "the pre-loaded history must be among the results",
  );
});

test("loop closure records the resolved incident and does not duplicate re-closures", async () => {
  const closure: IncidentClosure = {
    elementId: "sub-01",
    type: "substation",
    name: "Getafe-Sur Substation",
    maxSeverity: 90,
    clock: "2026-09-19T10:05:00.000Z",
  };

  await rag.recordClosure(closure);
  const afterFirst = await countOf("substation");
  await rag.recordClosure(closure);
  const afterRepeat = await countOf("substation");

  assert.equal(afterFirst, 4);
  assert.equal(afterRepeat, 4);

  const res = await rag.search("substation", "blackout resolved at the substation", 10);
  assert.ok(
    res.some(({ incident }) => incident.id.startsWith("closure-sub-01-")),
    "the vectorized closure must be retrievable",
  );
});

const substationView: ElementView = {
  id: "sub-01",
  type: "substation",
  name: "Getafe-Sur Substation",
  lat: 40.3057,
  lng: -3.7327,
  status: "critical",
  severity: 82,
  sensors: { grid_voltage: 6 },
  attention: { state: "unattended", resourceId: null, activeDecisionId: null },
  updatedAt: "2026-09-19T10:05:00.000Z",
};

test("what one run closed, the next run retrieves through the agent's path", async () => {
  // A brand-new client and a brand-new rag over the same collections: what
  // survives a run is what is on disk, and that is what "learning between runs"
  // has to mean. Collection naming and embedding path have to line up between
  // the write of `recordClosure` and this read, or the loop is never closed.
  const laterRun = createHistoryRag({
    client: new ChromaClient({ host: "localhost", port: PORT }),
    llm: testLlm,
  });

  const entries = await retrieveHistory({
    rag: laterRun,
    reasons: ["sub-01 goes from degraded to critical"],
    sites: [substationView],
    limit: 4,
  });

  assert.ok(entries.length <= 4);
  assert.ok(
    entries.some(({ incident }) => incident.id.startsWith("closure-sub-01-")),
    "the closure of the previous run must come back as a past incident",
  );
  assert.ok(
    entries.every(({ retrievedFor }) => retrievedFor.includes("sub-01")),
    "every entry states why it surfaced, so the model can cite it",
  );
});
