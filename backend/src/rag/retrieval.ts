import type { ElementType, ElementView, HistoricalIncident } from "@swarmup/shared";
import type { HistoryEntry } from "../prompt.js";
import type { HistoryRag, RetrievedIncident } from "./history.js";

/**
 * Budget for the whole retrieval pass, waiting for Chroma to come up included.
 * The memory is background knowledge, never a dependency: a deliberation
 * already spends up to 75 s and degrades to deterministic rules when it
 * overruns, so a slow search is dropped instead of charged to that budget.
 * Measured live: embedding the query costs 0.7-2.9 s against the provider, and
 * with 4 s one pass in four was skipped under load. 6 s keeps the common case
 * retrieving while still capping this at under a tenth of the deliberation.
 */
export const RETRIEVAL_TIMEOUT_MS = 6_000;

/** Distinguishes "the clock ran out" from "there was nothing to retrieve" */
const TIMED_OUT = Symbol("retrieval timed out");

function siteLine(e: ElementView): string {
  const sensors = Object.entries(e.sensors)
    .map(([metric, value]) => `${metric} ${value}`)
    .join(", ");
  const readings = sensors === "" ? "" : `, readings ${sensors}`;
  return `${e.name} (${e.type}) is ${e.status} with severity ${e.severity}${readings}`;
}

/**
 * The query is the live situation, never a constant: what woke the engine plus
 * the affected sites of this type with their status and their sensors. A fixed
 * query would return the same three anecdotes at minute 1 and at minute 20.
 */
export function retrievalQuery(
  type: ElementType,
  reasons: readonly string[],
  sites: readonly ElementView[],
): string {
  const own = sites.filter((s) => s.type === type);
  return [
    `Blackout crisis in Madrid affecting ${type} sites.`,
    own.length > 0 ? `Situation right now: ${own.map(siteLine).join("; ")}.` : "",
    reasons.length > 0 ? `What triggered this deliberation: ${reasons.join("; ")}.` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

function matchReason(type: ElementType, sites: readonly ElementView[]): string {
  const ids = sites.filter((s) => s.type === type).map((s) => s.id);
  return ids.length > 0
    ? `similar to what is happening at ${ids.join(", ")} (${type})`
    : `similar to the current ${type} situation`;
}

/**
 * Nearest past incidents for every affected element type, merged into one
 * ranked list. Each collection returns at most `limit`, and the merge is cut by
 * distance: the per-turn budget is measured (see MAX_HISTORY_PER_TURN), so
 * retrieving more than fits means ranking and cutting, not growing the prompt.
 */
export async function retrieveHistory(params: {
  rag: HistoryRag;
  reasons: readonly string[];
  sites: readonly ElementView[];
  limit: number;
}): Promise<HistoryEntry[]> {
  const { rag, reasons, sites, limit } = params;
  const types = [...new Set(sites.map((s) => s.type))];

  const perType = await Promise.all(
    types.map(async (type) => {
      const hits = await rag.search(type, retrievalQuery(type, reasons, sites), limit);
      return hits.map((hit) => ({ hit, type }));
    }),
  );

  // the same incident can surface from two types; keep its closest match
  const best = new Map<string, { hit: RetrievedIncident; type: ElementType }>();
  for (const found of perType.flat()) {
    const seen = best.get(found.hit.incident.id);
    if (seen === undefined || found.hit.distance < seen.hit.distance) {
      best.set(found.hit.incident.id, found);
    }
  }

  return [...best.values()]
    .sort((a, b) => a.hit.distance - b.hit.distance)
    .slice(0, limit)
    .map(({ hit, type }) => ({
      incident: hit.incident,
      retrievedFor: matchReason(type, sites),
    }));
}

/**
 * The path that was there before the memory existed: the JSON shipped in
 * `data/history`, filtered by type. It is the floor every failure lands on, so
 * the model never deliberates with no precedent at all.
 */
export function staticHistory(
  history: readonly HistoricalIncident[],
  sites: readonly ElementView[],
  limit: number,
): HistoryEntry[] {
  const types = new Set(sites.map((s) => s.type));
  return history
    .filter((h) => types.has(h.type))
    .slice(0, limit)
    .map((incident) => ({
      incident,
      retrievedFor: `same site type as the sites in trouble (${incident.type})`,
    }));
}

/**
 * Retrieval that cannot break a deliberation. A memory that never started, one
 * that throws and one that is slow all end the same way — `null` — and the
 * caller carries on with the static history.
 */
export async function tryRetrieveHistory(params: {
  rag: Promise<HistoryRag | null> | null;
  reasons: readonly string[];
  sites: readonly ElementView[];
  limit: number;
  timeoutMs?: number;
}): Promise<HistoryEntry[] | null> {
  const { rag, reasons, sites, limit, timeoutMs = RETRIEVAL_TIMEOUT_MS } = params;
  if (rag === null || sites.length === 0) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    // cleared in `finally`, whichever side of the race wins
    const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const search = (async () => {
      const ready = await rag;
      return ready === null ? null : retrieveHistory({ rag: ready, reasons, sites, limit });
    })();

    const entries = await Promise.race([search, expiry]);
    if (entries === TIMED_OUT) {
      console.error(`[rag] retrieval exceeded ${timeoutMs} ms; the static history takes over`);
      return null;
    }
    if (entries === null || entries.length === 0) return null;
    console.log(
      `[rag] ${entries.length} past incident(s) retrieved for the prompt: ${entries
        .map((e) => e.incident.id)
        .join(", ")}`,
    );
    return entries;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[rag] retrieval failed (${cause}); the static history takes over`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
