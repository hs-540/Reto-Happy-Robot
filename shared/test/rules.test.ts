import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPACIDAD_RECURSOS,
  MAX_MINUTOS_SIN_ENERGIA,
  REGLAS_PARA_AGENTE,
  calcularPrioridad,
  derivarStatus,
  derivarStatusElemento,
  derivarStatusMetrica,
  validarAccion,
  type ContextoValidacion,
  type ElementoValidacion,
  type RecursoValidacion,
} from "../src/rules.js";

function elemento(
  id: string,
  type: ElementoValidacion["type"],
  overrides: Partial<Omit<ElementoValidacion, "id" | "type">> = {},
): ElementoValidacion {
  return {
    id,
    type,
    status: "normal",
    metricas: {},
    sinEnergiaSegundos: 0,
    ...overrides,
  };
}

function recurso(
  id: string,
  type: RecursoValidacion["type"],
  overrides: Partial<Omit<RecursoValidacion, "id" | "type">> = {},
): RecursoValidacion {
  return {
    id,
    type,
    status: "disponible",
    assignedElementId: null,
    ...overrides,
  };
}

function reglaDe(r: ReturnType<typeof validarAccion>) {
  return r.permitido === false ? r.regla : null;
}

test("capacidades y límites del catálogo", () => {
  assert.equal(CAPACIDAD_RECURSOS.cuadrilla, 1);
  assert.equal(CAPACIDAD_RECURSOS.generador, 2);
  assert.equal(MAX_MINUTOS_SIN_ENERGIA.hospital, 8);
  assert.equal(MAX_MINUTOS_SIN_ENERGIA.datacenter, 12);
  assert.equal(MAX_MINUTOS_SIN_ENERGIA.subestacion, 20);
});

test("cortes de severidad → status", () => {
  assert.equal(derivarStatus(29), "normal");
  assert.equal(derivarStatus(30), "degradado");
  assert.equal(derivarStatus(59), "degradado");
  assert.equal(derivarStatus(60), "critico");
});

test("umbrales por métrica (eventos del guion)", () => {
  assert.equal(derivarStatusMetrica("tension_red", 12), "critico");
  assert.equal(derivarStatusMetrica("temperatura", 41), "degradado");
  assert.equal(derivarStatusMetrica("temperatura", 45), "critico");
  assert.equal(derivarStatusMetrica("carga_ups", 12), "critico");
  assert.equal(derivarStatusMetrica("carga_ups", 90), "normal");
});

test("status final: el peor entre severidad y métricas", () => {
  assert.equal(derivarStatusElemento(10, { temperatura: 46 }), "critico");
  assert.equal(derivarStatusElemento(35, { carga_ups: 90 }), "degradado");
});

test("sin-doble-asignacion: rechaza recurso ocupado o inexistente", () => {
  const ctx: ContextoValidacion = {
    elementos: [elemento("hosp-01", "hospital"), elemento("dc-01", "datacenter")],
    recursos: [
      recurso("cuadrilla-1", "cuadrilla", { status: "asignado", assignedElementId: "hosp-01" }),
    ],
  };
  const ocupada = validarAccion(
    { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "cuadrilla-1" },
    ctx,
  );
  assert.equal(ocupada.permitido, false);
  assert.equal(reglaDe(ocupada), "sin-doble-asignacion");

  const inexistente = validarAccion(
    { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "cuadrilla-9" },
    ctx,
  );
  assert.equal(inexistente.permitido, false);
  assert.equal(reglaDe(inexistente), "sin-doble-asignacion");

  const ctxLiberada: ContextoValidacion = {
    elementos: [elemento("hosp-01", "hospital"), elemento("dc-01", "datacenter")],
    recursos: [recurso("cuadrilla-1", "cuadrilla")],
  };
  assert.deepEqual(
    validarAccion(
      { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "cuadrilla-1" },
      ctxLiberada,
    ),
    { permitido: true },
  );
});

test("hospital-prioridad-energia: generadores solo al hospital crítico sin respaldo", () => {
  const ctx: ContextoValidacion = {
    elementos: [
      elemento("hosp-01", "hospital", { status: "critico", sinEnergiaSegundos: 120 }),
      elemento("dc-01", "datacenter", { status: "degradado" }),
    ],
    recursos: [recurso("generador-1", "generador")],
  };
  const alDatacenter = validarAccion(
    { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "generador-1" },
    ctx,
  );
  assert.equal(alDatacenter.permitido, false);
  assert.equal(reglaDe(alDatacenter), "hospital-prioridad-energia");

  assert.deepEqual(
    validarAccion({ tipo: "asignar_recurso", elementId: "hosp-01", recursoId: "generador-1" }, ctx),
    { permitido: true },
  );
});

