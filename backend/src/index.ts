import express from "express";
import type { TopologyView } from "@reto/shared";
import { aTopologia, cargarGuion } from "./guion.js";

const guion = cargarGuion(new URL("../../../data/scripts/apagon-madrid.json", import.meta.url));
const topologia: TopologyView = aTopologia(guion);

const app = express();
app.use(express.json());

const port = process.env.PORT ?? 3001;

app.get("/api/topology", (_req, res) => {
  res.json(topologia);
});

app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
