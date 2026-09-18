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
