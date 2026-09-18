import express from "express";
import type { HealthResponse } from "@reto/shared";

const app = express();
app.use(express.json());

const port = process.env.PORT ?? 3001;

app.get("/api/health", (_req, res) => {
  const health: HealthResponse = { status: "ok", tick: 0, pausado: false };
  res.json(health);
});

app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
