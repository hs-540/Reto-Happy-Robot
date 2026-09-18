import express from "express";
import type {
  ControlResponse,
  FeedResponse,
  HealthResponse,
  TopologyView,
} from "@reto/shared";
import { config, redactSecrets } from "./config.js";
import { crearRegistroAcciones, esquemaControl, type ResultadoGate } from "./control.js";
import { crearFeed, parsearSince } from "./feed.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { crearSimulacion } from "./sim.js";

const guion = cargarGuion(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const feed = crearFeed();
const sim = crearSimulacion(guion, Date.now(), feed);
const registroAcciones = crearRegistroAcciones(feed);
const topologia: TopologyView = aTopologia(guion);
const idsElementos = new Set(guion.elements.map((e) => e.id));

const app = express();
app.use(express.json());

app.get("/api/topology", (_req, res) => {
  res.json(topologia);
});

app.get("/api/state", (_req, res) => {
  sim.avanzar(Date.now());
  res.json(sim.estado());
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
  sim.avanzar(Date.now());
  const health: HealthResponse = { status: "ok", tick: sim.tick(), pausado: sim.pausado };
  res.json(health);
});

function responderGate(res: express.Response, resultado: ResultadoGate): void {
  if (resultado.ok) {
    res.json({ ok: true } satisfies ControlResponse);
    return;
  }
  const status = resultado.razon === "desconocida" ? 404 : 409;
  const error =
    resultado.razon === "desconocida"
      ? "acción desconocida"
      : "la acción ya no está propuesta, el gate está cerrado";
  res.status(status).json({ ok: false, error } satisfies ControlResponse);
}

app.post("/api/control", (req, res) => {
  const parsed = esquemaControl.safeParse(req.body);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    res.status(400).json({ ok: false, error } satisfies ControlResponse);
    return;
  }
  const cuerpo = parsed.data;
  switch (cuerpo.accion) {
    case "pausar":
      sim.pausar();
      break;
    case "reanudar":
      sim.reanudar();
      break;
    case "confirmar":
      responderGate(res, registroAcciones.confirmar(cuerpo.id));
      return;
    case "rechazar":
      responderGate(res, registroAcciones.rechazar(cuerpo.id));
      return;
    case "inyectar":
      if (!idsElementos.has(cuerpo.payload.elementId)) {
        res
          .status(400)
          .json({ ok: false, error: `elemento desconocido: ${cuerpo.payload.elementId}` } satisfies ControlResponse);
        return;
      }
      sim.inyectar(cuerpo.payload);
      break;
  }
  res.json({ ok: true } satisfies ControlResponse);
});

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(`[backend] ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  res.status(500).json({ error: "Error interno del servidor" });
};

app.use(errorHandler);

setInterval(() => sim.avanzar(Date.now()), config.tickMs);

app.listen(config.port, () => {
  console.log(`Backend escuchando en http://localhost:${config.port}`);
});
