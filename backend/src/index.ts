import express from "express";
import type {
  AgentView,
  ControlResponse,
  FeedResponse,
  HealthResponse,
  HistoricoIncidente,
  StateView,
  TopologyView,
} from "@swarmup/shared";
import { cargarHistorico } from "@swarmup/shared";
import { crearAgente } from "./agente.js";
import { config, redactSecrets } from "./config.js";
import { crearRegistroAcciones, esquemaControl } from "./control.js";
import { crearFeed, parsearSince } from "./feed.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { crearClienteLlm } from "./llm.js";
import { crearMundo } from "./mundo.js";
import { crearSimulacion } from "./sim.js";

const raiz = new URL("../../", import.meta.url);
const guion = cargarGuion(new URL("data/scripts/apagon-madrid.json", raiz));
const feed = crearFeed();
const mundo = crearMundo(guion);
const sim = crearSimulacion(guion, Date.now(), feed, mundo);
const registroAcciones = crearRegistroAcciones(feed);
const topologia: TopologyView = aTopologia(guion);

/** Histórico pre-cargado por tipo de sitio: contexto del agente desde el primer tick */
const historico: HistoricoIncidente[] = ["hospital", "datacenter", "subestacion"].flatMap((tipo) =>
  cargarHistorico(new URL(`data/history/${tipo}/incidentes.json`, raiz).pathname),
);

const agente = crearAgente({
  mundo,
  feed,
  llm: crearClienteLlm(config.llm.gateways),
  registroAcciones,
  historico,
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
