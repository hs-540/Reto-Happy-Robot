import assert from "node:assert/strict";
import test from "node:test";
import type { CierreLlamada, Contacto } from "@swarmup/shared";
import { credencialUsable, crearClienteHappyRobot } from "../src/happyrobot.js";

const jefe: Contacto = {
  id: "jefe-brigada",
  nombre: "Ángel Rivas",
  rol: "Jefe de brigada eléctrica",
  recursoId: "brigada-1",
};

function clienteSimulado(alCerrar: (c: CierreLlamada) => void) {
  return crearClienteHappyRobot({ apiKey: "PENDIENTE", baseUrl: "https://x.test", alCerrar });
}

test("una credencial placeholder no cuenta como usable", () => {
  assert.equal(credencialUsable("PENDIENTE"), false);
  assert.equal(credencialUsable("  "), false);
  assert.equal(credencialUsable("hr_clave_real"), true);
});

test("sin credencial se simula, y la cadena sigue entera", () => {
  assert.equal(clienteSimulado(() => {}).modo, "simulado");
});

test("el jefe de brigada se niega la primera vez y comunica su retraso", async () => {
  const cierres: CierreLlamada[] = [];
  const cliente = clienteSimulado((c) => cierres.push(c));

  cliente.contactar({
    actionId: "act-001",
    contacto: jefe,
    canal: "llamada_voz",
    mensaje: "Abandona el empalme y ve al hospital",
    contexto: { elementId: "sub-01", situacion: "hospital a 4 min de su límite" },
  });

  await new Promise((r) => setTimeout(r, 9_000));
  assert.equal(cierres.length, 1);
  assert.equal(cierres[0].resultado, "rechazado");
  assert.equal(cierres[0].retrasoMinutos, 22, "la negativa tiene que traer su coste en minutos");
  assert.match(cierres[0].resumen, /22 minutos/);
});

test("al insistir, acepta con un retraso menor", async () => {
  const cierres: CierreLlamada[] = [];
  const cliente = clienteSimulado((c) => cierres.push(c));
  const peticion = {
    contacto: jefe,
    canal: "llamada_voz" as const,
    mensaje: "Insisto: el hospital no aguanta",
    contexto: { elementId: "sub-01", situacion: "segundo intento" },
  };

  cliente.contactar({ actionId: "act-001", ...peticion });
  cliente.contactar({ actionId: "act-002", ...peticion });

  await new Promise((r) => setTimeout(r, 9_000));
  assert.deepEqual(
    cierres.map((c) => c.resultado),
    ["rechazado", "aceptado_con_retraso"],
  );
  assert.equal(cierres[1].retrasoMinutos, 8);
});
