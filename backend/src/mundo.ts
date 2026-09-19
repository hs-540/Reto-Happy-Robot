import type {
  ContextoValidacion,
  SensorMetric,
  ElementView,
  ElementoValidacion,
  RecursoValidacion,
  ResourceView,
} from "@swarmup/shared";
import {
  MAX_MINUTOS_SIN_ENERGIA,
  UMBRAL_BATERIA_CRITICA,
  UMBRAL_UPS_ACTUAR,
  calcularPrioridad,
  derivarStatusMetrica,
} from "@swarmup/shared";
import { dependientesDe } from "@swarmup/shared";
import type { Remedios, Topologia } from "@swarmup/shared";
import type { GuionElemento, GuionRecurso } from "./guion.js";

/** Velocidad urbana de los recursos, km por minuto de crisis (~30 km/h) */
const VELOCIDAD_KM_MIN = 0.5;

/** ETA mínima: aunque el recurso ya esté encima, el despliegue cuesta */
const ETA_MINIMA_SEG = 60;

/** Multiplicador de los trayectos cuando el cruce está sin regular */
const PENALIZACION_TRAFICO = 2;

/** Minutos de retraso por encima de los cuales la zona se considera colapsada */
const UMBRAL_CONGESTION_ALTA = 10;

/** Severidad a la que queda un elemento cuyo remedio se ha aplicado del todo */
const SEVERIDAD_RESUELTA = 5;

/** Cada cuántos segundos de crisis se emite un paso de recuperación */
const PASO_RECUPERACION_SEG = 60;

/**
 * Con la red restaurada, un sitio no se queda congelado en su peor lectura: las
 * baterías se recargan, el CPD se enfría y el atasco se disuelve. Cada métrica
 * converge hacia su valor sano a este ritmo, por minuto de crisis.
 * `combustible` NO está aquí a propósito: un depósito no se llena solo, hace
 * falta la cisterna.
 */
const RECUPERACION: Partial<Record<SensorMetric, { objetivo: number; ritmo: number }>> = {
  bateria_torre: { objetivo: 95, ritmo: 12 },
  bateria_generador: { objetivo: 95, ritmo: 10 },
  carga_ups: { objetivo: 95, ritmo: 15 },
  temperatura: { objetivo: 22, ritmo: 6 },
  congestion: { objetivo: 3, ritmo: 8 },
};

/** Tensión a partir de la cual se considera que el sitio tiene red de nuevo */
const TENSION_CON_RED = 90;

/**
 * Cambios del mundo que el agente debe observar. Los tres primeros son
 * triggers de replanificación (RULES.md §7); `llegada` es ajuste incremental.
 */
export type EventoMundo =
  | { tipo: "llegada"; recursoId: string; elementId: string }
  | { tipo: "eta_incumplida"; recursoId: string; elementId: string; retrasoSeg: number }
  | { tipo: "plazo_superado"; elementId: string; minutosSinEnergia: number }
  /** Con la red de vuelta, una métrica propia avanza hacia su valor sano */
  | {
      tipo: "recuperacion";
      elementId: string;
      metric: SensorMetric;
      value: number;
      severidad: number;
    }
  /**
   * Un remedio ha terminado de aplicarse. Lleva las lecturas que el mundo real
   * pasaría a reportar: la simulación las aplica como si vinieran del sensor,
   * así el efecto de una acción del agente es indistinguible de la realidad.
   */
  | {
      tipo: "remedio_aplicado";
      elementId: string;
      recursoId: string;
      metric: SensorMetric;
      value: number;
      severidad: number;
      efecto: string;
    };

export type ResultadoAsignacion =
  | { ok: true; etaSegundos: number }
  | { ok: false; razon: string };

interface EstadoRecurso {
  id: string;
  type: GuionRecurso["type"];
  status: ResourceView["status"];
  assignedElementId: string | null;
  lat: number;
  lng: number;
  /** Punto de partida del trayecto en curso */
  origen: { lat: number; lng: number } | null;
  destino: { lat: number; lng: number } | null;
  /** Segundo simulado en que arrancó el trayecto */
  salidaEn: number | null;
  /** Duración total del trayecto, incluye retrasos inyectados */
  etaSegundos: number;
  /** Ya se emitió `eta_incumplida` para este trayecto */
  retrasoAvisado: boolean;
  /** Segundo simulado en que llegó al destino; null si no ha llegado */
  llegadaEn: number | null;
  /** Ya se emitió `remedio_aplicado` para esta asignación */
  remedioAplicado: boolean;
}

