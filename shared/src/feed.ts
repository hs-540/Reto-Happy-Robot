import type { SensorMetric } from "./world.js";
import type { ActionStatus, ActionType, ResultadoLlamada } from "./agent.js";

export type FeedItemKind =
  | "alarma"
  | "reporte"
  | "decision"
  | "accion"
  | "resultado"
  | "sistema";

interface FeedBase {
  seq: number;
  ts: string;
}

export interface FeedAlarma extends FeedBase {
  kind: "alarma";
  elementId: string;
  metric: SensorMetric;
  value: number;
  severidad: number;
}

/** Señal entrante sin procesar: el agente decide si cambia algo o es ruido */
export interface FeedReporte extends FeedBase {
  kind: "reporte";
  fuente: "redes" | "llamada_112" | "prensa" | "campo" | "sensor_averiado";
  texto: string;
  elementId: string | null;
}

export interface FeedDecision extends FeedBase {
  kind: "decision";
  elementId: string;
  decisionId: string;
  prioridad: number;
  razonamiento: string;
  provocaReplan: boolean;
}

export interface FeedAccion extends FeedBase {
  kind: "accion";
  elementId: string;
  actionId: string;
  tipo: ActionType;
  estado: ActionStatus;
  mensaje: string;
}

/** Resultado de una llamada real: lo que contestó la persona al otro lado */
export interface FeedResultado extends FeedBase {
  kind: "resultado";
  elementId: string | null;
  actionId: string;
  resultado: ResultadoLlamada;
  retrasoMinutos: number | null;
  resumen: string;
}

export interface FeedSistema extends FeedBase {
  kind: "sistema";
  mensaje: string;
}

export type FeedItem =
  | FeedAlarma
  | FeedReporte
  | FeedDecision
  | FeedAccion
  | FeedResultado
  | FeedSistema;

export interface FeedResponse {
  items: FeedItem[];
  ultimoSeq: number;
}

export type ControlAction =
  | "iniciar"
  | "reiniciar"
  | "pausar"
  | "reanudar"
  | "inyectar";

export interface InyectarPayload {
  elementId: string;
  metric: SensorMetric;
  value: number;
  severidad: number;
}

export interface ControlBody {
  accion: ControlAction;
  /** Evento a inyectar (solo acción "inyectar") */
  payload?: InyectarPayload;
}

export interface ControlResponse {
  ok: boolean;
  error?: string;
}

export interface HealthResponse {
  status: "ok" | "degradado";
  tick: number;
  pausado: boolean;
  /** false hasta que POST /api/control {accion:"iniciar"} arranca el guion */
  iniciado: boolean;
}
