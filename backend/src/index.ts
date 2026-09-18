import express from "express";
import type { Element } from "@reto/shared";

const app = express();
app.use(express.json());

const port = process.env.PORT ?? 3001;

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/elements", (_req, res) => {
  const elements: Element[] = [];
  res.json(elements);
});

app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
