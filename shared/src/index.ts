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

export type ActionType = "llamada_voz" | "mensaje_chat";

export type ActionStatus = "propuesta" | "confirmada" | "ejecutada" | "rechazada";

export interface Action {
  id: string;
  type: ActionType;
  targetElementId: string;
  /** Persona/rol destinatario de la acción real (ej. "responsable_hospital") */
  destinatario?: string;
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

// ---------------------------------------------------------------------------
// GET /api/topology — estático, se sirve una vez al cargar
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /api/state — foto actual del mundo + recursos (se reemplaza entera)
// ---------------------------------------------------------------------------

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
  /** Último seq emitido en el feed; permite correlacionar /api/state con /api/feed */
  ultimoSeq: number;
  elementos: ElementView[];
  recursos: ResourceView[];
}

// ---------------------------------------------------------------------------
// GET /api/agent — la mente: plan, decisiones vivas y acciones
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  descripcion: string;
  elementId: string | null;
  completado: boolean;
}

export interface AgentPlan {
  objetivo: string;
  pasos: PlanStep[];
  generadoEn: string;
  /** decisionId que provocó este replan; null si es el plan inicial */
  replanDe: string | null;
}

export interface AgentView {
  tick: number;
  pausado: boolean;
  planActual: AgentPlan | null;
  decisiones: Decision[];
  acciones: Action[];
}

// ---------------------------------------------------------------------------
// GET /api/feed?since=<seq> — log append-only, se consume por cursor
// ---------------------------------------------------------------------------

export type FeedItemKind = "alarma" | "decision" | "accion" | "sistema";

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

export interface FeedSistema extends FeedBase {
  kind: "sistema";
  mensaje: string;
}

export type FeedItem = FeedAlarma | FeedDecision | FeedAccion | FeedSistema;

export interface FeedResponse {
  items: FeedItem[];
  ultimoSeq: number;
}

// ---------------------------------------------------------------------------
// POST /api/control — intervención humana
// ---------------------------------------------------------------------------

export type ControlAction =
  | "pausar"
  | "reanudar"
  | "confirmar"
  | "rechazar"
  | "inyectar";

export interface InyectarPayload {
  elementId: string;
  metric: SensorMetric;
  value: number;
  severidad: number;
}

export interface ControlBody {
  accion: ControlAction;
  /** actionId para confirmar/rechazar */
  id?: string;
  /** Evento a inyectar (solo acción "inyectar") */
  payload?: InyectarPayload;
}

export interface ControlResponse {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degradado";
  tick: number;
  pausado: boolean;
}
