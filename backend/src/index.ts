import express from "express";
import type { HealthResponse } from "@reto/shared";
import { config } from "./config.js";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const health: HealthResponse = { status: "ok", tick: 0, pausado: false };
  res.json(health);
});

app.listen(config.port, () => {
  console.log(`Backend escuchando en http://localhost:${config.port}`);
});
