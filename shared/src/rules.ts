import type {
  ElementStatus,
  ElementType,
  ResourceStatus,
  ResourceType,
  SensorMetric,
} from "./index.js";
import reglasJson from "./rules.json" with { type: "json" };

/* ─── Contrato del catálogo (rules.json es la fuente única de datos) ─── */

export const IDS_REGLAS_BLOQUEANTES = [
  "sin-doble-asignacion",
  "hospital-prioridad-energia",
  "hospital-plazo-energia",
  "ups-critica-actuar",
  "generador-sin-combustible",
] as const;

export type ReglaBloqueanteId = (typeof IDS_REGLAS_BLOQUEANTES)[number];

export interface ReglaBloqueante {
  id: ReglaBloqueanteId;
  regla: string;
}

export interface UmbralesMetrica {
  /** "bajo": peor cuanto más bajo el valor (p. ej. carga_ups). "alto": peor cuanto más alto (p. ej. temperatura) */
  direccion: "bajo" | "alto";
  /** corte de entrada a `degradado` (valor incluido) */
  degradado: number;
  /** corte de entrada a `critico` (valor incluido) */
  critico: number;
}

export interface ReglasCatalogo {
  severidad: { umbralDegradado: number; umbralCritico: number };
  resolucion: { segundosEstables: number; tensionEstable: number };
  umbralesMetrica: Record<SensorMetric, UmbralesMetrica>;
  limitesSinEnergiaMin: Record<ElementType, number>;
  ups: { actuar: number; emergencia: number; bateriaCritica: number };
  recursos: { capacidad: Record<ResourceType, number> };
  prioridad: {
    ordenTipos: readonly ElementType[];
    pesoCriticidad: number;
    pesoStatus: Record<ElementStatus, number>;
    pesoTipo: Record<ElementType, number>;
    pesoMinutoSinEnergia: number;
    maxMinutosContabilizados: number;
  };
  reglasBloqueantes: readonly ReglaBloqueante[];
  triggersReplan: readonly string[];
}

/* ─── Validación al cargar: fail fast si el JSON se edita mal ─── */

const TIPOS_ELEMENTO: readonly ElementType[] = [
  "datacenter",
  "hospital",
  "subestacion",
  "torre",
  "gasolinera",
  "cruce",
];
const TIPOS_RECURSO: readonly ResourceType[] = ["brigada", "generador", "cisterna", "policia"];
const METRICAS: readonly SensorMetric[] = [
  "temperatura",
  "carga_ups",
  "bateria_generador",
  "cobertura_red",
  "tension_red",
  "bateria_torre",
  "combustible",
  "congestion",
];
const STATUS: readonly ElementStatus[] = ["normal", "degradado", "critico", "resuelto"];

function assertRegistroNumerico(
  registro: Record<string, unknown>,
  claves: readonly string[],
  campo: string,
): void {
  const invalidas = claves.filter(
    (k) => !(k in registro) || typeof registro[k] !== "number" || !Number.isFinite(registro[k]),
  );
  if (invalidas.length > 0) {
    throw new Error(`rules.json: claves numéricas inválidas o ausentes en ${campo}: ${invalidas.join(", ")}`);
  }
}

function assertReglas(r: ReglasCatalogo): void {
  assertRegistroNumerico(r.limitesSinEnergiaMin, TIPOS_ELEMENTO, "limitesSinEnergiaMin");
  assertRegistroNumerico(r.prioridad.pesoTipo, TIPOS_ELEMENTO, "prioridad.pesoTipo");
  assertRegistroNumerico(r.prioridad.pesoStatus, STATUS, "prioridad.pesoStatus");
  assertRegistroNumerico(r.recursos.capacidad, TIPOS_RECURSO, "recursos.capacidad");
  assertRegistroNumerico(r.severidad, ["umbralDegradado", "umbralCritico"], "severidad");
  assertRegistroNumerico(r.ups, ["actuar", "emergencia", "bateriaCritica"], "ups");
  if (r.severidad.umbralDegradado >= r.severidad.umbralCritico) {
    throw new Error("rules.json: umbralDegradado debe ser menor que umbralCritico");
  }
  for (const metrica of METRICAS) {
    const u = r.umbralesMetrica[metrica] as unknown as Record<string, unknown>;
    if (
      !u ||
      (u.direccion !== "bajo" && u.direccion !== "alto") ||
      typeof u.degradado !== "number" ||
      typeof u.critico !== "number"
    ) {
      throw new Error(`rules.json: umbralesMetrica.${metrica} inválido`);
    }
  }
  const ids = r.reglasBloqueantes.map((b) => b.id);
  const desconocidos = ids.filter((id) => !IDS_REGLAS_BLOQUEANTES.includes(id));
  const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (desconocidos.length > 0 || duplicados.length > 0) {
    throw new Error(
      `rules.json: reglasBloqueantes con ids desconocidos (${desconocidos.join(", ")}) o duplicados (${duplicados.join(", ")})`,
    );
  }
}

