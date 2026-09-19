import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadHistory } from "@swarmup/shared";
import type { LlmClient } from "../src/llm.js";
import { startChroma, type LocalChroma } from "../src/rag/chroma.js";
import { createHistoryRag } from "../src/rag/history.js";
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
  chat: async () => {
    throw new Error("not used in tests");
  },
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
