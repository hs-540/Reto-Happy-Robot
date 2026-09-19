import type { ChromaClient, Collection, Metadata } from "chromadb";
import {
  HistoricoIncidenteSchema,
  type ElementType,
  type HistoricoIncidente,
} from "@swarmup/shared";
import type { ClienteLlm } from "../llm.js";
import type { CierreIncidente } from "../sim.js";

export interface IncidenteRecuperado {
  incidente: HistoricoIncidente;
  distancia: number;
}

export interface RagHistorico {
  /** Precarga idempotente: upsert por id del incidente, re-ejecutar no duplica. Devuelve el total en colecciones */
  precargar(incidentes: readonly HistoricoIncidente[]): Promise<number>;
  /** Cierra el bucle (momento 5): registra el resultado de un incidente resuelto y lo vectoriza */
  registrarCierre(cierre: CierreIncidente): Promise<void>;
  /** Los k históricos más cercanos, solo de la colección del tipo del elemento afectado */
  buscar(tipo: ElementType, consulta: string, k: number): Promise<IncidenteRecuperado[]>;
}

/** Texto que se vectoriza: todo lo que el agente debe recordar del incidente */
function textoDe(incidente: HistoricoIncidente): string {
  return `${incidente.titulo}. ${incidente.resumen} ${incidente.resultado}`;
}

/** Colección por tipo de elemento; embeddings propios vía gateway, no la función embebida por defecto */
async function coleccionDe(cliente: ChromaClient, tipo: ElementType): Promise<Collection> {
  return cliente.getOrCreateCollection({ name: tipo, embeddingFunction: null });
}

async function subir(
  coleccion: Collection,
  incidentes: readonly HistoricoIncidente[],
  llm: ClienteLlm,
): Promise<void> {
  if (incidentes.length === 0) return;
  const textos = incidentes.map(textoDe);
  const embeddings = await llm.embeddings(textos);
  await coleccion.upsert({
    ids: incidentes.map((i) => i.id),
    embeddings,
    documents: textos,
    metadatas: incidentes.map((i) => ({ ...i })),
  });
}

function incidenteDe(metadata: Metadata | null, id: string): HistoricoIncidente | null {
  const parsed = HistoricoIncidenteSchema.safeParse(metadata);
  if (!parsed.success) {
    console.error(`[rag] el registro '${id}' del histórico tiene metadatos inválidos`);
    return null;
  }
  return parsed.data;
}

export function crearRagHistorico(deps: { cliente: ChromaClient; llm: ClienteLlm }): RagHistorico {
  const { cliente, llm } = deps;

  async function precargar(incidentes: readonly HistoricoIncidente[]): Promise<number> {
    const porTipo = new Map<ElementType, HistoricoIncidente[]>();
    for (const incidente of incidentes) {
      const lista = porTipo.get(incidente.tipo) ?? [];
      lista.push(incidente);
      porTipo.set(incidente.tipo, lista);
    }
    let total = 0;
    for (const [tipo, lista] of porTipo) {
      const coleccion = await coleccionDe(cliente, tipo);
      await subir(coleccion, lista, llm);
      total += await coleccion.count();
    }
    return total;
  }

  async function registrarCierre(cierre: CierreIncidente): Promise<void> {
    const fecha = new Date().toISOString().slice(0, 10);
    // id determinista por elemento y día: re-cerrar el mismo incidente no duplica
    const incidente: HistoricoIncidente = {
      id: `cierre-${cierre.elementoId}-${fecha}`,
      tipo: cierre.tipo,
      titulo: `Cierre del incidente en ${cierre.nombre} — ${fecha}`,
      resumen: `Incidente de ${cierre.tipo} resuelto durante la operación; severidad máxima alcanzada ${Math.round(cierre.severidadMaxima)}/100.`,
      resultado: `Elemento estable y dado por resuelto en el reloj de simulación ${cierre.reloj}.`,
      fecha,
    };
    await subir(await coleccionDe(cliente, cierre.tipo), [incidente], llm);
  }

  async function buscar(
    tipo: ElementType,
    consulta: string,
    k: number,
  ): Promise<IncidenteRecuperado[]> {
    const coleccion = await coleccionDe(cliente, tipo);
    const [vector] = await llm.embeddings([consulta]);
    if (!vector) return [];
    const res = await coleccion.query({ queryEmbeddings: [vector], nResults: k });
    const ids = res.ids[0] ?? [];
    const recuperados: IncidenteRecuperado[] = [];
    for (const [i, id] of ids.entries()) {
      const distancia = res.distances[0]?.[i];
      const incidente = incidenteDe(res.metadatas[0]?.[i] ?? null, id);
      if (distancia === null || distancia === undefined || incidente === null) continue;
      recuperados.push({ incidente, distancia });
    }
    return recuperados;
  }

  return { precargar, registrarCierre, buscar };
}
