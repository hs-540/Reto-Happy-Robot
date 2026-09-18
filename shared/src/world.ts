export type ElementType = "datacenter" | "hospital" | "subestacion";

export type ElementStatus = "normal" | "degradado" | "critico" | "resuelto";

export type SensorMetric =
  | "temperatura"
  | "carga_ups"
  | "bateria_generador"
  | "cobertura_red"
  | "tension_red";

export type ResourceType = "cuadrilla" | "generador";

export type ResourceStatus = "disponible" | "en_transito" | "asignado";

export interface ElementTopology {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  /** 0-100, cuanto más alto más crítico es perder este elemento */
  criticidad: number;
}

export interface ResourceTopology {
  id: string;
  type: ResourceType;
  lat: number;
  lng: number;
}

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
  | "analizando"
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
  /** Instante simulado, ISO 8601 */
  relojSimulacion: string;
  /** Último seq emitido en el feed; correlaciona /api/state con /api/feed */
  ultimoSeq: number;
  elementos: ElementView[];
  recursos: ResourceView[];
}
