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

/**
 * Operator-to-agent channel. The crisis manager stays autonomous: a directive
 * is handed to the deliberation, the agent weighs it against the hard rules and
 * answers it — it can acknowledge it or reject it with facts, never silently.
 */
export type DirectiveKind =
  /** demand for attention on one site, from the map or the sites list */
  | "priority_pin"
  /** free-text order in natural language */
  | "order";

export type DirectiveStatus =
  /** the agent has not answered it yet */
  | "open"
  /** the agent complied */
  | "acknowledged"
  /** the agent overruled the operator, with reasoning */
  | "rejected";

export type DirectiveDecision = "acknowledged" | "rejected";

export interface Directive {
  id: string;
  kind: DirectiveKind;
  /** site the directive is about; null for a free-form order */
  elementId: string | null;
  /** what the operator asks, verbatim (a pin carries its optional note here) */
  text: string;
  status: DirectiveStatus;
  /** the agent's answer once a deliberation has processed the directive */
  responseReasoning: string | null;
  createdAt: string;
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
  /** operator directives, most recent first; orders leave once answered */
  directives: Directive[];
}
