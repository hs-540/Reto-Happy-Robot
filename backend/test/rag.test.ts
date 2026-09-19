import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cargarHistorico } from "@swarmup/shared";
import type { ClienteLlm } from "../src/llm.js";
import { arrancarChroma, type ChromaLocal } from "../src/rag/chroma.js";
import { crearRagHistorico } from "../src/rag/historico.js";
import type { CierreIncidente } from "../src/sim.js";

const rutaDatos = mkdtempSync(path.join(tmpdir(), "rag-test-"));
const PUERTO = 21_000 + Math.floor(Math.random() * 8_000);

function incidentesDe(tipo: string) {
  return cargarHistorico(
    fileURLToPath(new URL(`../../data/history/${tipo}/incidentes.json`, import.meta.url)),
  );
}

/** Los embeddings reales vienen del gateway (config); aquí basta uno determinista */
const llmPrueba: ClienteLlm = {
  chat: async () => {
    throw new Error("no usado en pruebas");
  },
  estructurada: async () => {
    throw new Error("no usado en pruebas");
  },
  embeddings: async (textos) => textos.map((t) => [t.length, t.length % 7, 1]),
};

let chroma: ChromaLocal;
let rag: ReturnType<typeof crearRagHistorico>;

before(async () => {
  chroma = await arrancarChroma({ ruta: rutaDatos, puerto: PUERTO });
  rag = crearRagHistorico({ cliente: chroma.cliente, llm: llmPrueba });
});

after(async () => {
  await chroma.parar();
  rmSync(rutaDatos, { recursive: true, force: true });
});

async function countDe(tipo: string): Promise<number> {
  const coleccion = await chroma.cliente.getOrCreateCollection({
    name: tipo,
    embeddingFunction: null,
  });
  return coleccion.count();
}

test("la precarga es idempotente: re-ejecutar no duplica", async () => {
  const todos = ["hospital", "datacenter", "subestacion"].flatMap(incidentesDe);
  const primera = await rag.precargar(todos);
  const segunda = await rag.precargar(todos);

  assert.equal(primera, 9);
  assert.equal(segunda, 9);
  assert.equal(await countDe("hospital"), 3);
  assert.equal(await countDe("datacenter"), 3);
  assert.equal(await countDe("subestacion"), 3);
});

test("la búsqueda para un hospital solo devuelve incidentes de la colección hospital", async () => {
  const res = await rag.buscar("hospital", "corte de suministro en urgencias", 10);

  assert.ok(res.length > 0, "la búsqueda debe devolver resultados");
  assert.ok(res.length <= 10);
  for (const { incidente } of res) {
    assert.equal(incidente.tipo, "hospital");
  }
  assert.ok(
    res.some(({ incidente }) => incidente.id === "hist-hosp-001"),
    "el histórico precargado debe estar entre los resultados",
  );
});

test("el cierre del bucle registra el incidente resuelto y no duplica re-cierres", async () => {
  const cierre: CierreIncidente = {
    elementoId: "sub-01",
    tipo: "subestacion",
    nombre: "Subestación Getafe-Sur",
    severidadMaxima: 90,
    reloj: "2026-09-19T10:05:00.000Z",
  };

  await rag.registrarCierre(cierre);
  const trasPrimero = await countDe("subestacion");
  await rag.registrarCierre(cierre);
  const trasRepetir = await countDe("subestacion");

  assert.equal(trasPrimero, 4);
  assert.equal(trasRepetir, 4);

  const res = await rag.buscar("subestacion", "apagón resuelto en la subestación", 10);
  assert.ok(
    res.some(({ incidente }) => incidente.id.startsWith("cierre-sub-01-")),
    "el cierre vectorizado debe ser recuperable",
  );
});
