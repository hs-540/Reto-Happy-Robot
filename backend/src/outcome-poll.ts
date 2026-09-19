import type { CallClosure } from "@swarmup/shared";
import { z } from "zod";
import type { LlmClient } from "./llm.js";

/**
 * Return path of a real call. The HappyRobot hook does not call back: when the
 * voice agent hangs up, a call-summary event lands in the events-api worker and
 * this loop polls it, turning each summary of a mission WE dispatched into the
 * `CallClosure` that frees the call-queue slot and, on a refusal or a delay,
 * wakes the engine to replan.
 */
export interface OutcomePollerOptions {
  url: string;
  apiKey: string;
  pollMs: number;
  llm: LlmClient;
  /** only missions this process dispatched close a call */
  isTrackedMission: (missionId: string) => boolean;
  onClosed: (closure: CallClosure) => void;
}

/** Shape served by GET /api/get-events (events-api, single call-summary event) */
const callSummarySchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  missionId: z.string().min(1).nullable().default(null),
});

const eventsResponseSchema = z.object({
  events: z.array(callSummarySchema),
});

const FETCH_TIMEOUT_MS = 15_000;

/** The seen-id set only has to cover the since-window overlap, not the run */
const MAX_SEEN = 500;

const verdictSchema = z.object({
  outcome: z.enum(["accepted", "accepted_with_delay", "refused", "no_answer"]),
  delayMinutes: z.number().int().min(0).nullable(),
  commitment: z.string().min(1).nullable(),
});

/** When the classifier fails, the text still reaches the feed verbatim */
const FALLBACK_VERDICT = {
  outcome: "accepted",
  delayMinutes: null,
  commitment: null,
} as const;

/**
 * The summary is free text: what the person on the phone answered, as heard by
 * the voice agent. The `CallOutcome` enum is what the rest of the system
 * consumes, so something has to read one into the other.
 */
async function classify(llm: LlmClient, summary: string) {
  const { data } = await llm.structured(
    [
      {
        role: "user",
        content:
          "You read the summary of a phone call an emergency voice agent just made to coordinate a crisis response. Decide what the person on the call concluded.\n" +
          '- "accepted": they agree to do what was asked, now.\n' +
          '- "accepted_with_delay": they agree but need time; put the minutes in delayMinutes, null if they gave no number.\n' +
          '- "refused": they will not do it, even with a reason or a counter-offer.\n' +
          '- "no_answer": nobody really engaged.\n' +
          "commitment: what they committed to, in their own words, or null.\n" +
          `Call summary:\n"""\n${summary}\n"""`,
      },
    ],
    verdictSchema,
    "call_outcome",
  );
  return data;
}

export interface OutcomePoller {
  /** One pass: fetch the events created since the last pass and close their calls */
  poll(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createOutcomePoller(options: OutcomePollerOptions): OutcomePoller {
  const { url, apiKey, pollMs, llm, isTrackedMission, onClosed } = options;
  /**
   * Boot time, not the epoch: only events created by this run are ever
   * considered. A mission id reused by a later process (`act-001` again after a
   * restart) cannot then close a call it never dispatched.
   */
  let cursor = new Date().toISOString();
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    async poll(): Promise<void> {
      const since = cursor;
      try {
        const res = await fetch(
          `${url}/api/get-events?since=${encodeURIComponent(since)}&limit=50`,
          { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        );
        if (!res.ok) throw new Error(`events api answered ${res.status}`);
        const { events } = eventsResponseSchema.parse(await res.json());
        // Advanced only after a good response: a failed poll retries the same
        // window instead of silently skipping it, and the seen set absorbs the
        // overlap this inclusive window re-reads.
        cursor = new Date().toISOString();

        for (const event of events) {
          if (seen.has(event.id)) continue;
          const oldest = seen.values().next().value;
          if (oldest !== undefined && seen.size >= MAX_SEEN) seen.delete(oldest);
          seen.add(event.id);
          if (!event.missionId || !isTrackedMission(event.missionId)) continue;

          const verdict = await classify(llm, event.summary).catch((err: unknown) => {
            console.error(
              `[outcome-poll] classification failed for ${event.missionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return FALLBACK_VERDICT;
          });
          console.log(`[outcome-poll] call ${event.missionId} closed as ${verdict.outcome}`);
          onClosed({
            actionId: event.missionId,
            outcome: verdict.outcome,
            delayMinutes: verdict.delayMinutes,
            commitment: verdict.commitment,
            summary: event.summary,
          });
        }
      } catch (err: unknown) {
        // A dead events-api must not take the backend down: the queue's slot
        // backstop already bounds how long a closed call can hold a line.
        console.error(`[outcome-poll] poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    start() {
      if (timer) return;
      void this.poll();
      timer = setInterval(() => void this.poll(), pollMs);
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
