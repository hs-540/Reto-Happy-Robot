import type {
  ElementStatus,
  ElementView,
  InyectarPayload,
  SensorMetric,
  StateView,
} from "@swarmup/shared";
import {
  SEGUNDOS_ESTABLE_RESUELTO,
  TENSION_ESTABLE_RESUELTO,
  derivarStatus,
} from "@swarmup/shared";
import type { Guion, GuionEvento } from "./guion.js";
import type { Feed } from "./feed.js";
import type { Mundo } from "./mundo.js";

/** Cadencia del motor de decisión (DESIGN.md): tick cada 5-10s */
export const TICK_SEGUNDOS = 5;

/** Retraso que sufre la cuadrilla en el momento 4 del guion */
const RETRASO_ETA_SEG = 60;

interface EstadoElemento {
  severidad: number;
  sensores: Partial<Record<SensorMetric, number>>;
  /** segundo simulado en el que el elemento entró en status normal (null si no está normal) */
  normalDesde: number | null;
  tuvoIncidente: boolean;
  /** segundo simulado del último evento recibido */
  actualizadoEn: number;
}

export interface Simulacion {
  /** Avanza el reloj hasta `ahoraMs` y aplica los eventos vencidos del guion */
  avanzar(ahoraMs: number): void;
  /** Arranca el guion en `ahoraMs` (sin efecto si ya está en marcha) */
  iniciar(ahoraMs: number): void;
  /** Vuelve al estado inicial reproducible y detiene el guion */
  reiniciar(): void;
  pausar(): void;
  reanudar(): void;
  /** Modo híbrido: aplica un sensor event de emergencia en el segundo simulado actual */
  inyectar(payload: InyectarPayload): void;
  estado(): StateView;
  tick(): number;
  /** Segundo simulado actual; lo consume `mundo.avanzar` */
  segundos(): number;
  readonly pausado: boolean;
  readonly iniciado: boolean;
}

export function crearSimulacion(
  guion: Guion,
  inicioMs: number,
  feed: Feed,
  mundo: Mundo,
): Simulacion {
  const timeline = [...guion.timeline].sort((a, b) => a.atSeconds - b.atSeconds);
  let siguiente = 0;
  let segundos = 0;
  let ultimoMs = inicioMs;
  let pausado = false;
  let iniciado = false;
  let inyecciones = 0;

  const elementos = new Map<string, EstadoElemento>();

  function sembrarElementos(): void {
    elementos.clear();
    for (const e of guion.elements) {
      elementos.set(e.id, {
        severidad: 0,
        sensores: {},
        normalDesde: 0,
        tuvoIncidente: false,
        actualizadoEn: 0,
      });
    }
  }
  sembrarElementos();

  function estadoDe(id: string): EstadoElemento {
    const estado = elementos.get(id);
    if (!estado) throw new Error(`evento para elemento desconocido: ${id}`);
    return estado;
  }

  function relojIso(seg: number): string {
    return new Date(inicioMs + seg * 1000).toISOString();
  }

  function aplicarEvento(ev: GuionEvento): void {
    if (ev.kind === "narrative") {
      if (ev.nota !== undefined) {
        feed.publicar({ kind: "sistema", mensaje: ev.nota });
      }
      if (ev.payload.evento !== "eta_incumplida" || ev.payload.resourceId === undefined) return;
      // momento 4 del guion: la cuadrilla no llega a tiempo. El mundo alarga su
      // trayecto y emite el trigger de replanificación en el siguiente tick.
      mundo.retrasar(ev.payload.resourceId, RETRASO_ETA_SEG);
      return;
    }
    const estado = estadoDe(ev.payload.elementId);
    estado.severidad = ev.payload.severidad;
    estado.sensores[ev.payload.metric] = ev.payload.value;
    estado.actualizadoEn = ev.atSeconds;
    if (derivarStatus(estado.severidad) === "normal") {
      if (estado.normalDesde === null) estado.normalDesde = ev.atSeconds;
    } else {
      estado.normalDesde = null;
      estado.tuvoIncidente = true;
    }
    feed.publicar({
      kind: "alarma",
      elementId: ev.payload.elementId,
      metric: ev.payload.metric,
      value: ev.payload.value,
      severidad: ev.payload.severidad,
    });
    // los momentos clave del guion son el marco narrativo de la demo
    if (ev.nota !== undefined) {
      feed.publicar({ kind: "sistema", mensaje: ev.nota });
    }
  }

  function statusDe(estado: EstadoElemento): ElementStatus {
    // hist-sub-002: una restauración parcial engaña; `resuelto` exige estabilidad
    // sostenida y, si el elemento reporta tensión de red, que esté restaurada
    if (
      estado.tuvoIncidente &&
      estado.normalDesde !== null &&
      segundos - estado.normalDesde >= SEGUNDOS_ESTABLE_RESUELTO
    ) {
      const tension = estado.sensores.tension_red;
      if (tension === undefined || tension >= TENSION_ESTABLE_RESUELTO) return "resuelto";
    }
    return derivarStatus(estado.severidad);
  }

  return {
    avanzar(ahoraMs: number): void {
      if (!iniciado) {
        ultimoMs = ahoraMs;
        return;
      }
      const deltaMs = ahoraMs - ultimoMs;
      ultimoMs = ahoraMs;
      if (!pausado) segundos += deltaMs / 1000;
      while (siguiente < timeline.length && timeline[siguiente].atSeconds <= segundos) {
        aplicarEvento(timeline[siguiente]);
        siguiente++;
      }
    },
    iniciar(ahoraMs: number): void {
      if (iniciado) return;
      iniciado = true;
      pausado = false;
      ultimoMs = ahoraMs;
    },
    reiniciar(): void {
      siguiente = 0;
      segundos = 0;
      pausado = false;
      iniciado = false;
      feed.reiniciar();
      inyecciones = 0;
      sembrarElementos();
      mundo.reiniciar();
    },
    pausar(): void {
      pausado = true;
    },
    reanudar(): void {
      pausado = false;
    },
    inyectar(payload: InyectarPayload): void {
      inyecciones++;
      aplicarEvento({
        atSeconds: segundos,
        kind: "sensor_event",
        payload: {
          id: `inyeccion-${inyecciones}`,
          elementId: payload.elementId,
          metric: payload.metric,
          value: payload.value,
          severidad: payload.severidad,
        },
      });
    },
    estado(): StateView {
      const vistas: ElementView[] = guion.elements.map((e) => {
        const estado = estadoDe(e.id);
        return {
          id: e.id,
          type: e.type,
          name: e.name,
          lat: e.lat,
          lng: e.lng,
          status: statusDe(estado),
          severidad: Math.round(estado.severidad),
          sensores: { ...estado.sensores },
          // decisiones stub en este skeleton: el motor real es scope de B
          atencion: { estado: "sin_atencion", recursoId: null, decisionActivaId: null },
          actualizadoEn: relojIso(estado.actualizadoEn),
        };
      });
      return {
        tick: Math.floor(segundos / TICK_SEGUNDOS),
        pausado,
        iniciado,
        relojSimulacion: relojIso(segundos),
        ultimoSeq: feed.ultimoSeq(),
        elementos: vistas,
        // los recursos los posee `mundo`: estado físico, posición y trayectos
        recursos: mundo.recursos(),
      };
    },
    tick(): number {
      return Math.floor(segundos / TICK_SEGUNDOS);
    },
    segundos(): number {
      return segundos;
    },
    get pausado(): boolean {
      return pausado;
    },
    get iniciado(): boolean {
      return iniciado;
    },
  };
}
