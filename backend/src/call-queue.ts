import type { CallClosure } from "@swarmup/shared";
import type { Feed } from "./feed.js";
import type { ContactRequest, HappyRobotClient } from "./happyrobot.js";

export interface CallQueueOptions {
  feed: Feed;
  /**
   * The callable HappyRobot contacts (CONTACTS), in the order they were
   * written. This list IS the outbound capacity: one live call per contact.
   */
  lines: string[];
  /** pending depth (HAPPYROBOT_MAX_QUEUED_CALLS) */
  maxQueued: number;
  /** backstop: a contact with no closure for this long is released as no_answer */
  slotTimeoutMs: number;
  /** the agent's callback: invoked after the contact is released, closure untouched */
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

interface HeldLine {
  timer: ReturnType<typeof setTimeout>;
  /** index into `lines`, not the contact itself: a release must be unambiguous */
  lineIndex: number;
}

/**
 * Bounded outbound-call concurrency between the agent and the HappyRobot
 * client, and the balancer over the contact pool. A decorator, not a rewrite:
 * the agent keeps calling `happyrobot.contact(...)` and does not learn that a
 * queue exists — the queue only shapes what reaches the phone network, while
 * the agent decides at full speed. Each contact holds one call, from dial until
 * the closure for that `actionId` arrives (or the timeout fires); with every
 * contact busy the rest wait rather than going out, so shrinking the pool
 * narrows the whole system and a single contact serialises it. Only
 * `voice_call` takes a contact, `chat_message` passes straight through.
 */
export function createCallQueue(
  client: HappyRobotClient,
  options: CallQueueOptions,
): HappyRobotClient & { onClosed(closure: CallClosure): void } {
  const { feed, maxQueued, slotTimeoutMs, onClosed, isStillRelevant } = options;
  /* An empty pool still leaves one anonymous line, so the queue keeps working
     and the dispatch carries no contact — the body the hook took before the
     pool existed. Only reachable with the simulated client: a real one is never
     built without contacts. */
  const lines: (string | undefined)[] = options.lines.length > 0 ? options.lines : [undefined];
  /** actionIds currently holding a contact, each with its timeout backstop */
  const inFlight = new Map<string, HeldLine>();
  /** indices of `lines` on a call right now */
  const busy = new Set<number>();
  /** where the round-robin resumes, so the load spreads instead of piling on the first */
  let cursor = 0;
  const pending: PendingCall[] = [];
  let arrivals = 0;

  /** The next free contact, from the cursor onwards; -1 when all are busy */
  function takeLine(): number {
    for (let i = 0; i < lines.length; i++) {
      const index = (cursor + i) % lines.length;
      if (busy.has(index)) continue;
      busy.add(index);
      cursor = (index + 1) % lines.length;
      return index;
    }
    return -1;
  }

  function release(actionId: string): void {
    const held = inFlight.get(actionId);
    if (!held) return;
    clearTimeout(held.timer);
    busy.delete(held.lineIndex);
    inFlight.delete(actionId);
  }

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

  function dial(request: ContactRequest, lineIndex: number): void {
    publishStatus(request, "executed");
    inFlight.set(request.actionId, {
      timer: setTimeout(() => onSlotTimeout(request), slotTimeoutMs),
      lineIndex,
    });
    client.contact({ ...request, line: lines[lineIndex] });
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
    while (busy.size < lines.length && pending.length > 0) {
      const next = pending.splice(mostUrgentIndex(), 1)[0];
      if (!isStillRelevant(next.request)) {
        discard(next.request, `${next.request.context.elementId} no longer needs the call`);
        continue;
      }
      // Guaranteed by the loop condition: a contact is free
      dial(next.request, takeLine());
    }
  }

  function onSlotTimeout(request: ContactRequest): void {
    release(request.actionId);
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
      const lineIndex = takeLine();
      if (lineIndex !== -1) {
        dial(request, lineIndex);
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
      release(closure.actionId);
      pump();
      onClosed(closure);
    },
  };
}
