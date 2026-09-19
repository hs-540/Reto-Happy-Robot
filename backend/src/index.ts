import express from "express";
import { z } from "zod";
import type {
  AgentView,
  ControlResponse,
  FeedResponse,
  HealthResponse,
  HistoricoIncidente,
  StateView,
  TopologyView,
} from "@swarmup/shared";
import { cargarHistorico, cargarRemedios, cargarTopologia } from "@swarmup/shared";
import { crearAgente } from "./agente.js";
import { config, redactSecrets } from "./config.js";
import { crearRegistroAcciones, esquemaControl } from "./control.js";
import { crearFeed, parsearSince } from "./feed.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { crearClienteHappyRobot } from "./happyrobot.js";
import { crearClienteLlm } from "./llm.js";
import { crearMundo } from "./mundo.js";
import { arrancarChroma } from "./rag/chroma.js";
import { crearRagHistorico, type RagHistorico } from "./rag/historico.js";
import { crearSimulacion, type CierreIncidente } from "./sim.js";

const raiz = new URL("../../", import.meta.url);
const guion = cargarGuion(new URL("data/scripts/apagon-madrid.json", raiz));
const feed = crearFeed();
/** Hechos físicos del escenario: qué depende de qué y qué arregla qué */
const grafoTopologia = cargarTopologia(new URL("data/topologia.json", raiz).pathname);
const remedios = cargarRemedios(new URL("data/remedios.json", raiz).pathname);

const mundo = crearMundo(guion, remedios, grafoTopologia);

/** Chroma local (RAG): si no arranca, la demo sigue sin cierre del bucle */
const ragListo: Promise<RagHistorico | null> = arrancarChroma({
  ruta: config.chroma.path,
  puerto: config.chroma.port,
})
  .then((chroma) =>
    crearRagHistorico({ cliente: chroma.cliente, llm: crearClienteLlm(config.llm.gateways) }),
  )
  .catch((err: unknown) => {
    console.error(
      `[rag] Chroma no disponible, los incidentes resueltos no se registrarán: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    );
    return null;
  });

function alResolver(cierre: CierreIncidente): void {
  void ragListo.then((rag) => {
    if (!rag) return;
    rag
      .registrarCierre(cierre)
      .then(() => console.log(`[rag] cierre registrado en el histórico: ${cierre.elementoId}`))
      .catch((err: unknown) => {
        console.error(
          `[rag] no se pudo registrar el cierre de ${cierre.elementoId}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        );
      });
  });
}

const sim = crearSimulacion(guion, Date.now(), feed, mundo, alResolver, (reporte) =>
  agente.encolarReporte(reporte),
);
const registroAcciones = crearRegistroAcciones(feed);
const topologia: TopologyView = aTopologia(guion);

/** Histórico pre-cargado por tipo de sitio: contexto del agente desde el primer tick */
const historico: HistoricoIncidente[] = ["hospital", "datacenter", "subestacion"].flatMap((tipo) =>
  cargarHistorico(new URL(`data/history/${tipo}/incidentes.json`, raiz).pathname),
);

/**
 * El canal hacia el mundo real. Se crea antes que el agente y recibe el cierre
 * por callback: una llamada tarda un minuto en resolverse y el motor no espera.
 */
const happyrobot = crearClienteHappyRobot({
  apiKey: config.happyrobot.apiKey,
  baseUrl: config.happyrobot.baseUrl,
  alCerrar: (cierre) => agente.cerrarLlamada(cierre),
});

const agente = crearAgente({
  mundo,
  feed,
  llm: crearClienteLlm(config.llm.gateways),
  registroAcciones,
  happyrobot,
  historico,
  topologia: grafoTopologia,
  remedios,
  segundos: () => sim.segundos(),
});

/**
 * Un tick del sistema: la sim aplica los eventos del guion vencidos y el mundo
 * avanza el estado físico sobre esa foto. Los eventos que devuelve `mundo` son
 * triggers de replanificación (RULES.md §7) y los consumirá el motor de decisión.
 */
