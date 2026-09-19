export type ActionType = "llamada_voz" | "mensaje_chat";

export type ActionStatus = "ejecutada";

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

/**
 * Lo que devuelve una llamada real. Si el contacto se niega o no puede ahora,
 * `retrasoMinutos` dice cuánto se aplaza: eso invalida el ETA con el que se hizo
 * el plan y es, por sí solo, un trigger de replanificación.
 */
export type ResultadoLlamada =
  | "aceptado"
  | "aceptado_con_retraso"
  | "rechazado"
  | "no_contesta";

export interface CierreLlamada {
  actionId: string;
  resultado: ResultadoLlamada;
  /** minutos de retraso que comunica el contacto; null si no aplica */
  retrasoMinutos: number | null;
  /** a qué se compromete, en sus palabras */
  compromiso: string | null;
  /** resumen de la conversación para el feed */
  resumen: string;
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
