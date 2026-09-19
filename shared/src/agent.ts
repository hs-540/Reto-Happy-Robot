export type ActionType = "voice_call" | "chat_message";

export type ActionStatus = "executed";

export interface Action {
  id: string;
  type: ActionType;
  targetElementId: string;
  /** Person/role the real action is addressed to (e.g. "hospital_manager") */
  recipient?: string;
  status: ActionStatus;
  message: string;
  timestamp: string;
}

export interface Decision {
  id: string;
  timestamp: string;
  elementId: string;
  priority: number;
  reasoning: string;
  provokesReplan: boolean;
  actions: Action[];
}

export interface PlanStep {
  id: string;
  description: string;
  elementId: string | null;
  completed: boolean;
}

export interface AgentPlan {
  objective: string;
  steps: PlanStep[];
  generatedAt: string;
  /** decisionId that triggered this replan; null for the initial plan */
  replanOf: string | null;
}

export interface AgentView {
  tick: number;
  paused: boolean;
  currentPlan: AgentPlan | null;
  decisions: Decision[];
  actions: Action[];
}
