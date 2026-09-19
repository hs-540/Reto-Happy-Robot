export type ActionType = "voice_call" | "chat_message";

/**
 * A voice call is born `queued` while it waits for a line in the call queue,
 * `executed` once dialled and `discarded` when the queue dropped or evicted it.
 */
export type ActionStatus = "queued" | "executed" | "discarded";

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

/**
 * What a real call returns. If the contact refuses or cannot act now,
 * `delayMinutes` says how long it slips: that invalidates the ETA the plan was
 * built on and is, by itself, a replanning trigger.
 */
export type CallOutcome = "accepted" | "accepted_with_delay" | "refused" | "no_answer";

export interface CallClosure {
  actionId: string;
  outcome: CallOutcome;
  /** minutes of delay the contact reports; null when not applicable */
  delayMinutes: number | null;
  /** what they commit to, in their own words */
  commitment: string | null;
  /** conversation summary for the feed */
  summary: string;
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
