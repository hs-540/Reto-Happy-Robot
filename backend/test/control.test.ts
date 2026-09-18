import assert from "node:assert/strict";
import { test } from "node:test";
import { crearRegistroAcciones, esquemaControl } from "../src/control.js";
import { crearFeed } from "../src/feed.js";

function montar() {
  const feed = crearFeed();
  const registro = crearRegistroAcciones(feed);
  const proponerLlamada = () =>
    registro.proponer({
      type: "llamada_voz",
      targetElementId: "hosp-01",
      destinatario: "responsable_hospital",
      mensaje: "Cortaremos suministro 10 min para conectar el generador.",
    });
  return { feed, registro, proponerLlamada };
}

function estadosDeAccion(feed: ReturnType<typeof crearFeed>): string[] {
  return feed
    .desde(0)
    .filter((i) => i.kind === "accion")
    .map((i) => (i.kind === "accion" ? i.estado : ""));
}

test("toda acción se registra ya ejecutada, sin gate humano", () => {
  const { feed, registro, proponerLlamada } = montar();

  const accion = proponerLlamada();
  assert.equal(accion.status, "ejecutada");
  assert.ok(accion.id.startsWith("act-"));
  assert.deepEqual(estadosDeAccion(feed), ["ejecutada"]);
});

test("esquemaControl valida las acciones de control y el payload de inyectar", () => {
  assert.ok(esquemaControl.safeParse({ accion: "iniciar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "reiniciar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "pausar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "reanudar" }).success);
  assert.ok(!esquemaControl.safeParse({ accion: "confirmar", id: "act-007" }).success);
  assert.ok(!esquemaControl.safeParse({ accion: "arrancar" }).success);

  const inyeccion = {
    accion: "inyectar",
    payload: { elementId: "dc-01", metric: "temperatura", value: 55, severidad: 80 },
  };
  assert.ok(esquemaControl.safeParse(inyeccion).success);
  assert.ok(
    !esquemaControl.safeParse({ ...inyeccion, payload: { ...inyeccion.payload, metric: "presion" } })
      .success,
  );
  assert.ok(
    !esquemaControl.safeParse({ ...inyeccion, payload: { ...inyeccion.payload, severidad: 101 } })
      .success,
  );
  assert.ok(!esquemaControl.safeParse({ accion: "inyectar" }).success);
});