test("hospital-plazo-energia: superado el límite solo se actúa en el hospital o la subestación crítica", () => {
  const ctx: ContextoValidacion = {
    elementos: [
      elemento("hosp-01", "hospital", {
        status: "critico",
        sinEnergiaSegundos: (MAX_MINUTOS_SIN_ENERGIA.hospital + 1) * 60,
      }),
      elemento("dc-01", "datacenter", { status: "degradado" }),
      elemento("sub-01", "subestacion", { status: "critico" }),
    ],
    recursos: [recurso("cuadrilla-1", "cuadrilla"), recurso("generador-1", "generador")],
  };
  const esperarDatacenter = validarAccion({ tipo: "esperar", elementId: "dc-01" }, ctx);
  assert.equal(esperarDatacenter.permitido, false);
  assert.equal(reglaDe(esperarDatacenter), "hospital-plazo-energia");

  const alDatacenter = validarAccion(
    { tipo: "asignar_recurso", elementId: "dc-01", recursoId: "cuadrilla-1" },
    ctx,
  );
  assert.equal(alDatacenter.permitido, false);
  assert.equal(reglaDe(alDatacenter), "hospital-plazo-energia");

  assert.deepEqual(
    validarAccion({ tipo: "asignar_recurso", elementId: "hosp-01", recursoId: "cuadrilla-1" }, ctx),
    { permitido: true },
  );
  assert.deepEqual(
    validarAccion({ tipo: "asignar_recurso", elementId: "sub-01", recursoId: "cuadrilla-1" }, ctx),
    { permitido: true },
  );
  const generadorALaSubestacion = validarAccion(
    { tipo: "asignar_recurso", elementId: "sub-01", recursoId: "generador-1" },
    ctx,
  );
  assert.equal(generadorALaSubestacion.permitido, false);
  assert.equal(reglaDe(generadorALaSubestacion), "hospital-prioridad-energia");
  assert.deepEqual(validarAccion({ tipo: "esperar", elementId: "hosp-01" }, ctx), {
    permitido: true,
  });
});

test("ups-critica-actuar: esperar prohibido con carga_ups baja", () => {
  const ctx: ContextoValidacion = {
    elementos: [
      elemento("hosp-01", "hospital"),
      elemento("dc-01", "datacenter", { status: "critico", metricas: { carga_ups: 10 } }),
    ],
    recursos: [recurso("generador-1", "generador")],
  };
  const esperar = validarAccion({ tipo: "esperar", elementId: "dc-01" }, ctx);
  assert.equal(esperar.permitido, false);
  assert.equal(reglaDe(esperar), "ups-critica-actuar");

  assert.deepEqual(
    validarAccion({ tipo: "asignar_recurso", elementId: "dc-01", recursoId: "generador-1" }, ctx),
    { permitido: true },
  );
  assert.deepEqual(validarAccion({ tipo: "contactar", elementId: "dc-01" }, ctx), {
    permitido: true,
  });
});

test("calcularPrioridad: hospital crítico sin energía gana al datacenter degradado", () => {
  const hospital = calcularPrioridad({
    type: "hospital",
    status: "critico",
    criticidad: 95,
    sinEnergiaSegundos: 10 * 60,
  });
  const datacenter = calcularPrioridad({
    type: "datacenter",
    status: "degradado",
    criticidad: 60,
    sinEnergiaSegundos: 0,
  });
  const subestacion = calcularPrioridad({
    type: "subestacion",
    status: "normal",
    criticidad: 70,
    sinEnergiaSegundos: 0,
  });

  assert.equal(hospital, 0.5 * 95 + 60 + 30 + 2 * 10);
  assert.equal(datacenter, 0.5 * 60 + 20 + 10);
  assert.ok(hospital > datacenter);
  assert.ok(datacenter > subestacion);
});

test("REGLAS_PARA_AGENTE es serializable para inyectar en el prompt del LLM", () => {
  const json = JSON.parse(JSON.stringify(REGLAS_PARA_AGENTE));
  assert.equal(json.reglasBloqueantes.length, 4);
  assert.equal(json.prioridad.ordenTipos[0], "hospital");
  assert.equal(json.limitesSinEnergiaMin.hospital, MAX_MINUTOS_SIN_ENERGIA.hospital);
});
