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
  apiKey: string;
  baseUrl: string;
  onClosed: (closure: CallClosure) => void;
}

const TIMEOUT_MS = 90_000;

/** Without a real credential nobody can be called; simulated mode covers it */
export function credentialUsable(apiKey: string): boolean {
  return apiKey.trim().length > 0 && apiKey.trim().toUpperCase() !== "PENDIENTE";
}

/* ─── Real client ────────────────────────────────────────────────────────
 * Documented endpoint: POST {baseUrl}/api/v1/dial/outbound with the API key
 * from Settings > Profile. The rest of their documentation sits behind a login,
 * so the exact body and response shape must be confirmed against their
 * reference before anyone relies on it: if it changes, ONLY this function does.
 */
function createRealClient(options: HappyRobotOptions): HappyRobotClient {
  const { apiKey, baseUrl, onClosed } = options;

  return {
    mode: "real",
    contact(request) {
      const body = {
        phone: request.contact.phone ?? undefined,
        // dynamic context the voice agent receives so it can improvise
        context: {
          role: request.contact.role,
          name: request.contact.name,
          message: request.message,
          site: request.context.elementId,
          situation: request.context.situation,
        },
      };

      void fetch(`${baseUrl}/api/v1/dial/outbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HappyRobot answered ${res.status}`);
          // The final outcome arrives by webhook at /api/call/outcome once the
          // voice agent hangs up. This only confirms the call went out.
          console.log(`[happyrobot] call dispatched to ${request.contact.id}`);
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
 * Picks a client based on whether a usable credential exists. Starting with no
 * calls at all is worse than starting with simulated ones: the latter keeps the
 * whole chain standing and turns the integration into an env change.
 */
export function createHappyRobotClient(options: HappyRobotOptions): HappyRobotClient {
  if (credentialUsable(options.apiKey)) return createRealClient(options);
  console.warn(
    "[happyrobot] no usable credential: communications are simulated and the demo stays up",
  );
  return createSimulatedClient(options.onClosed);
}
