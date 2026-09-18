import express from "express";
import { z } from "zod";
import { SensorEventSchema } from "@reto/shared";
import type { ControlResponse, FeedResponse, HealthResponse, TopologyView } from "@reto/shared";
import { config, redactSecrets } from "./config.js";
import { crearFeed, parsearSince } from "./feed.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { crearSimulacion } from "./sim.js";

const guion = cargarGuion(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const feed = crearFeed();
const sim = crearSimulacion(guion, Date.now(), feed);
const topologia: TopologyView = aTopologia(guion);

const app = express();
app.use(express.json());

const ControlBodySchema = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("iniciar") }),
  z.object({ accion: z.literal("reiniciar") }),
  z.object({ accion: z.literal("pausar") }),
  z.object({ accion: z.literal("reanudar") }),
  z.object({ accion: z.literal("confirmar"), id: z.string().min(1) }),
  z.object({ accion: z.literal("rechazar"), id: z.string().min(1) }),
  z.object({ accion: z.literal("inyectar"), payload: SensorEventSchema.omit({ id: true }) }),
]);

function respuestaError(error: string): ControlResponse {
  return { ok: false, error };
}

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
  const health: HealthResponse = {
    status: "ok",
    tick: sim.tick(),
    pausado: sim.pausado,
    iniciado: sim.iniciado,
  };
  res.json(health);
});

app.post("/api/control", (req, res) => {
  sim.avanzar(Date.now());
  const parsed = ControlBodySchema.safeParse(req.body);
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
    case "confirmar":
    case "rechazar":
      // el motor de decisiones (issue del agente) aún no registra acciones vivas
      res
        .status(409)
        .json(respuestaError(`no hay ninguna acción viva '${body.id}' que ${body.accion}`));
      return;
  }
  res.json({ ok: true });
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
