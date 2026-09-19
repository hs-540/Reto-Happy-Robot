import type { SensorMetric } from "./world.js";
import type {
  ActionStatus,
  ActionType,
  CallOutcome,
  DirectiveDecision,
  DirectiveKind,
} from "./agent.js";

export type FeedItemKind =
  | "alarm"
  | "report"
  | "decision"
  | "action"
  | "outcome"
  | "directive"
  | "directive_response"
  | "system";

interface FeedBase {
  seq: number;
  ts: string;
}

export interface FeedAlarm extends FeedBase {
  kind: "alarm";
  elementId: string;
  metric: SensorMetric;
  value: number;
  severity: number;
}

/** Raw incoming signal: the agent decides whether it changes anything or is noise */
export interface FeedReport extends FeedBase {
  kind: "report";
  source: "social" | "emergency_call" | "press" | "field" | "faulty_sensor";
  text: string;
  elementId: string | null;
}

export interface FeedDecision extends FeedBase {
  kind: "decision";
  elementId: string;
  decisionId: string;
  priority: number;
  reasoning: string;
  provokesReplan: boolean;
}

export interface FeedAction extends FeedBase {
  kind: "action";
  elementId: string;
  actionId: string;
  type: ActionType;
  status: ActionStatus;
  message: string;
}

/** Result of a real call: what the person on the other end answered */
export interface FeedOutcome extends FeedBase {
  kind: "outcome";
  elementId: string | null;
  actionId: string;
  outcome: CallOutcome;
  delayMinutes: number | null;
  summary: string;
}

export interface FeedSystem extends FeedBase {
  kind: "system";
  message: string;
}

/** An operator directive reaching the agent: a pin on a site or a free-text order */
export interface FeedDirective extends FeedBase {
  kind: "directive";
  directiveId: string;
  directive: DirectiveKind;
  elementId: string | null;
  text: string;
}

/** What the agent answered once it deliberated with the directive */
export interface FeedDirectiveResponse extends FeedBase {
  kind: "directive_response";
  directiveId: string;
  decision: DirectiveDecision;
  reasoning: string;
}

export type FeedItem =
  | FeedAlarm
  | FeedReport
  | FeedDecision
  | FeedAction
  | FeedOutcome
  | FeedDirective
  | FeedDirectiveResponse
  | FeedSystem;

export interface FeedResponse {
  items: FeedItem[];
  lastSeq: number;
}

export type ControlAction =
  | "start"
  | "reset"
  | "pause"
  | "resume"
  | "inject"
  | "prioritize"
  | "unprioritize"
  | "order";

export interface InjectPayload {
  elementId: string;
  metric: SensorMetric;
  value: number;
  severity: number;
}

/** `prioritize`: raise the priority of one site (the optional note says why) */
export interface PrioritizePayload {
  elementId: string;
  note?: string;
}

/** `unprioritize`: withdraw the pin on a site */
export interface UnprioritizePayload {
  elementId: string;
}

/** `order`: free-text instruction for the agent, in the operator's words */
export interface OrderPayload {
  text: string;
}

export interface ControlBody {
  action: ControlAction;
  /** Event to inject or directive to send, depending on the action */
  payload?: InjectPayload | PrioritizePayload | UnprioritizePayload | OrderPayload;
}

export interface ControlResponse {
  ok: boolean;
  error?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  tick: number;
  paused: boolean;
  /** false until POST /api/control {action:"start"} starts the script */
  started: boolean;
}
