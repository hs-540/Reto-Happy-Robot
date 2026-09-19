import type { ChromaClient, Collection, Metadata } from "chromadb";
import {
  HistoricalIncidentSchema,
  type ElementType,
  type HistoricalIncident,
} from "@swarmup/shared";
import type { LlmClient } from "../llm.js";
import type { IncidentClosure } from "../sim.js";

/**
 * Where a memory document comes from. `curated` is the hand-written history
 * shipped in `data/history`; `closure` is the write-back of a resolved incident
 * from an earlier run. They share a collection, so retrieval has to tell them
 * apart to keep the actionable lessons from being crowded out by write-backs.
 */
export type IncidentSource = "closure" | "curated";

export interface RetrievedIncident {
  incident: HistoricalIncident;
  distance: number;
  source: IncidentSource;
}

export interface HistoryRag {
  /** Idempotent preload: upsert by incident id, re-running does not duplicate. Returns the total across collections */
  preload(incidents: readonly HistoricalIncident[]): Promise<number>;
  /** Closes the loop (moment 5): records the outcome of a resolved incident and vectorizes it */
  recordClosure(closure: IncidentClosure): Promise<void>;
  /** The k nearest historical incidents, only from the affected element type's collection */
  search(type: ElementType, query: string, k: number): Promise<RetrievedIncident[]>;
}

/** Text that gets vectorized: everything the agent must remember about the incident */
function documentText(incident: HistoricalIncident): string {
  return `${incident.title}. ${incident.summary} ${incident.outcome}`;
}

/** Collection per element type; own embeddings via the gateway, not the default built-in function */
async function collectionFor(client: ChromaClient, type: ElementType): Promise<Collection> {
  return client.getOrCreateCollection({ name: type, embeddingFunction: null });
}

async function upload(
  collection: Collection,
  incidents: readonly HistoricalIncident[],
  llm: LlmClient,
  source: IncidentSource,
): Promise<void> {
  if (incidents.length === 0) return;
  const texts = incidents.map(documentText);
  const embeddings = await llm.embeddings(texts);
  await collection.upsert({
    ids: incidents.map((i) => i.id),
    embeddings,
    documents: texts,
    // `source` rides beside the incident, not inside it: `HistoricalIncident` is
    // zod and strips unknown keys, so it would be lost on the way back.
    metadatas: incidents.map((i) => ({ ...i, source })),
  });
}

/**
 * Documents persisted before this field existed carry no `source`; the seeded
 * history is the only writer that predates it, so absent means `curated`.
 */
function sourceFrom(metadata: Metadata | null): IncidentSource {
  return metadata?.source === "closure" ? "closure" : "curated";
}

/** `754` → `12m34s`: a closure reads as an operations fact, not raw seconds */
function durationLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function incidentFrom(metadata: Metadata | null, id: string): HistoricalIncident | null {
  const parsed = HistoricalIncidentSchema.safeParse(metadata);
  if (!parsed.success) {
    console.error(`[rag] record '${id}' of the history has invalid metadata`);
    return null;
  }
  return parsed.data;
}

export function createHistoryRag(deps: { client: ChromaClient; llm: LlmClient }): HistoryRag {
  const { client, llm } = deps;

  async function preload(incidents: readonly HistoricalIncident[]): Promise<number> {
    const byType = new Map<ElementType, HistoricalIncident[]>();
    for (const incident of incidents) {
      const list = byType.get(incident.type) ?? [];
      list.push(incident);
      byType.set(incident.type, list);
    }
    let total = 0;
    for (const [type, list] of byType) {
      const collection = await collectionFor(client, type);
      await upload(collection, list, llm, "curated");
      total += await collection.count();
    }
    return total;
  }

  async function recordClosure(closure: IncidentClosure): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    // The summary has to be worth retrieving: a closure that only restates the
    // peak severity gives the next run nothing it can act on, so it names who
    // resolved it and how long the incident lasted.
    const resolution = closure.resolvedBy
      ? `resolved by ${closure.resolvedBy}`
      : "resolved without an attributed resource";
    // deterministic id per element and day: closing the same incident again does not duplicate
    const incident: HistoricalIncident = {
      id: `closure-${closure.elementId}-${date}`,
      type: closure.type,
      title: `Incident closure at ${closure.name} — ${date}`,
      summary: `${closure.type} incident at ${closure.name} ${resolution} after ${durationLabel(closure.durationSeconds)}; maximum severity reached ${Math.round(closure.maxSeverity)}/100.`,
      outcome: `Element stable and deemed resolved at simulation clock ${closure.clock}.`,
      date,
    };
    await upload(await collectionFor(client, closure.type), [incident], llm, "closure");
  }

  async function search(
    type: ElementType,
    query: string,
    k: number,
  ): Promise<RetrievedIncident[]> {
    const collection = await collectionFor(client, type);
    const [vector] = await llm.embeddings([query]);
    if (!vector) return [];
    const res = await collection.query({ queryEmbeddings: [vector], nResults: k });
    const ids = res.ids[0] ?? [];
    const retrieved: RetrievedIncident[] = [];
    for (const [i, id] of ids.entries()) {
      const distance = res.distances[0]?.[i];
      const metadata = res.metadatas[0]?.[i] ?? null;
      const incident = incidentFrom(metadata, id);
      if (distance === null || distance === undefined || incident === null) continue;
      retrieved.push({ incident, distance, source: sourceFrom(metadata) });
    }
    return retrieved;
  }

  return { preload, recordClosure, search };
}