export const REGLAS_PARA_AGENTE: ReglasCatalogo = reglasJson as unknown as ReglasCatalogo;
assertReglas(REGLAS_PARA_AGENTE);

/* ─── Constantes derivadas del catálogo (consumidas por el motor y el agente) ─── */

export const UMBRAL_DEGRADADO = REGLAS_PARA_AGENTE.severidad.umbralDegradado;
export const UMBRAL_CRITICO = REGLAS_PARA_AGENTE.severidad.umbralCritico;

export const SEGUNDOS_ESTABLE_RESUELTO = REGLAS_PARA_AGENTE.resolucion.segundosEstables;
export const TENSION_ESTABLE_RESUELTO = REGLAS_PARA_AGENTE.resolucion.tensionEstable;

export const MAX_MINUTOS_SIN_ENERGIA: Record<ElementType, number> =
  REGLAS_PARA_AGENTE.limitesSinEnergiaMin;

export const UMBRAL_UPS_ACTUAR = REGLAS_PARA_AGENTE.ups.actuar;
export const UMBRAL_UPS_EMERGENCIA = REGLAS_PARA_AGENTE.ups.emergencia;
export const UMBRAL_BATERIA_CRITICA = REGLAS_PARA_AGENTE.ups.bateriaCritica;

/** Litros por debajo de los cuales un generador no puede desplegarse sin repostar */
export const UMBRAL_COMBUSTIBLE_CRITICO = REGLAS_PARA_AGENTE.umbralesMetrica.combustible.critico;

export const UMBRALES_METRICA: Record<SensorMetric, UmbralesMetrica> =
  REGLAS_PARA_AGENTE.umbralesMetrica;

export const CAPACIDAD_RECURSOS: Record<ResourceType, number> =
  REGLAS_PARA_AGENTE.recursos.capacidad;

export const ORDEN_PRIORIDAD: readonly ElementType[] = REGLAS_PARA_AGENTE.prioridad.ordenTipos;

export const TRIGGERS_REPLAN: readonly string[] = REGLAS_PARA_AGENTE.triggersReplan;

export const REGLAS_BLOQUEANTES: readonly ReglaBloqueante[] =
  REGLAS_PARA_AGENTE.reglasBloqueantes;

/* ─── Prioridad numérica: pesos del catálogo, misma fórmula documentada en RULES.md ─── */

export interface ElementoPrioridad {
  type: ElementType;
  status: ElementStatus;
  /** 0-100, impacto de negocio de perder el elemento */
  criticidad: number;
  /** segundos sin energía de red ni respaldo fiable */
  sinEnergiaSegundos: number;
}

export function calcularPrioridad(e: ElementoPrioridad): number {
  const p = REGLAS_PARA_AGENTE.prioridad;
  const minutos = Math.min(Math.max(e.sinEnergiaSegundos, 0) / 60, p.maxMinutosContabilizados);
  const score =
    p.pesoCriticidad * e.criticidad +
    p.pesoStatus[e.status] +
    p.pesoTipo[e.type] +
    p.pesoMinutoSinEnergia * minutos;
  return Math.round(score * 10) / 10;
}

/* ─── Derivación de status ─── */

const RANGO_STATUS = ["normal", "degradado", "critico"] as const;

type StatusSinResuelto = Extract<ElementStatus, (typeof RANGO_STATUS)[number]>;

function peorStatus(a: StatusSinResuelto, b: StatusSinResuelto): StatusSinResuelto {
  return RANGO_STATUS.indexOf(a) >= RANGO_STATUS.indexOf(b) ? a : b;
}

export function derivarStatus(severidad: number): StatusSinResuelto {
  if (severidad >= UMBRAL_CRITICO) return "critico";
  if (severidad >= UMBRAL_DEGRADADO) return "degradado";
  return "normal";
}

export function derivarStatusMetrica(
  metrica: SensorMetric,
  valor: number,
): StatusSinResuelto {
  const umbrales = UMBRALES_METRICA[metrica];
  const critico =
    umbrales.direccion === "bajo" ? valor <= umbrales.critico : valor >= umbrales.critico;
  const degradado =
    umbrales.direccion === "bajo" ? valor <= umbrales.degradado : valor >= umbrales.degradado;
  if (critico) return "critico";
  if (degradado) return "degradado";
  return "normal";
}

/** status final de un elemento: el peor entre la severidad del último evento y sus métricas crudas */
export function derivarStatusElemento(
  severidad: number,
  metricas: Partial<Record<SensorMetric, number>>,
): StatusSinResuelto {
  let status = derivarStatus(severidad);
  for (const [metrica, valor] of Object.entries(metricas) as [SensorMetric, number][]) {
    status = peorStatus(status, derivarStatusMetrica(metrica, valor));
  }
  return status;
}

/* ─── Validación de acciones contra las reglas bloqueantes ─── */

export type AccionMotorTipo = "contactar" | "asignar_recurso" | "esperar";

export interface IntentoAccion {
  tipo: AccionMotorTipo;
  elementId: string;
  /** requerido si tipo === "asignar_recurso" */
  recursoId?: string;
}