function avanzar(): void {
  sim.avanzar(Date.now());
  const eventos = mundo.avanzar(sim.segundos(), sim.estado().elementos);
  for (const ev of eventos) {
    if (ev.tipo === "llegada") {
      feed.publicar({ kind: "sistema", mensaje: `${ev.recursoId} ha llegado a ${ev.elementId}` });
    } else if (ev.tipo === "remedio_aplicado") {
      // la acción del agente cambia el mundo: se aplica como una lectura real
      sim.inyectar({
        elementId: ev.elementId,
        metric: ev.metric,
        value: ev.value,
        severidad: ev.severidad,
      });
      feed.publicar({
        kind: "sistema",
        mensaje: `${ev.recursoId} surte efecto en ${ev.elementId}: ${ev.efecto}`,
      });
    } else if (ev.tipo === "recuperacion") {
      // silenciosa: no ensucia el feed, pero el mundo mejora de verdad
      sim.inyectar({
        elementId: ev.elementId,
        metric: ev.metric,
        value: ev.value,
        severidad: ev.severidad,
      });
    } else if (ev.tipo === "eta_incumplida") {
      feed.publicar({
        kind: "sistema",
        mensaje: `${ev.recursoId} no cumple su ETA hacia ${ev.elementId} (+${ev.retrasoSeg}s)`,
      });
    } else {
      feed.publicar({
        kind: "sistema",
        mensaje: `${ev.elementId} supera su límite sin energía (${ev.minutosSinEnergia} min)`,
      });
    }
  }
  // el motor decide sobre la foto ya avanzada; no se espera a que termine
  void agente.observar(estadoCompleto(), eventos);
}

/** `atencion` es derivada y la calcula el backend (CONTRACT.md, regla de oro 5) */
function estadoCompleto(): StateView {
  const estado = sim.estado();
  return {
    ...estado,
    elementos: estado.elementos.map((e) => ({ ...e, atencion: agente.atencion(e.id) })),
  };
}

const app = express();
app.use(express.json());

function respuestaError(error: string): ControlResponse {
  return { ok: false, error };
}

app.get("/api/topology", (_req, res) => {
  res.json(topologia);
});

app.get("/api/state", (_req, res) => {
  avanzar();
  res.json(estadoCompleto());
});

app.get("/api/agent", (_req, res) => {
  avanzar();
  const vista: AgentView = { ...agente.vista(), tick: sim.tick(), pausado: sim.pausado };
  res.json(vista);
});

app.get("/api/feed", (req, res) => {
  const since = parsearSince(req.query.since);
  if (since === null) {
    res.status(400).json({ error: "since debe ser un entero >= 0" });
    return;
  }
  const respuesta: FeedResponse = { items: feed.desde(since), ultimoSeq: feed.ultimoSeq() };
  res.json(respuesta);
});

app.get("/api/health", (_req, res) => {
  avanzar();
  const health: HealthResponse = {
    status: "ok",
    tick: sim.tick(),
    pausado: sim.pausado,
    iniciado: sim.iniciado,
  };
  res.json(health);
});

/**
 * Camino de vuelta de una llamada real. HappyRobot lo invoca al colgar con lo
 * que contestó la persona; si se negó o pidió más tiempo, `retrasoMinutos`
 * invalida el ETA del plan y el agente replanifica en el siguiente tick.
 */
const esquemaCierreLlamada = z.object({
  actionId: z.string().min(1),
  resultado: z.enum(["aceptado", "aceptado_con_retraso", "rechazado", "no_contesta"]),
  retrasoMinutos: z.number().int().min(0).nullable().default(null),
  compromiso: z.string().min(1).nullable().default(null),
  resumen: z.string().min(1),
});

app.post("/api/llamada/resultado", (req, res) => {
  avanzar();
  const parsed = esquemaCierreLlamada.safeParse(req.body);
  if (!parsed.success) {
    const detalles = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    res.status(400).json(respuestaError(`cuerpo inválido: ${detalles}`));
    return;
  }
  agente.cerrarLlamada(parsed.data);
  res.json({ ok: true });
});

app.post("/api/control", (req, res) => {
  avanzar();
  const parsed = esquemaControl.safeParse(req.body);
  if (!parsed.success) {
    const detalles = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    res.status(400).json(respuestaError(`cuerpo inválido: ${detalles}`));
    return;
  }
  const body = parsed.data;
  switch (body.accion) {
    case "iniciar":
      sim.iniciar(Date.now());
      break;
    case "reiniciar":
      sim.reiniciar();
      agente.reiniciar();
      break;
    case "pausar":
      sim.pausar();
      break;
    case "reanudar":
      sim.reanudar();
      break;
    case "inyectar":
      try {
        sim.inyectar(body.payload);
      } catch (err) {
        res.status(400).json(respuestaError(err instanceof Error ? err.message : String(err)));
        return;
      }
      break;
  }
  res.json({ ok: true });
});

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(`[backend] ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  res.status(500).json({ error: "Error interno del servidor" });
};

app.use(errorHandler);

setInterval(avanzar, config.tickMs);

app.listen(config.port, () => {
  console.log(`Backend escuchando en http://localhost:${config.port}`);
});
