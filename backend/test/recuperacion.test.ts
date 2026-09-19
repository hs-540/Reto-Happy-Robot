import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargarRemedios, cargarTopologia, type ElementView } from "@swarmup/shared";
import { crearMundo } from "../src/mundo.js";
import { cargarGuion } from "../src/guion.js";

const raiz = new URL("../../", import.meta.url);
const guion = cargarGuion(new URL("data/scripts/apagon-madrid.json", raiz));
const remedios = cargarRemedios(fileURLToPath(new URL("data/remedios.json", raiz)));
const topologia = cargarTopologia(fileURLToPath(new URL("data/topologia.json", raiz)));

function torre(sensores: ElementView["sensores"]): ElementView {
  return {
    id: "torre-01",
    type: "torre",
    name: "Torre",
    lat: 40.3125,
    lng: -3.7285,
    status: "degradado",
    severidad: 40,
    sensores,
    atencion: { estado: "sin_atencion", recursoId: null, decisionActivaId: null },
    actualizadoEn: new Date().toISOString(),
  };
}

test("con la red restaurada, la batería de la torre se recarga sola", () => {
  const mundo = crearMundo(guion, remedios, topologia);
  const sensores = { tension_red: 96, bateria_torre: 21 };
  const vistos: number[] = [];

  for (let t = 60; t <= 600; t += 60) {
    for (const ev of mundo.avanzar(t, [torre(sensores)])) {
      if (ev.tipo === "recuperacion" && ev.metric === "bateria_torre") {
        sensores.bateria_torre = ev.value;
        vistos.push(ev.value);
      }
    }
  }

  assert.ok(vistos.length > 0, "debería emitir pasos de recuperación");
  assert.ok(
    vistos.every((v, i) => i === 0 || v > vistos[i - 1]),
    `la batería debe subir monótonamente, salió ${vistos.join(" → ")}`,
  );
  assert.ok(sensores.bateria_torre >= 90, `se queda en ${sensores.bateria_torre}, debería llegar a ~95`);
});

test("sin red, nada se recupera: la avería sigue siendo una avería", () => {
  const mundo = crearMundo(guion, remedios, topologia);
  const sensores = { tension_red: 8, bateria_torre: 21 };
  let pasos = 0;
  for (let t = 60; t <= 600; t += 60) {
    for (const ev of mundo.avanzar(t, [torre(sensores)])) {
      if (ev.tipo === "recuperacion") pasos++;
    }
  }
  assert.equal(pasos, 0, "sin tensión de red no puede recargarse nada");
});

test("el combustible NO se recupera solo: hace falta la cisterna", () => {
  const mundo = crearMundo(guion, remedios, topologia);
  const sensores = { tension_red: 96, combustible: 22 };
  let pasos = 0;
  for (let t = 60; t <= 600; t += 60) {
    for (const ev of mundo.avanzar(t, [{ ...torre(sensores), sensores }])) {
      if (ev.tipo === "recuperacion" && ev.metric === "combustible") pasos++;
    }
  }
  assert.equal(pasos, 0, "un depósito no se llena porque vuelva la luz");
});

test("un recurso en ruta ya cubre el sitio: se distingue de uno desplegado", () => {
  const mundo = crearMundo(guion, remedios, topologia);
  assert.equal(mundo.asignar("generador-1", "hosp-01", 0).ok, true);

  const enRuta = mundo.recursos().find((r) => r.id === "generador-1");
  assert.equal(enRuta?.status, "en_transito");
  assert.equal(enRuta?.assignedElementId, "hosp-01");

  // tras el trayecto pasa a desplegado, no antes
  const elementos = [torre({ tension_red: 8 })];
  for (let t = 60; t <= 1200; t += 60) mundo.avanzar(t, elementos);
  assert.equal(mundo.recursos().find((r) => r.id === "generador-1")?.status, "asignado");
});