export interface ElementoValidacion {
  id: string;
  type: ElementType;
  status: ElementStatus;
  metricas: Partial<Record<SensorMetric, number>>;
  /** segundos sin energía de red ni respaldo fiable (0 si tiene suministro) */
  sinEnergiaSegundos: number;
}

export interface RecursoValidacion {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
}

export interface ContextoValidacion {
  elementos: ElementoValidacion[];
  recursos: RecursoValidacion[];
}

export type ResultadoValidacion =
  | { permitido: true }
  | { permitido: false; regla: ReglaBloqueanteId; razon: string };

/**
 * Valida una acción propuesta contra las reglas bloqueantes.
 * `contactar` nunca se bloquea (comunicar no consume recursos físicos).
 */
export function validarAccion(
  intento: IntentoAccion,
  contexto: ContextoValidacion,
): ResultadoValidacion {
  if (intento.tipo === "contactar") return { permitido: true };

  const elementosPorId = new Map(contexto.elementos.map((e) => [e.id, e]));
  const hospitalesEnRiesgo = contexto.elementos.filter(
    (e) =>
      e.type === "hospital" &&
      e.status === "critico" &&
      e.sinEnergiaSegundos > 0 &&
      !contexto.recursos.some(
        (r) => r.type === "generador" && r.assignedElementId === e.id,
      ),
  );
  const hospitalEnPlazo = contexto.elementos.find(
    (e) =>
      e.type === "hospital" &&
      e.sinEnergiaSegundos > MAX_MINUTOS_SIN_ENERGIA.hospital * 60,
  );

  if (intento.tipo === "asignar_recurso") {
    if (!intento.recursoId) {
      return {
        permitido: false,
        regla: "sin-doble-asignacion",
        razon: "asignar_recurso requiere recursoId",
      };
    }
    const recurso = contexto.recursos.find((r) => r.id === intento.recursoId);
    if (!recurso) {
      return {
        permitido: false,
        regla: "sin-doble-asignacion",
        razon: `recurso inexistente: ${intento.recursoId}`,
      };
    }
    if (recurso.status !== "disponible") {
      return {
        permitido: false,
        regla: "sin-doble-asignacion",
        razon: `${recurso.id} no está disponible (status ${recurso.status}); libéralo antes de reasignar`,
      };
    }
    const objetivo = elementosPorId.get(intento.elementId);
    if (objetivo && recurso.type === "generador" && objetivo.type !== "hospital") {
      const hospitalAlQueSirve = hospitalesEnRiesgo[0];
      if (hospitalAlQueSirve) {
        return {
          permitido: false,
          regla: "hospital-prioridad-energia",
          razon: `${hospitalAlQueSirve.id} está critico sin respaldo de energía: los generadores solo pueden ir a él`,
        };
      }
    }
    // generador-sin-combustible: desplegar un generador seco es gastar el viaje
    if (recurso.type === "generador") {
      const combustible = objetivo?.metricas.combustible;
      if (combustible !== undefined && combustible <= UMBRAL_COMBUSTIBLE_CRITICO) {
        return {
          permitido: false,
          regla: "generador-sin-combustible",
          razon: `${objetivo?.id} reporta combustible ${combustible} (umbral ${UMBRAL_COMBUSTIBLE_CRITICO}): reabastece con la cisterna antes de desplegar un generador`,
        };
      }
    }
    if (hospitalEnPlazo && objetivo && objetivo.id !== hospitalEnPlazo.id) {
      const destinoValido =
        objetivo.type === "subestacion" && objetivo.status === "critico";
      if (!destinoValido) {
        return {
          permitido: false,
          regla: "hospital-plazo-energia",
          razon: `${hospitalEnPlazo.id} lleva ${Math.floor(hospitalEnPlazo.sinEnergiaSegundos / 60)} min sin energía (límite ${MAX_MINUTOS_SIN_ENERGIA.hospital}): solo se permite actuar sobre él o sobre la subestación de origen`,
        };
      }
    }
    return { permitido: true };
  }

  // tipo === "esperar"
  const objetivo = elementosPorId.get(intento.elementId);
  if (hospitalEnPlazo && objetivo && objetivo.id !== hospitalEnPlazo.id) {
    return {
      permitido: false,
      regla: "hospital-plazo-energia",
      razon: `${hospitalEnPlazo.id} lleva ${Math.floor(hospitalEnPlazo.sinEnergiaSegundos / 60)} min sin energía (límite ${MAX_MINUTOS_SIN_ENERGIA.hospital}): no se puede esperar en ${objetivo.id}`,
    };
  }
  const cargaUps = objetivo?.metricas.carga_ups;
  if (objetivo && cargaUps !== undefined && cargaUps < UMBRAL_UPS_ACTUAR) {
    return {
      permitido: false,
      regla: "ups-critica-actuar",
      razon: `${objetivo.id} con carga_ups ${cargaUps}% < ${UMBRAL_UPS_ACTUAR}%: esperar está prohibido, hay que asignar recurso o escalar (hist-dc-002)`,
    };
  }
  return { permitido: true };
}
