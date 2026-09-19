/**
 * Operator channel: the human talks to the agent while the crisis runs.
 *
 * The agent decides alone (#43, no human gate), but "alone" is not "deaf". An
 * operator who can see the map knows things no sensor reports — that a ward is
 * being evacuated, that a crew is already on that street — and until now had
 * no way to say so. This channel carries that, and it carries ORDERS: raise a
 * site's priority, send a named unit to a named place, stand a unit down.
 *
 * What it is NOT is a bypass of the hard rules. An order from the operator is
 * validated exactly like a proposal from the LLM, and a rejected one comes back
 * with the rule that rejected it. The demo is better for it: the one moment
 * where a human overrules the machine and the machine says no is worth more
 * than a hundred accepted orders.
 */

export type ChatAuthor = "operator" | "agent";

/**
 * What the operator asked for, once the agent has read their message. The text
 * stays conversational; this is the machine-readable part of it.
 *
 * - `prioritize` / `deprioritize` — a standing bias on a site's rule priority
 * - `assign` — send this unit to this site, now
 * - `release` — stand this unit down
 * - `note` — a standing instruction with no mechanical effect, carried into
 *   every deliberation from now on because the operator knows something the
 *   sensors do not
 */
export type DirectiveKind = "prioritize" | "deprioritize" | "assign" | "release" | "note";

export interface OperatorDirective {
  id: string;
  kind: DirectiveKind;
  /** site the order is about; null for a note that names no site */
  elementId: string | null;
  /** unit the order commits or stands down; null when it commits none */
  resourceId: string | null;
  /** what the operator wants, in their own words, as the agent understood it */
  note: string;
  /** false when the hard rules — or the world — refused it */
  accepted: boolean;
  /** the rule or fact that refused it; null when accepted */
  reason: string | null;
}

export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  text: string;
  ts: string;
  /** what the agent extracted and executed from the operator's turn it answers */
  directives: OperatorDirective[];
}

export interface ChatView {
  messages: ChatMessage[];
  /**
   * Directives still shaping every deliberation: priority biases and standing
   * notes. One-shot orders (`assign`, `release`) are not here — they already
   * happened.
   */
  standing: OperatorDirective[];
  /** the agent is reading the last turn and has not answered yet */
  thinking: boolean;
}

export interface ChatBody {
  text: string;
}

export interface ChatResponse {
  ok: boolean;
  error?: string;
}
