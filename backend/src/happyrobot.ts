import type { CallClosure, CallOutcome, Contact } from "@swarmup/shared";

/**
 * A real call takes about a minute to resolve. The engine does not wait for it:
 * it fires and keeps deciding; the outcome comes back through `onClosed` and
 * enters as a replanning trigger.
 */
export interface ContactRequest {
  actionId: string;
  contact: Contact;
  channel: "voice_call" | "chat_message";
  /** urgency of the target element; the call queue dials the highest first */
  priority: number;
  /** what has to be conveyed, already written for this recipient */
  message: string;
  /**
   * The HappyRobot contact that places this call, assigned by the call queue
   * from the pool in `CONTACTS` — never by the agent, which decides who to
   * reach, not which line reaches them. Absent when no pool is configured.
   */
  line?: string;
  /** incident context the voice agent uses to improvise */
  context: {
    elementId: string;
    situation: string;
  };
}

export interface HappyRobotClient {
  /** Fires the contact. Does not wait: the outcome arrives via the callback. */
  contact(request: ContactRequest): void;
  readonly mode: "real" | "simulated";
}

export interface HappyRobotOptions {
  /**
   * Master switch for real telephony (HAPPYROBOT_REAL_CALLS_ENABLED). Off by
   * default and checked before anything else: a real call reaches a person and
   * cannot be taken back, so ringing somebody has to be an explicit decision,
   * never the consequence of a hook URL left behind in an `.env`.
   */
  enabled?: boolean;
  /** Full URL of the mission hook; required for real calls */
  webhookUrl?: string;
  /** Key for the hook's `x-api-key`; empty when the hook is left unguarded */
  apiKey?: string;
  /**
   * The callable contacts (CONTACTS). Only its emptiness matters here — which
   * contact takes which call is the call queue's decision; with none, there is
   * nobody to dial and the hook is not used at all.
   */
  contacts?: string[];
  onClosed: (closure: CallClosure) => void;
  /** A mission the hook accepted (2xx); the outcome poller only closes these */
  onDispatched?: (missionId: string) => void;
}

const TIMEOUT_MS = 90_000;

/* ─── Real client ────────────────────────────────────────────────────────
 * POST { prompt, missionId, contact } to the mission hook and its voice agent
 * places the call — no phone number, the mission resolves the contact it was
 * given into someone to ring. A hook guarded on the
 * HappyRobot side rejects anything without a valid `x-api-key`, so the key goes
 * on every dispatch when there is one. `missionId` is our `actionId`, the id of
 * the action the orchestrator decided, so a call is traceable end to end:
 * dispatch, summary event in the events-api and closure all carry it. If the
 * hook's contract changes, ONLY this function does; the outcome comes back
 * through the poller in `outcome-poll.ts`.
 */
/**
 * The brief the voice agent improvises from. It is not the message on its own:
 * a bare fragment leaves the agent with no role, nobody to address and nothing
 * to come back with, and the mission hangs up without dialling. Measured
 * against the hook: a two-sentence prompt produced a run with no transcript at
 * all, the same brief with role, recipient, situation and an explicit ask
 * produced a real conversation that closed with a commitment in minutes.
 */
export function buildPrompt(request: ContactRequest): string {
  const { contact, context, message, actionId } = request;
  return [
    "You are an autonomous emergency coordination agent for the Blackout Coordination Unit.",
    `You are CALLING ${contact.name}, ${contact.role}; the person on the other side is the field responder, not a customer.`,
    `Mission ${actionId}.`,
    context.situation ? `Situation: ${context.situation}` : "",
    `Affected site: ${context.elementId}.`,
    `Convey this and nothing else: "${message}"`,
    "Goal: get a concrete answer — whether they accept, and how many minutes they need. Obtain a commitment in minutes before ending the call.",
  ]
    .filter(Boolean)
    .join(" ");
}

