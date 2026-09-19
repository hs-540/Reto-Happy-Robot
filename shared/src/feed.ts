import type { SensorMetric } from "./world.js";
import type { ActionStatus, ActionType, CallOutcome } from "./agent.js";
import type { ChatAuthor } from "./chat.js";

export type FeedItemKind =
  | "alarm"
  | "report"
  | "decision"
  | "action"
  | "outcome"
  | "chat"
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

/** A turn of the operator channel, so a human intervention leaves a trace in the log */
export interface FeedChat extends FeedBase {
  kind: "chat";
  author: ChatAuthor;
  text: string;
  /** site the turn is about, when it names one */
  elementId: string | null;
}

export interface FeedSystem extends FeedBase {
  kind: "system";
  message: string;
  /** true when the entry is a key moment of the script (revealed as it fires) */
  moment?: boolean;
}

export type FeedItem =
  | FeedAlarm
  | FeedReport
  | FeedDecision
  | FeedAction
  | FeedOutcome
  | FeedChat
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
  | "inject";

export interface InjectPayload {
  elementId: string;
  metric: SensorMetric;
  value: number;
  severity: number;
}

export interface ControlBody {
  action: ControlAction;
  /** Event to inject (only for the "inject" action) */
  payload?: InjectPayload;
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
