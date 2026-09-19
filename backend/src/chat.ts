import type { ChatMessage, ChatView, OperatorDirective, StateView } from "@swarmup/shared";
import type { Agent } from "./agent.js";
import type { Feed } from "./feed.js";
import type { LlmClient } from "./llm.js";
import { ChatReplySchema, buildChatMessages } from "./prompt.js";
import type { World } from "./world.js";
import type { Remedies } from "@swarmup/shared";

/**
 * Turns kept in the conversation. The chat is a demo-length exchange, not a
 * correspondence: the cap exists so a wedged client cannot grow it without
 * bound, not because anything trims in practice.
 */
const MAX_MESSAGES = 60;

/**
 * Turns handed back to the model as conversation. Enough to keep a
 * two-exchange thread coherent ("and the other one too" right after an order),
 * short enough that the chat prompt stays a fraction of a deliberation's.
 */
const HISTORY_TURNS = 8;

/** An operator turn longer than this is not a message, it is a paste */
const MAX_TEXT_LENGTH = 800;

export interface OperatorChat {
  /**
   * Records the operator's turn and starts the answer, WITHOUT waiting for it:
   * the model takes seconds and the HTTP request must not. The reply lands in
   * `view()` when it is ready, which is what the client is polling anyway.
   */
  send(text: string): { ok: true } | { ok: false; error: string };
  view(): ChatView;
}

export interface OperatorChatOptions {
  llm: LlmClient;
  feed: Feed;
  agent: Agent;
  world: World;
  remedies: Remedies;
  /** the world as the HTTP layer sees it, read at the moment the answer is composed */
  state: () => StateView;
}

export function createOperatorChat(options: OperatorChatOptions): OperatorChat {
  const { llm, feed, agent, world, remedies, state } = options;

  let messages: ChatMessage[] = [];
  /** an answer is in flight; the operator's next turn waits for it */
  let thinking = false;
  let counter = 0;

  function push(message: ChatMessage): void {
    messages = [...messages, message].slice(-MAX_MESSAGES);
  }

  function record(
    author: ChatMessage["author"],
    text: string,
    directives: OperatorDirective[],
    elementId: string | null,
  ): ChatMessage {
    counter += 1;
    const message: ChatMessage = {
      id: `msg-${String(counter).padStart(3, "0")}`,
      author,
      text,
      ts: new Date().toISOString(),
      directives,
    };
    push(message);
    // The operator channel is part of the run, not a side conversation: a
    // human intervention that leaves no trace in the log cannot be read back
    // afterwards, and the feed is what the run is judged on.
    feed.publish({ kind: "chat", author, text, elementId });
    return message;
  }

  /**
   * Appends, in the agent's own voice, what the engine did with the orders it
   * just read. Written here and not by the model on purpose: at the time the
   * model wrote its reply the orders had not been executed yet, so only this
   * side knows which rule refused what. A promise the machine then breaks is
   * the one failure mode this channel cannot afford.
   */
  function outcomeLine(directives: OperatorDirective[]): string {
    const refused = directives.filter((d) => !d.accepted);
    if (refused.length === 0) return "";
    return `\n\n${refused
      .map((d) => `✕ Not done — ${d.reason ?? "refused"}.`)
      .join("\n")}`;
  }

  async function answer(text: string): Promise<void> {
    const snapshot = state();
    try {
      const response = await llm.structured(
        buildChatMessages(
          {
            simulationClock: snapshot.simulationClock,
            elements: snapshot.elements,
            resources: snapshot.resources,
            secondsWithoutPower: (id) => world.secondsWithoutPower(id),
            priorities: world.priorities(snapshot.elements),
            currentPlan: agent.view().currentPlan,
            remedies,
            standing: agent.standing(),
            // the turn being answered is passed separately, so it is not in here
            history: messages.slice(-1 - HISTORY_TURNS, -1),
          },
          text,
        ),
        ChatReplySchema,
        "operator_chat",
      );
      // Executed against the live world, not the snapshot the model read: the
      // crisis moved while it was thinking, and the validator must judge the
      // world as it is now.
      const directives = agent.command(state(), response.data.directives);
      const reply = `${response.data.reply.trim()}${outcomeLine(directives)}`;
      record("agent", reply, directives, directives.find((d) => d.elementId)?.elementId ?? null);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      console.error(`[chat] the operator channel could not answer: ${cause}`);
      // Degrade the way the engine does: say what failed and what still runs.
      record(
        "agent",
        "I could not answer you: the channel to the model failed. My decision loop is not affected — the crisis is still being handled, and the event feed shows everything I do.",
        [],
        null,
      );
    } finally {
      thinking = false;
    }
  }

  return {
    send(text) {
      const clean = text.trim();
      if (clean === "") return { ok: false, error: "the message is empty" };
      if (clean.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: `the message exceeds ${MAX_TEXT_LENGTH} characters` };
      }
      if (thinking) return { ok: false, error: "the agent is still answering your last message" };

      thinking = true;
      record("operator", clean, [], null);
      void answer(clean);
      return { ok: true };
    },

    view() {
      return { messages, standing: agent.standing(), thinking };
    },
  };
}
