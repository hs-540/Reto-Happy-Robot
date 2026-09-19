import type { CallClosure } from "@swarmup/shared";
import type { Feed } from "./feed.js";
import type { ContactRequest, HappyRobotClient } from "./happyrobot.js";

export interface CallQueueOptions {
  feed: Feed;
  /** slots in flight (HAPPYROBOT_MAX_CONCURRENT_CALLS) */
  maxInFlight: number;
  /** pending depth (HAPPYROBOT_MAX_QUEUED_CALLS) */
  maxQueued: number;
  /** backstop: a slot with no closure for this long is released as no_answer */
  slotTimeoutMs: number;
  /** the agent's callback: invoked after the slot accounting, closure untouched */
  onClosed: (closure: CallClosure) => void;
  /**
   * Staleness gate, evaluated when the call is about to be dialled, not when it
   * is enqueued. Injected so this module stays free of world knowledge.
   */
  isStillRelevant: (request: ContactRequest) => boolean;
}

interface PendingCall {
  request: ContactRequest;
  /** arrival order; the tie-break when two pending calls are equally urgent */
  seq: number;
}

/**
 * Bounded outbound-call concurrency between the agent and the HappyRobot
 * client. A decorator, not a rewrite: the agent keeps calling
 * `happyrobot.contact(...)` and does not learn that a queue exists — the queue
 * only shapes what reaches the phone network, while the agent decides at full
 * speed. A slot is held from dial until the closure for that `actionId`
 * arrives (or the timeout fires); only `voice_call` consumes a line,
 * `chat_message` passes straight through.
 */
export function createCallQueue(
  client: HappyRobotClient,
  options: CallQueueOptions,
): HappyRobotClient & { onClosed(closure: CallClosure): void } {
  const { feed, maxInFlight, maxQueued, slotTimeoutMs, onClosed, isStillRelevant } = options;
  /** actionIds currently holding a slot, each with its timeout backstop */
  const inFlight = new Map<string, ReturnType<typeof setTimeout>>();
  const pending: PendingCall[] = [];
  let arrivals = 0;

  function publishStatus(request: ContactRequest, status: "executed" | "discarded"): void {
    feed.publish({
      kind: "action",
      elementId: request.context.elementId,
      actionId: request.actionId,
      type: request.channel,
      status,
      message: request.message,
    });
  }

  function discard(request: ContactRequest, why: string): void {
    publishStatus(request, "discarded");
    feed.publish({
      kind: "system",
      message: `Call to ${request.contact.name} discarded: ${why}`,
    });
  }

  function dial(request: ContactRequest): void {
    publishStatus(request, "executed");
    inFlight.set(request.actionId, setTimeout(() => onSlotTimeout(request), slotTimeoutMs));
    client.contact(request);
  }

  /** Index of the most urgent pending call; arrival order as tie-break */
  function mostUrgentIndex(): number {
    let best = 0;
    for (let i = 1; i < pending.length; i++) {
      if (pending[i].request.priority > pending[best].request.priority) best = i;
    }
    return best;
  }

  /** Index of the least urgent pending call; earliest arrival among equals */
  function leastUrgentIndex(): number {
    let worst = 0;
    for (let i = 1; i < pending.length; i++) {
      if (pending[i].request.priority < pending[worst].request.priority) worst = i;
    }
    return worst;
  }

  /** Fills freed capacity: stale calls fall out and the next live one dials, in the same pass */
  function pump(): void {
    while (inFlight.size < maxInFlight && pending.length > 0) {
      const next = pending.splice(mostUrgentIndex(), 1)[0];
      if (isStillRelevant(next.request)) {
        dial(next.request);
      } else {
        discard(next.request, `${next.request.context.elementId} no longer needs the call`);
      }
    }
  }

  function onSlotTimeout(request: ContactRequest): void {
    inFlight.delete(request.actionId);
    pump();
    // Same shape the client emits on a transport failure: without this, a lost
    // webhook would hold the slot forever and the demo would go silent.
    onClosed({
      actionId: request.actionId,
      outcome: "no_answer",
      delayMinutes: null,
      commitment: null,
      summary: `Could not reach ${request.contact.name}: no closure within ${slotTimeoutMs} ms`,
    });
  }

  return {
    mode: client.mode,
    contact(request) {
      if (request.channel !== "voice_call") {
        client.contact(request);
        return;
      }
      if (inFlight.size < maxInFlight) {
        dial(request);
        return;
      }
      if (pending.length < maxQueued) {
        pending.push({ request, seq: arrivals++ });
        return;
      }
      // Queue full: the incoming call competes with the least urgent pending one
      const worst = pending[leastUrgentIndex()];
      if (worst && request.priority > worst.request.priority) {
        pending.splice(leastUrgentIndex(), 1);
        discard(worst.request, `a more urgent call to ${request.contact.name} took its place`);
        pending.push({ request, seq: arrivals++ });
      } else {
        discard(
          request,
          `the call queue is full (${maxQueued} waiting) and the call is not more urgent than the pending ones`,
        );
      }
    },
    onClosed(closure) {
      // A closure for an unknown or already-released actionId (e.g. one that
      // timed out and whose webhook arrived late) is ignored for accounting but
      // still forwarded.
      if (!inFlight.has(closure.actionId)) {
        onClosed(closure);
        return;
      }
      const timer = inFlight.get(closure.actionId);
      clearTimeout(timer);
      inFlight.delete(closure.actionId);
      pump();
      onClosed(closure);
    },
  };
}
