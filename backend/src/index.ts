import express from "express";
import type { HealthResponse } from "@reto/shared";
import { config, redactSecrets } from "./config.js";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const health: HealthResponse = { status: "ok", tick: 0, pausado: false };
  res.json(health);
});

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(`[backend] ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  res.status(500).json({ error: "Error interno del servidor" });
};

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Backend escuchando en http://localhost:${config.port}`);
});