export interface Mundo {
  /**
   * Avanza el mundo al segundo simulado dado y devuelve lo que ha cambiado.
   * `elementos` es la foto que produce la simulación de sensores en este tick.
   */
  avanzar(segundos: number, elementos: ElementView[]): EventoMundo[];
  asignar(recursoId: string, elementId: string, segundos: number): ResultadoAsignacion;
  liberar(recursoId: string): void;
  /**
   * Retrasa el trayecto en curso; alimenta el momento 4 del guion. El trigger
   * de replanificación sale por el siguiente `avanzar`. Sin efecto si el
   * recurso no iba de camino o ya se avisó de este retraso.
   */
  retrasar(recursoId: string, segundosExtra: number): void;
  /** Vuelve al estado inicial del guion (lo llama `sim.reiniciar`) */
  reiniciar(): void;
  recursos(): ResourceView[];
  /** Segundos acumulados sin red ni respaldo fiable, por elementId */
  sinEnergiaSegundos(elementId: string): number;
  /** Contexto que consume `validarAccion` de shared/rules */
  contexto(elementos: ElementView[]): ContextoValidacion;
  /** Elementos ordenados por `calcularPrioridad`, de más a menos urgente */
  prioridades(elementos: ElementView[]): { elementId: string; score: number }[];
}

/** Distancia aproximada en km. A escala municipal la aproximación plana sobra. */
function distanciaKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

