import express from "express";
import type { HealthResponse, TopologyView } from "@reto/shared";
import { config, redactSecrets } from "./config.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { crearSimulacion } from "./sim.js";

const guion = cargarGuion(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const sim = crearSimulacion(guion, Date.now());
const topologia: TopologyView = aTopologia(guion);

const app = express();
app.use(express.json());

app.get("/api/topology", (_req, res) => {
  res.json(topologia);
});

app.get("/api/state", (_req, res) => {
  sim.avanzar(Date.now());
  res.json(sim.estado());
});

app.get("/api/health", (_req, res) => {
  sim.avanzar(Date.now());
  const health: HealthResponse = { status: "ok", tick: sim.tick(), pausado: sim.pausado };
  res.json(health);
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
