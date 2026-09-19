import type { ChromaClient, Collection, Metadata } from "chromadb";
import {
  HistoricalIncidentSchema,
  type ElementType,
  type HistoricalIncident,
} from "@swarmup/shared";
import type { LlmClient } from "../llm.js";
import type { IncidentClosure } from "../sim.js";

export interface RetrievedIncident {
  incident: HistoricalIncident;
  distance: number;
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
): Promise<void> {
  if (incidents.length === 0) return;
  const texts = incidents.map(documentText);
  const embeddings = await llm.embeddings(texts);
  await collection.upsert({
    ids: incidents.map((i) => i.id),
    embeddings,
    documents: texts,
    metadatas: incidents.map((i) => ({ ...i })),
  });
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
      await upload(collection, list, llm);
      total += await collection.count();
    }
    return total;
  }

  async function recordClosure(closure: IncidentClosure): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    // deterministic id per element and day: closing the same incident again does not duplicate
    const incident: HistoricalIncident = {
      id: `closure-${closure.elementId}-${date}`,
      type: closure.type,
      title: `Incident closure at ${closure.name} — ${date}`,
      summary: `${closure.type} incident resolved during the operation; maximum severity reached ${Math.round(closure.maxSeverity)}/100.`,
      outcome: `Element stable and deemed resolved at simulation clock ${closure.clock}.`,
      date,
    };
    await upload(await collectionFor(client, closure.type), [incident], llm);
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
      const incident = incidentFrom(res.metadatas[0]?.[i] ?? null, id);
      if (distance === null || distance === undefined || incident === null) continue;
      retrieved.push({ incident, distance });
    }
    return retrieved;
  }

  return { preload, recordClosure, search };
}
