import type {
  ElementStatus,
  ElementView,
  ResourceView,
  SensorMetric,
  StateView,
} from "@reto/shared";
import {
  SEGUNDOS_ESTABLE_RESUELTO,
  TENSION_ESTABLE_RESUELTO,
  derivarStatus,
} from "@reto/shared";
import type { Guion, GuionEvento } from "./guion.js";

/** Cadencia del motor de decisión (DESIGN.md): tick cada 5-10s */
export const TICK_SEGUNDOS = 5;

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
  estado(): StateView;
  tick(): number;
  readonly pausado: boolean;
}

export function crearSimulacion(guion: Guion, inicioMs: number): Simulacion {
  const timeline = [...guion.timeline].sort((a, b) => a.atSeconds - b.atSeconds);
  let siguiente = 0;
  let segundos = 0;
  let ultimoMs = inicioMs;
  let pausado = false;

  const elementos = new Map<string, EstadoElemento>();
  for (const e of guion.elements) {
    elementos.set(e.id, {
      severidad: 0,
      sensores: {},
      normalDesde: 0,
      tuvoIncidente: false,
      actualizadoEn: 0,
    });
  }

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
      console.log(
        `[sim] narrativa ${ev.payload.evento}${ev.payload.resourceId ? ` recurso=${ev.payload.resourceId}` : ""}`,
      );
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
      const deltaMs = ahoraMs - ultimoMs;
      ultimoMs = ahoraMs;
      if (!pausado) segundos += deltaMs / 1000;
      while (siguiente < timeline.length && timeline[siguiente].atSeconds <= segundos) {
        aplicarEvento(timeline[siguiente]);
        siguiente++;
      }
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
      const recursos: ResourceView[] = guion.resources.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        assignedElementId: r.assignedElementId,
        lat: r.lat,
        lng: r.lng,
      }));
      return {
        tick: Math.floor(segundos / TICK_SEGUNDOS),
        pausado,
        relojSimulacion: relojIso(segundos),
        ultimoSeq: 0,
        elementos: vistas,
        recursos,
      };
    },
    tick(): number {
      return Math.floor(segundos / TICK_SEGUNDOS);
    },
    get pausado(): boolean {
      return pausado;
    },
  };
}
