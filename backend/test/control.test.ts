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

test("toda acción nace propuesta y solo confirmar la lleva a ejecutada", () => {
  const { feed, registro, proponerLlamada } = montar();

  const accion = proponerLlamada();
  assert.equal(accion.status, "propuesta");
  assert.ok(accion.id.startsWith("act-"));
  assert.deepEqual(estadosDeAccion(feed), ["propuesta"]);

  const resultado = registro.confirmar(accion.id);
  assert.ok(resultado.ok);
  assert.equal(resultado.accion.status, "ejecutada");
  assert.deepEqual(estadosDeAccion(feed), ["propuesta", "confirmada", "ejecutada"]);
});

test("sin pulsar confirmar la acción sigue propuesta: nada se ejecuta", () => {
  const { registro, proponerLlamada } = montar();
  const accion = proponerLlamada();
  // el único productor de `ejecutada` es confirmar; proponer nunca ejecuta
  assert.equal(registro.rechazar(accion.id).ok, true);
});

test("rechazar solo vale en propuesta y cierra el gate", () => {
  const { registro, proponerLlamada } = montar();
  const accion = proponerLlamada();

  const rechazo = registro.rechazar(accion.id);
  assert.ok(rechazo.ok);
  assert.equal(rechazo.accion.status, "rechazada");

  assert.deepEqual(registro.rechazar(accion.id), { ok: false, razon: "no_propuesta" });
  assert.deepEqual(registro.confirmar(accion.id), { ok: false, razon: "no_propuesta" });
});

test("confirmar o rechazar una acción desconocida no toca el gate", () => {
  const { registro } = montar();
  assert.deepEqual(registro.confirmar("act-999"), { ok: false, razon: "desconocida" });
  assert.deepEqual(registro.rechazar("act-999"), { ok: false, razon: "desconocida" });
});

test("esquemaControl exige id en confirmar/rechazar y payload válido en inyectar", () => {
  assert.ok(esquemaControl.safeParse({ accion: "iniciar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "reiniciar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "pausar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "reanudar" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "confirmar", id: "act-007" }).success);
  assert.ok(esquemaControl.safeParse({ accion: "rechazar", id: "act-007" }).success);

  assert.ok(!esquemaControl.safeParse({ accion: "confirmar" }).success);
  assert.ok(!esquemaControl.safeParse({ accion: "rechazar", id: "" }).success);
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
