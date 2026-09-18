export type ElementType = "datacenter" | "hospital" | "subestacion";

export type ElementStatus = "normal" | "degradado" | "critico" | "resuelto";

export interface Element {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  status: ElementStatus;
  /** 0-100, cuanto más alto más crítico es perder este elemento */
  criticidad: number;
}

export type SensorMetric =
  | "temperatura"
  | "carga_ups"
  | "bateria_generador"
  | "cobertura_red"
  | "tension_red";

export interface SensorEvent {
  id: string;
  elementId: string;
  timestamp: string;
  metric: SensorMetric;
  value: number;
  /** 0-100 */
  severidad: number;
}

export type ResourceType = "cuadrilla" | "generador";

export type ResourceStatus = "disponible" | "en_transito" | "asignado";

export interface Resource {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
}

export type ActionType = "llamada_voz" | "mensaje_chat";

export type ActionStatus = "propuesta" | "confirmada" | "ejecutada" | "rechazada";

export interface Action {
  id: string;
  type: ActionType;
  targetElementId: string;
  status: ActionStatus;
  mensaje: string;
  timestamp: string;
}

export interface Decision {
  id: string;
  timestamp: string;
  elementId: string;
  prioridad: number;
  razonamiento: string;
  provocaReplan: boolean;
  acciones: Action[];
}

export interface HistoricoIncidente {
  id: string;
  tipo: ElementType;
  titulo: string;
  resumen: string;
  resultado: string;
  fecha: string;
}
