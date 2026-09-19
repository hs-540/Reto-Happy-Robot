import type { ElementoGuion, RecursoGuion, SensorEvent } from "./guion.js";

/* Primitivas derivadas de los esquemas de data/ (fuente única en guion.ts) */
export type ElementType = ElementoGuion["type"];

export type ElementStatus = ElementoGuion["status"];

export type SensorMetric = SensorEvent["metric"];

export type ResourceType = RecursoGuion["type"];

export type ResourceStatus = RecursoGuion["status"];

export type ElementTopology = Omit<ElementoGuion, "status">;

export type ResourceTopology = Omit<RecursoGuion, "status" | "assignedElementId">;

export interface GuionMoment {
  atSeconds: number;
  titulo: string;
}

export interface TopologyView {
  crisis: {
    titulo: string;
    duracionSegundos: number;
    momentos: GuionMoment[];
  };
  elementos: ElementTopology[];
  recursos: ResourceTopology[];
}

export type AttentionState =
  | "sin_atencion"
  /** hay una decisión viva sobre el sitio, pero ningún recurso comprometido */
  | "analizando"
  /** recurso comprometido y en ruta: el sitio YA está cubierto, no hace falta otro */
  | "recurso_en_camino"
  /** recurso desplegado y trabajando en el sitio */
  | "recurso_asignado"
  | "resuelto";

export interface ElementView {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  status: ElementStatus;
  /** 0-100, derivada de los sensores en backend */
  severidad: number;
  sensores: Partial<Record<SensorMetric, number>>;
  atencion: {
    estado: AttentionState;
    recursoId: string | null;
    decisionActivaId: string | null;
  };
  actualizadoEn: string;
}

export interface ResourceView {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
}

export interface StateView {
  tick: number;
  pausado: boolean;
  /** false hasta que el guion arranca vía POST /api/control {accion:"iniciar"} */
  iniciado: boolean;
  /** Instante simulado, ISO 8601 */
  relojSimulacion: string;
  /** Último seq emitido en el feed; correlaciona /api/state con /api/feed */
  ultimoSeq: number;
  elementos: ElementView[];
  recursos: ResourceView[];
}
