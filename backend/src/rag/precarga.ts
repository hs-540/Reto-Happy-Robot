import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargarHistorico } from "@swarmup/shared";
import { config, redactSecrets } from "../config.js";
import { crearClienteLlm } from "../llm.js";
import { arrancarChroma } from "./chroma.js";
import { crearRagHistorico } from "./historico.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TIPOS = ["datacenter", "hospital", "subestacion"] as const;

async function main(): Promise<void> {
  const chroma = await arrancarChroma({ ruta: config.chroma.path, puerto: config.chroma.port });
  const rag = crearRagHistorico({ cliente: chroma.cliente, llm: crearClienteLlm(config.llm.gateways) });
  const raizHistorico = path.resolve(repoRoot, "data", "history");
  try {
    for (const tipo of TIPOS) {
      const incidentes = cargarHistorico(path.join(raizHistorico, tipo, "incidentes.json"));
      const total = await rag.precargar(incidentes);
      console.log(`[rag] precarga '${tipo}': ${total} incidentes en la colección`);
    }
    console.log("[rag] precarga completa (idempotente: re-ejecutar no duplica)");
  } finally {
    await chroma.parar();
  }
}

main().catch((err) => {
  console.error(`[rag] precarga falló: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
