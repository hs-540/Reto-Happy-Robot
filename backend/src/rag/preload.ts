import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistory } from "@swarmup/shared";
import { config, redactSecrets } from "../config.js";
import { createLlmClient } from "../llm.js";
import { startChroma } from "./chroma.js";
import { createHistoryRag } from "./history.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TYPES = ["datacenter", "hospital", "substation"] as const;

async function main(): Promise<void> {
  const chroma = await startChroma({ path: config.chroma.path, port: config.chroma.port });
  const rag = createHistoryRag({ client: chroma.client, llm: createLlmClient(config.llm.gateways) });
  const historyRoot = path.resolve(repoRoot, "data", "history");
  try {
    for (const type of TYPES) {
      const incidents = loadHistory(path.join(historyRoot, type, "incidents.json"));
      const total = await rag.preload(incidents);
      console.log(`[rag] preload '${type}': ${total} incidents in the collection`);
    }
    console.log("[rag] preload complete (idempotent: re-running does not duplicate)");
  } finally {
    await chroma.stop();
  }
}

main().catch((err) => {
  console.error(`[rag] preload failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
