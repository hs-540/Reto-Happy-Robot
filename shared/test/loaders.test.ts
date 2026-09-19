import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cargarGuion, cargarHistorico, parseGuion } from "../src/loaders.js";

const rutaGuion = fileURLToPath(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));

const rutaHistorico = (tipo: string) =>
  fileURLToPath(new URL(`../../data/history/${tipo}/incidentes.json`, import.meta.url));

test("el guion actual valida sin errores", () => {
  const guion = cargarGuion(rutaGuion);
  assert.equal(guion.titulo, "Apagón regional — Getafe, Comunidad de Madrid");
  assert.equal(guion.duracionSegundos, 300);
  assert.equal(guion.elements.length, 3);
  assert.equal(guion.resources.length, 3);
  assert.equal(guion.timeline.length, 10);
});

test("los históricos actuales validan sin errores", () => {
  for (const tipo of ["hospital", "datacenter", "subestacion"]) {
    const incidentes = cargarHistorico(rutaHistorico(tipo));
    assert.equal(incidentes.length, 3);
    assert.ok(incidentes.every((i) => i.tipo === tipo));
  }
});

test("un campo inválido reporta campo y valor recibido", () => {
  const roto = {
    titulo: "Apagón",
    duracionSegundos: 300,
    elements: [],
    resources: [],
    timeline: [
      {
        atSeconds: 0,
        kind: "sensor_event",
        payload: {
          id: "evt-001",
          elementId: "sub-01",
          metric: "tension_red",
          value: 12,
          severidad: "muy alta",
        },
      },
    ],
  };
  assert.throws(() => parseGuion(roto), /timeline\.0\.payload\.severidad/);
  assert.throws(() => parseGuion(roto), /recibido: "muy alta"/);
});

test("un JSON malformado falla con mensaje accionable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarmup-data-"));
  try {
    const ruta = path.join(dir, "roto.json");
    writeFileSync(ruta, "{ titulo: roto }", "utf8");
    assert.throws(() => cargarGuion(ruta), /roto\.json' no es JSON válido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
