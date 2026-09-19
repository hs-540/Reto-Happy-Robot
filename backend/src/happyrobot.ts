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
  /** Full URL of the mission hook; its presence selects the real client */
  webhookUrl?: string;
  onClosed: (closure: CallClosure) => void;
  /** A mission the hook accepted (2xx); the outcome poller only closes these */
  onDispatched?: (missionId: string) => void;
}

const TIMEOUT_MS = 90_000;

/* ─── Real client ────────────────────────────────────────────────────────
 * The hook is a secret URL: POST { prompt, missionId } and the mission's voice
 * agent places the call — no credential header, no phone number (the mission
 * knows who it calls). `missionId` is our `actionId`, the id of the action the
 * orchestrator decided, so a call is traceable end to end: dispatch, summary
 * event in the events-api and closure all carry it. If the hook's contract
 * changes, ONLY this function does; the outcome comes back through the poller
 * in `outcome-poll.ts`.
 */
function createRealClient(webhookUrl: string, options: HappyRobotOptions): HappyRobotClient {
  const { onClosed, onDispatched } = options;

  return {
    mode: "real",
    contact(request) {
      // The prompt is what the voice agent asks the person it calls: the
      // message written for this recipient, framed by the incident situation.
      const prompt = [request.context.situation, request.message].filter(Boolean).join(" ");

      void fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, missionId: request.actionId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HappyRobot answered ${res.status}`);
          // This only confirms the mission went out. The outcome arrives as a
          // call-summary event in the events-api, picked up by the poller.
          onDispatched?.(request.actionId);
          console.log(`[happyrobot] mission dispatched for ${request.contact.id}`);
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

      console.log(
        `[happyrobot:simulated] ${request.channel} to ${request.contact.id} → ${reply.outcome}`,
      );
      setTimeout(() => {
        onClosed({ actionId: request.actionId, ...reply });
      }, SIMULATED_LATENCY[request.channel]);
    },
  };
}

/**
 * Picks a client based on whether the mission hook is configured. Starting with
 * no calls at all is worse than starting with simulated ones: the latter keeps
 * the whole chain standing and turns the integration into an env change.
 */
export function createHappyRobotClient(options: HappyRobotOptions): HappyRobotClient {
  if (options.webhookUrl) return createRealClient(options.webhookUrl, options);
  console.warn(
    "[happyrobot] no mission hook configured: communications are simulated and the demo stays up",
  );
  return createSimulatedClient(options.onClosed);
}