export function crearMundo(
  guion: { elements: GuionElemento[]; resources: GuionRecurso[] },
  remedios: Remedios,
  topologia: Topologia,
): Mundo {
  const tipoDe = new Map(guion.elements.map((e) => [e.id, e.type]));
  const criticidad = new Map(guion.elements.map((e) => [e.id, e.criticidad]));
  const coords = new Map(guion.elements.map((e) => [e.id, { lat: e.lat, lng: e.lng }]));

  const recursos = new Map<string, EstadoRecurso>();
  /** segundos acumulados sin energía, por elemento */
  const sinEnergia = new Map<string, number>();
  /** ya se avisó de que este elemento superó su plazo */
  const plazoAvisado = new Set<string>();
  /** eventos emitidos fuera del tick; los drena el siguiente `avanzar` */
  const pendientes: EventoMundo[] = [];
  /** último segundo en que se emitió un paso de recuperación, por elemento */
  const ultimaRecuperacion = new Map<string, number>();
  let ultimoSegundo = 0;

  function sembrar(): void {
    recursos.clear();
    for (const r of guion.resources) {
      recursos.set(r.id, {
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
        lat: r.lat,
        lng: r.lng,
        origen: null,
        destino: null,
        salidaEn: null,
        etaSegundos: 0,
        retrasoAvisado: false,
        llegadaEn: null,
        remedioAplicado: false,
      });
    }
    sinEnergia.clear();
    for (const e of guion.elements) sinEnergia.set(e.id, 0);
    plazoAvisado.clear();
    ultimaRecuperacion.clear();
    pendientes.length = 0;
    ultimoSegundo = 0;
  }
  sembrar();

  /**
   * "Sin energía" = red caída y sin respaldo fiable (RULES.md §3).
   * Respaldo fiable: generador nuestro ya desplegado, o reserva propia por
   * encima del umbral de actuación. Sin lectura de tensión asumimos suministro:
   * no inventamos una crisis a partir de la ausencia de datos.
   */
  function estaSinEnergia(e: ElementView): boolean {
    const tension = e.sensores.tension_red;
    if (tension === undefined) return false;
    if (derivarStatusMetrica("tension_red", tension) !== "critico") return false;

    for (const r of recursos.values()) {
      if (r.type === "generador" && r.assignedElementId === e.id && r.status === "asignado") {
        return false;
      }
    }

    const ups = e.sensores.carga_ups;
    if (ups !== undefined && ups > UMBRAL_UPS_ACTUAR) return false;
    const bateria = e.sensores.bateria_generador;
    if (bateria !== undefined && bateria > UMBRAL_BATERIA_CRITICA) return false;

    return true;
  }

  /** Lectura que pasa a reportar un sitio cuyo remedio se ha completado */
  const METRICA_SANA: Record<string, { metric: SensorMetric; value: number }> = {
    subestacion: { metric: "tension_red", value: 98 },
    hospital: { metric: "bateria_generador", value: 95 },
    datacenter: { metric: "carga_ups", value: 90 },
    torre: { metric: "bateria_torre", value: 85 },
    gasolinera: { metric: "tension_red", value: 96 },
    cruce: { metric: "congestion", value: 3 },
  };

  /** El remedio de `recurso` sobre un sitio de `tipo`, si es que existe */
  function remedioPara(recurso: string, tipoElemento: string) {
    return remedios.remedios.find(
      (r) => r.recurso === recurso && (r.aplicableA as readonly string[]).includes(tipoElemento),
    );
  }

  /** Con el cruce sin regular, cualquier trayecto tarda el doble */
  function traficoPenalizado(): boolean {
    const regulada = [...recursos.values()].some(
      (r) => r.type === "policia" && r.status === "asignado",
    );
    if (regulada) return false;
    return congestionAlta;
  }
  let congestionAlta = false;

  function posicionEnTrayecto(r: EstadoRecurso, segundos: number): { lat: number; lng: number } {
    if (!r.origen || !r.destino || r.salidaEn === null || r.etaSegundos <= 0) {
      return { lat: r.lat, lng: r.lng };
    }
    const avance = Math.min((segundos - r.salidaEn) / r.etaSegundos, 1);
    return {
      lat: r.origen.lat + (r.destino.lat - r.origen.lat) * avance,
      lng: r.origen.lng + (r.destino.lng - r.origen.lng) * avance,
    };
  }

  return {
    avanzar(segundos: number, elementos: ElementView[]): EventoMundo[] {
      const delta = Math.max(segundos - ultimoSegundo, 0);
      ultimoSegundo = segundos;
      const eventos: EventoMundo[] = pendientes.splice(0, pendientes.length);

      // el cruce marca si la zona está colapsada; la policía lo neutraliza
      const cruce = elementos.find((e) => e.type === "cruce");
      congestionAlta =
        cruce !== undefined && (cruce.sensores.congestion ?? 0) >= UMBRAL_CONGESTION_ALTA;

      for (const e of elementos) {
        if (estaSinEnergia(e)) {
          const acumulado = (sinEnergia.get(e.id) ?? 0) + delta;
          sinEnergia.set(e.id, acumulado);
          const limiteSeg = MAX_MINUTOS_SIN_ENERGIA[e.type] * 60;
          if (acumulado > limiteSeg && !plazoAvisado.has(e.id)) {
            plazoAvisado.add(e.id);
            eventos.push({
              tipo: "plazo_superado",
              elementId: e.id,
              minutosSinEnergia: Math.floor(acumulado / 60),
            });
          }
        } else {
          // se restauró el suministro: el contador y el aviso se reinician
          sinEnergia.set(e.id, 0);
          plazoAvisado.delete(e.id);
        }
      }

      for (const r of recursos.values()) {
        if (r.status !== "en_transito" || r.salidaEn === null) continue;
        const pos = posicionEnTrayecto(r, segundos);
        r.lat = pos.lat;
        r.lng = pos.lng;
        if (segundos - r.salidaEn >= r.etaSegundos) {
          r.status = "asignado";
          r.origen = null;
          r.destino = null;
          r.salidaEn = null;
          r.llegadaEn = segundos;
          eventos.push({
            tipo: "llegada",
            recursoId: r.id,
            elementId: r.assignedElementId ?? "",
          });
        }
      }

      // Con la red de vuelta, las métricas propias dejan de estar congeladas en
      // su peor lectura y convergen hacia su valor sano. Sin esto la demo acaba
      // con tres sitios en rojo aunque el agente lo haya resuelto todo.
      for (const e of elementos) {
        const tension = e.sensores.tension_red;
        if (tension === undefined || tension < TENSION_CON_RED) continue;
        const desde = ultimaRecuperacion.get(e.id) ?? -Infinity;
        if (segundos - desde < PASO_RECUPERACION_SEG) continue;

        let emitido = false;
        for (const [clave, cfg] of Object.entries(RECUPERACION)) {
          const metrica = clave as SensorMetric;
          const actual = e.sensores[metrica];
          if (actual === undefined) continue;
          const sube = cfg.objetivo > actual;
          const baja = cfg.objetivo < actual;
          if (!sube && !baja) continue;
          const siguiente = sube
            ? Math.min(actual + cfg.ritmo, cfg.objetivo)
            : Math.max(actual - cfg.ritmo, cfg.objetivo);
          const restante = Math.abs(cfg.objetivo - siguiente) / Math.abs(cfg.objetivo || 1);
          eventos.push({
            tipo: "recuperacion",
            elementId: e.id,
            metric: metrica,
            value: Math.round(siguiente),
            severidad: Math.round(Math.min(restante * 100, 25)),
          });
          emitido = true;
        }
        if (emitido) ultimaRecuperacion.set(e.id, segundos);
      }

      // Un recurso desplegado tarda los minutos de su remedio en surtir efecto.
      // Cumplido el plazo, el sitio pasa a reportar lecturas sanas: así una
      // acción del agente cambia el mundo igual que lo haría en la realidad.
      for (const r of recursos.values()) {
        if (r.status !== "asignado" || r.llegadaEn === null || r.remedioAplicado) continue;
        const destinoId = r.assignedElementId;
        if (!destinoId) continue;
        const tipoElemento = tipoDe.get(destinoId);
        if (!tipoElemento) continue;
        const remedio = remedioPara(r.type, tipoElemento);
        if (!remedio) continue;
        if (segundos - r.llegadaEn < remedio.minutos * 60) continue;

        r.remedioAplicado = true;
        const sano = METRICA_SANA[tipoElemento];
        if (sano) {
          eventos.push({
            tipo: "remedio_aplicado",
            elementId: destinoId,
            recursoId: r.id,
            metric: sano.metric,
            value: sano.value,
            severidad: SEVERIDAD_RESUELTA,
            efecto: remedio.efecto,
          });
        }
        // alimenta: reparar un nodo devuelve la red a todo lo que cuelga de él
        for (const dependiente of dependientesDe(topologia, destinoId)) {
          const tipoDep = tipoDe.get(dependiente);
          if (!tipoDep) continue;
          eventos.push({
            tipo: "remedio_aplicado",
            elementId: dependiente,
            recursoId: r.id,
            metric: "tension_red",
            value: 96,
            severidad: SEVERIDAD_RESUELTA,
            efecto: `Red restaurada por la reparación de ${destinoId}`,
          });
        }
      }

      return eventos;
    },

    asignar(recursoId: string, elementId: string, segundos: number): ResultadoAsignacion {
      const r = recursos.get(recursoId);
      if (!r) return { ok: false, razon: `recurso inexistente: ${recursoId}` };
      if (r.status !== "disponible") {
        return { ok: false, razon: `${recursoId} no está disponible (status ${r.status})` };
      }
      const destino = coords.get(elementId);
      if (!destino) return { ok: false, razon: `elemento inexistente: ${elementId}` };

      const km = distanciaKm({ lat: r.lat, lng: r.lng }, destino);
      const base = Math.max(Math.round((km / VELOCIDAD_KM_MIN) * 60), ETA_MINIMA_SEG);
      // habilita_transito: sin el cruce regulado, moverse por la zona cuesta el doble
      const eta = traficoPenalizado() ? base * PENALIZACION_TRAFICO : base;

      r.status = "en_transito";
      r.assignedElementId = elementId;
      r.origen = { lat: r.lat, lng: r.lng };
      r.destino = destino;
      r.salidaEn = segundos;
      r.etaSegundos = eta;
      r.retrasoAvisado = false;
      r.llegadaEn = null;
      r.remedioAplicado = false;

      return { ok: true, etaSegundos: eta };
    },

    liberar(recursoId: string): void {
      const r = recursos.get(recursoId);
      if (!r) return;
      r.status = "disponible";
      r.assignedElementId = null;
      r.origen = null;
      r.destino = null;
      r.salidaEn = null;
      r.etaSegundos = 0;
      r.retrasoAvisado = false;
      r.llegadaEn = null;
      r.remedioAplicado = false;
    },

    retrasar(recursoId: string, segundosExtra: number): void {
      const r = recursos.get(recursoId);
      if (!r || r.status !== "en_transito" || r.retrasoAvisado) return;
      r.etaSegundos += segundosExtra;
      r.retrasoAvisado = true;
      pendientes.push({
        tipo: "eta_incumplida",
        recursoId: r.id,
        elementId: r.assignedElementId ?? "",
        retrasoSeg: segundosExtra,
      });
    },

    reiniciar(): void {
      sembrar();
    },

    recursos(): ResourceView[] {
      return [...recursos.values()].map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
        lat: r.lat,
        lng: r.lng,
      }));
    },

    sinEnergiaSegundos(elementId: string): number {
      return sinEnergia.get(elementId) ?? 0;
    },

    contexto(elementos: ElementView[]): ContextoValidacion {
      const vistaElementos: ElementoValidacion[] = elementos.map((e) => ({
        id: e.id,
        type: e.type,
        status: e.status,
        metricas: e.sensores,
        sinEnergiaSegundos: sinEnergia.get(e.id) ?? 0,
      }));
      const vistaRecursos: RecursoValidacion[] = [...recursos.values()].map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
      }));
      return { elementos: vistaElementos, recursos: vistaRecursos };
    },

    prioridades(elementos: ElementView[]): { elementId: string; score: number }[] {
      return elementos
        .map((e) => ({
          elementId: e.id,
          score: calcularPrioridad({
            type: e.type,
            status: e.status,
            criticidad: criticidad.get(e.id) ?? 50,
            sinEnergiaSegundos: sinEnergia.get(e.id) ?? 0,
          }),
        }))
        .sort((a, b) => b.score - a.score);
    },
  };
}