function createRealClient(webhookUrl: string, options: HappyRobotOptions): HappyRobotClient {
  const { apiKey, onClosed, onDispatched } = options;

  return {
    mode: "real",
    contact(request) {
      const prompt = buildPrompt(request);

      void fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // An unguarded hook takes no key; sending an empty one would fail it
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        // No line means no pool was configured; the body is then the one the
        // hook took before contacts existed, down to the byte.
        body: JSON.stringify({
          prompt,
          missionId: request.actionId,
          ...(request.line ? { contact: request.line } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HappyRobot answered ${res.status}`);
          // This only confirms the mission went out. The outcome arrives as a
          // call-summary event in the events-api, picked up by the poller.
          onDispatched?.(request.actionId);
          console.log(
            `[happyrobot] mission dispatched for ${request.contact.id}${
              request.line ? ` on ${request.line}` : ""
            }`,
          );
        })
        .catch((err: unknown) => {
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`[happyrobot] could not reach ${request.contact.id}: ${cause}`);
          // A platform failure cannot freeze the crisis: it closes as
          // "no_answer" and the agent replans with that information.
          onClosed({
            actionId: request.actionId,
            outcome: "no_answer",
            delayMinutes: null,
            commitment: null,
            summary: `Could not reach ${request.contact.name}: ${cause}`,
          });
        });
    },
  };
}

/* ─── Simulated client ───────────────────────────────────────────────────
 * Without a credential the whole chain still gets exercised: the agent makes
 * contact, someone answers and the outcome returns as a trigger. Responses are
 * deterministic and scripted so the demo keeps its moment of tension.
 */
interface ScriptedReply {
  outcome: CallOutcome;
  delayMinutes: number | null;
  commitment: string | null;
  summary: string;
}

/** How long each channel takes to "answer", in real ms */
const SIMULATED_LATENCY: Record<ContactRequest["channel"], number> = {
  voice_call: 8_000,
  chat_message: 2_000,
};

function replyFor(contact: Contact, attempt: number): ScriptedReply {
  // The crew chief refuses the first time, and with reason: abandoning a
  // half-finished splice costs more than it saves (hist-sub-003).
  if (contact.id === "crew-chief" && attempt === 1) {
    return {
      outcome: "refused",
      delayMinutes: 22,
      commitment: "Finishes the splice and leaves afterwards",
      summary: `${contact.name} refuses to abandon the repair half-done: picking it back up would cost 22 minutes more than it saves`,
    };
  }
  if (contact.id === "crew-chief") {
    return {
      outcome: "accepted_with_delay",
      delayMinutes: 8,
      commitment: "Secures the splice and leaves in 8 minutes",
      summary: `${contact.name} accepts once the splice is secured; leaving in 8 minutes`,
    };
  }
  if (contact.id === "tanker-driver") {
    return {
      outcome: "accepted_with_delay",
      delayMinutes: 6,
      commitment: "Reroutes around the perimeter",
      summary: `${contact.name} accepts the detour; the usual approach is closed and it costs 6 minutes`,
    };
  }
  return {
    outcome: "accepted",
    delayMinutes: null,
    commitment: "Confirms and executes",
    summary: `${contact.name} confirms the instruction`,
  };
}

function createSimulatedClient(onClosed: HappyRobotOptions["onClosed"]): HappyRobotClient {
  const attempts = new Map<string, number>();

  return {
    mode: "simulated",
    contact(request) {
      const attempt = (attempts.get(request.contact.id) ?? 0) + 1;
      attempts.set(request.contact.id, attempt);
      const reply = replyFor(request.contact, attempt);

      // The line is logged here too: with the phones off this console is the
      // only place the balancer's spread can be watched.
      console.log(
        `[happyrobot:simulated] ${request.channel} to ${request.contact.id}${
          request.line ? ` on ${request.line}` : ""
        } → ${reply.outcome}`,
      );
      setTimeout(() => {
        onClosed({ actionId: request.actionId, ...reply });
      }, SIMULATED_LATENCY[request.channel]);
    },
  };
}

/**
 * Real telephony takes three things, in this order: somebody asked for it,
 * there is a hook to ask through, and there is at least one contact to reach.
 * Falling back to the simulated client rather than to no calls at all keeps the
 * whole chain standing — agent, queue, closure and replan all run — so turning
 * the phones on stays an env change. The three refusals log differently on
 * purpose: "off", "no hook" and "nobody to call" are not the same problem, and
 * whoever reads the console needs to tell them apart.
 */
export function createHappyRobotClient(options: HappyRobotOptions): HappyRobotClient {
  if (!options.enabled) {
    console.warn(
      "[happyrobot] real calls are OFF (HAPPYROBOT_REAL_CALLS_ENABLED): communications are simulated and no phone rings",
    );
    return createSimulatedClient(options.onClosed);
  }
  if (!options.webhookUrl) {
    console.warn(
      "[happyrobot] real calls are ON but no mission hook is configured (HAPPYROBOT_WEBHOOK_URL): communications are simulated",
    );
    return createSimulatedClient(options.onClosed);
  }
  if (!options.contacts?.length) {
    console.warn(
      "[happyrobot] real calls are ON but the contact pool is empty (CONTACTS): there is nobody to dial, the hook is not used and communications are simulated",
    );
    return createSimulatedClient(options.onClosed);
  }
  return createRealClient(options.webhookUrl, options);
}
