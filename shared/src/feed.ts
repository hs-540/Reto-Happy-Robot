import type { SensorMetric } from "./world.js";
import type { ActionStatus, ActionType } from "./agent.js";

export type FeedItemKind = "alarm" | "decision" | "action" | "system";

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

export interface FeedSystem extends FeedBase {
  kind: "system";
  message: string;
}

export type FeedItem = FeedAlarm | FeedDecision | FeedAction | FeedSystem;

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
