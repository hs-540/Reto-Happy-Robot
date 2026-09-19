import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { loadHistory, type ElementView, type HistoricalIncident } from "@swarmup/shared";
import type { LlmClient } from "../src/llm.js";
import { startChroma, type LocalChroma } from "../src/rag/chroma.js";
import { createHistoryRag, type HistoryRag, type RetrievedIncident } from "../src/rag/history.js";
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

  assert.equal(first, all.length);
  assert.equal(second, all.length);
  assert.equal(await countOf("hospital"), incidentsOf("hospital").length);
  assert.equal(await countOf("datacenter"), incidentsOf("datacenter").length);
  assert.equal(await countOf("substation"), incidentsOf("substation").length);
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
  assert.ok(
    res.every(({ source }) => source === "curated"),
    "documents seeded from data/history are curated, not closures",
  );
});

test("loop closure records the resolved incident and does not duplicate re-closures", async () => {
  const closure: IncidentClosure = {
    elementId: "sub-01",
    type: "substation",
    name: "Getafe-Sur Substation",
    maxSeverity: 90,
    durationSeconds: 740,
    resolvedBy: "crew-1",
    clock: "2026-09-19T10:05:00.000Z",
  };

  const substationCount = incidentsOf("substation").length;
  await rag.recordClosure(closure);
  const afterFirst = await countOf("substation");
  await rag.recordClosure(closure);
  const afterRepeat = await countOf("substation");

  assert.equal(afterFirst, substationCount + 1);
  assert.equal(afterRepeat, substationCount + 1);

  const res = await rag.search("substation", "blackout resolved at the substation", 10);
  const hit = res.find(({ incident }) => incident.id.startsWith("closure-sub-01-"));
  assert.ok(hit, "the vectorized closure must be retrievable");
  // Distinguishable from the seeded lessons, and worth retrieving: it names the
  // resource and the incident's duration instead of only the peak severity.
  assert.equal(hit.source, "closure");
  assert.match(hit.incident.summary, /resolved by crew-1/);
  assert.match(hit.incident.summary, /12m20s/);
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

test("a deep history of closures cannot crowd out the curated lessons", async () => {
  // Closures embed the live situation verbatim, so in Chroma they can rank
  // NEARER than the hand-written lessons. Without a reserve, the nearest three
  // would take the whole budget and no actionable outcome would reach the
  // prompt. The curations below are deliberately the worst matches.
  const literal = (id: string): HistoricalIncident => ({
    id,
    type: "substation",
    title: `Incident ${id}`,
    summary: `Summary of ${id}`,
    outcome: `Outcome of ${id}`,
    date: "2026-05-01",
  });
  const closures: RetrievedIncident[] = Array.from({ length: 4 }, (_, i) => ({
    incident: literal(`closure-sub-${i}`),
    distance: 0.01 * (i + 1),
    source: "closure",
  }));
  const curated: RetrievedIncident[] = Array.from({ length: 2 }, (_, i) => ({
    incident: literal(`hist-sub-${i}`),
    distance: 0.9 + i * 0.01,
    source: "curated",
  }));
  const stub: HistoryRag = {
    preload: async () => 0,
    recordClosure: async () => {},
    search: async () => [...closures, ...curated],
  };

  const entries = await retrieveHistory({
    rag: stub,
    reasons: ["sub-01 goes critical"],
    sites: [substationView],
    limit: 3,
  });

  const ids = entries.map((e) => e.incident.id);
  assert.equal(entries.length, 3, "the per-turn budget is still respected");
  assert.ok(
    ids.includes("hist-sub-0") && ids.includes("hist-sub-1"),
    `both curated lessons must survive, got ${ids.join(", ")}`,
  );
  assert.ok(ids.includes("closure-sub-0"), "the best closure still fills the free slot");
});

/**
 * The gateway embeddings are the real ranker; a test cannot call them, so this
 * double approximates them with a deterministic bag of words weighted by inverse
 * document frequency. The length-only `testLlm` above cannot tell two situations
 * apart: with 12 incidents per type the ranking has to turn on the vocabulary of
 * the live situation, not on how long the query happens to be.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "was", "were", "this", "from", "into",
  "its", "his", "her", "their", "there", "then", "than", "them", "they", "not",
  "but", "had", "has", "have", "been", "before", "after", "when", "while",
  "over", "under", "again", "once", "only", "also", "are", "does", "did", "who",
  "whom", "which", "what", "where", "why", "how", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "nor", "too", "very", "can",
  "will", "just", "should", "now", "site", "sites",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (word) => word.length > 1 && !STOPWORDS.has(word),
  );
}

const EMBEDDING_DIM = 96;

function vocabularyEmbedder(corpus: readonly string[]): (text: string) => number[] {
  const documentFrequency = new Map<string, number>();
  for (const doc of corpus) {
    for (const token of new Set(tokens(doc))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = (token: string) =>
    Math.log((corpus.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;

  return (text: string) => {
    const vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
    for (const token of tokens(text)) {
      let hash = 0;
      for (let i = 0; i < token.length; i += 1) {
        hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
      }
      vector[hash % EMBEDDING_DIM] += idf(token);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  };
}

test("two different situations of the same type retrieve different incidents", async () => {
  // The tower collection is untouched by the other tests, so a second history
  // rag with a more realistic embedding can be preloaded here without disturbing
  // the counts above.
  const towerIncidents = incidentsOf("tower");
  const embed = vocabularyEmbedder(
    towerIncidents.map((i) => `${i.title} ${i.summary} ${i.outcome}`),
  );
  const rankingRag = createHistoryRag({
    client: chroma.client,
    llm: {
      structured: async () => {
        throw new Error("not used in this test");
      },
      embeddings: async (texts) => texts.map(embed),
    },
  });
  await rankingRag.preload(towerIncidents);

  const towerView = (sensors: ElementView["sensors"]): ElementView => ({
    id: "tower-04",
    type: "tower",
    name: "Las Margaritas Telecoms Tower",
    lat: 40.2991,
    lng: -3.7473,
    status: "critical",
    severity: 85,
    sensors,
    attention: { state: "unattended", resourceId: null, activeDecisionId: null },
    updatedAt: "2026-09-19T10:05:00.000Z",
  });

  const accessSituation = await retrieveHistory({
    rag: rankingRag,
    reasons: [
      "the crew reached the tower but the compound gate is locked and they have no access credentials",
    ],
    sites: [towerView({ tower_battery: 34 })],
    limit: 4,
  });
  const batterySituation = await retrieveHistory({
    rag: rankingRag,
    reasons: [
      "tower_battery is draining faster than the autonomy estimate because network_coverage demand doubled",
    ],
    sites: [towerView({ tower_battery: 12, network_coverage: 30 })],
    limit: 4,
  });

  const accessIds = accessSituation.map((e) => e.incident.id);
  const batteryIds = batterySituation.map((e) => e.incident.id);

  assert.notDeepEqual(accessIds, batteryIds, "the live situation must change which incidents rank");
  assert.ok(
    accessIds.some((id) => id === "hist-tow-002" || id === "hist-tow-005"),
    `the access situation must surface an access incident, got ${accessIds.join(", ")}`,
  );
  assert.ok(
    batteryIds.some(
      (id) => id === "hist-tow-001" || id === "hist-tow-004" || id === "hist-tow-012",
    ),
    `the battery situation must surface a battery incident, got ${batteryIds.join(", ")}`,
  );
});
