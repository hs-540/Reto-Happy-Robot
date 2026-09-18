import express from "express";
import type { HealthResponse, TopologyView } from "@reto/shared";
import { aTopologia, cargarGuion } from "./guion.js";
import { TICK_SEGUNDOS, crearSimulacion } from "./sim.js";

const guion = cargarGuion(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const sim = crearSimulacion(guion, Date.now());
const topologia: TopologyView = aTopologia(guion);

const app = express();
app.use(express.json());

const port = process.env.PORT ?? 3001;

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

setInterval(() => sim.avanzar(Date.now()), TICK_SEGUNDOS * 1000);

app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
