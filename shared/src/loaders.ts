import { readFileSync } from "node:fs";
import { z } from "zod";
import { ScriptSchema, type Script } from "./script.js";
import { HistoricalIncidentSchema, type HistoricalIncident } from "./history.js";
import { RemediesSchema, TopologySchema, type Remedies, type Topology } from "./graphs.js";
import { RoadNetworkSchema, type RoadNetwork } from "./roads.js";

/* ─── Pure parsing: unknown → validated type, with actionable errors ─── */

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `field '${field}': ${issue.message} (received: ${JSON.stringify(valueAt(input, issue.path))})`;
      })
      .join("\n");
    throw new Error(`Invalid data:\n${details}`);
  }
  return result.data;
}

export function parseScript(input: unknown): Script {
  return parseWith(ScriptSchema, input);
}

export function parseHistory(input: unknown): HistoricalIncident[] {
  return parseWith(z.array(HistoricalIncidentSchema), input);
}

export function parseTopology(input: unknown): Topology {
  return parseWith(TopologySchema, input);
}

export function parseRemedies(input: unknown): Remedies {
  return parseWith(RemediesSchema, input);
}

export function parseRoads(input: unknown): RoadNetwork {
  return parseWith(RoadNetworkSchema, input);
}

/* ─── File loading: read + JSON.parse + validation ─── */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadJson<T>(path: string, parse: (input: unknown) => T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read '${path}': ${errorMessage(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`'${path}' is not valid JSON: ${errorMessage(error)}`);
  }
  try {
    return parse(data);
  } catch (error) {
    throw new Error(`'${path}': ${errorMessage(error)}`);
  }
}

export function loadScript(path: string): Script {
  return loadJson(path, parseScript);
}

export function loadHistory(path: string): HistoricalIncident[] {
  return loadJson(path, parseHistory);
}

export function loadTopology(path: string): Topology {
  return loadJson(path, parseTopology);
}

export function loadRemedies(path: string): Remedies {
  return loadJson(path, parseRemedies);
}

export function loadRoads(path: string): RoadNetwork {
  return loadJson(path, parseRoads);
}
