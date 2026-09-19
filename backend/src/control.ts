import { SensorEventSchema } from "@swarmup/shared";
import type { Action, ActionStatus } from "@swarmup/shared";
import { z } from "zod";
import type { Feed } from "./feed.js";

/** Variants of the POST /api/control body; `payload` required for `inject` */
export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("inject"), payload: SensorEventSchema.omit({ id: true }) }),
]);

export interface ActionRegistry {
  /**
   * Hook of the decision engine, no human gate (#43). The caller states the
   * born status: `queued` for a voice call waiting on a line in the call
   * queue, `executed` for one that dials right away.
   */
  record(data: Omit<Action, "id" | "status" | "timestamp">, status: ActionStatus): Action;
}

export function createActionRegistry(feed: Feed): ActionRegistry {
  let counter = 0;

  return {
    record(data, status) {
      counter += 1;
      const action: Action = {
        ...data,
        id: `act-${String(counter).padStart(3, "0")}`,
        status,
        timestamp: new Date().toISOString(),
      };
      feed.publish({
        kind: "action",
        elementId: action.targetElementId,
        actionId: action.id,
        type: action.type,
        status: action.status,
        message: action.message,
      });
      return action;
    },
  };
}
