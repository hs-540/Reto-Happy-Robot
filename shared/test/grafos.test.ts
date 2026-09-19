import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  UMBRAL_COMBUSTIBLE_CRITICO,
  cargarRemedios,
  cargarTopologia,
  dependientesDe,
  validarAccion,
  type ContextoValidacion,
} from "../src/index.js";

const raiz = new URL("../../", import.meta.url);
const topologia = cargarTopologia(fileURLToPath(new URL("data/topologia.json", raiz)));
const remedios = cargarRemedios(fileURLToPath(new URL("data/remedios.json", raiz)));

test("la topología modela la cascada: caer sub-01 arrastra a todo lo que alimenta", () => {
  const afectados = dependientesDe(topologia, "sub-01");
  for (const id of ["hosp-01", "dc-01", "torre-01", "gas-01", "cruce-01"]) {
    assert.ok(afectados.includes(id), `${id} debería colgar de sub-01`);
  }
});

test("los acoplamientos globales de torre y cruce están declarados", () => {
  const comunicacion = topologia.aristas.find((a) => a.tipo === "habilita_comunicacion");
  const transito = topologia.aristas.find((a) => a.tipo === "habilita_transito");
  assert.equal(comunicacion?.de, "torre-01");
  assert.equal(comunicacion?.a, "*", "la torre habilita la comunicación de todo el escenario");
  assert.equal(transito?.de, "cruce-01");
  assert.equal(transito?.a, "*");
});

test("solo la brigada repara una subestación; el generador no la sustituye", () => {
  const paraSubestacion = remedios.remedios.filter((r) => r.aplicableA.includes("subestacion"));
  assert.deepEqual(
    paraSubestacion.map((r) => r.recurso),
    ["brigada"],
    "una subestación se repara, no se alimenta",
  );
});

test("los remedios con requisito lo declaran explícito", () => {
  const generador = remedios.remedios.find((r) => r.recurso === "generador");
  const cisterna = remedios.remedios.find((r) => r.recurso === "cisterna");
  assert.equal(generador?.requiere, "combustible");
  assert.equal(cisterna?.requiere, "gasolinera_operativa");
});

test("cada contacto apunta a un recurso o a un elemento, nunca al aire", () => {
  for (const c of remedios.contactos) {
    const ambito = c.recursoId ?? c.elementId ?? c.id;
    assert.ok(ambito.length > 0, `${c.id} sin ámbito`);
    assert.ok(c.nombre.length > 0 && c.rol.length > 0, `${c.id} sin nombre o rol`);
  }
  assert.ok(remedios.contactos.some((c) => c.recursoId === "brigada-1"), "falta el jefe de brigada");
});

test("generador-sin-combustible bloquea desplegar un generador seco", () => {
  const contexto: ContextoValidacion = {
    elementos: [
      {
        id: "dc-01",
        type: "datacenter",
        status: "critico",
        metricas: { combustible: UMBRAL_COMBUSTIBLE_CRITICO - 1 },
        sinEnergiaSegundos: 120,
      },
    ],
    recursos: [
      { id: "generador-1", type: "generador", status: "disponible", assignedElementId: null },
    ],
  };
  const veredicto = validarAccion(
    { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "generador-1" },
    contexto,
  );
  assert.equal(veredicto.permitido, false);
  if (!veredicto.permitido) {
    assert.equal(veredicto.regla, "generador-sin-combustible");
    assert.match(veredicto.razon, /cisterna/);
  }
});

test("con combustible por encima del umbral, el mismo despliegue se permite", () => {
  const contexto: ContextoValidacion = {
    elementos: [
      {
        id: "dc-01",
        type: "datacenter",
        status: "critico",
        metricas: { combustible: UMBRAL_COMBUSTIBLE_CRITICO + 50 },
        sinEnergiaSegundos: 120,
      },
    ],
    recursos: [
      { id: "generador-1", type: "generador", status: "disponible", assignedElementId: null },
    ],
  };
  assert.equal(
    validarAccion(
      { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "generador-1" },
      contexto,
    ).permitido,
    true,
  );
});
