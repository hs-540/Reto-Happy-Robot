import express from "express";
import type { FeedResponse, HealthResponse, TopologyView } from "@reto/shared";
import { crearFeed, parsearSince } from "./feed.js";
import { aTopologia, cargarGuion } from "./guion.js";
import { TICK_SEGUNDOS, crearSimulacion } from "./sim.js";

const guion = cargarGuion(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const feed = crearFeed();
const sim = crearSimulacion(guion, Date.now(), feed);
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

setInterval(() => sim.avanzar(Date.now()), TICK_SEGUNDOS * 1000);

app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
