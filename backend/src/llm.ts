import OpenAI, { APIConnectionError, APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";
import type { LlmUsage, RunStats } from "./stats.js";

/**
 * Budget per gateway attempt, and the wall clock the agent's own deliberation
 * budget is built from (see `DELIBERATION_BUDGET_MS` in `agent.ts`).
 *
 * Re-measured against Helmcode with the agent's real prompt (3.3k input
 * tokens), 23 uncached calls: 15.4 / 20.4 / 20.7 / 23.0 / 23.8 / 24.8 / 26.5 /
 * 30.6 / 34.3 / 35.7 / 35.8 / 36.4 / 36.5 / 38.5 / 40.8 / 43.7 / 52.3 / 59.1 /
 * 62.4 / 65.3 / 68.7 / 101.4 / 112.5 seconds. The "8-19s" this constant was
 * calibrated on no longer holds: that window only reproduces on a prompt the
 * provider has already cached (repeat calls came back in 0.7-0.9s).
 *
 * At 45s this timeout was itself the main source of fallbacks — it cut off 7 of
 * 23 calls that were still answering. 60s still cut off 5 of 23 (59.1 / 62.4 /
 * 65.3 / 68.7 / 101.4 / 112.5), and with a single gateway there is no failover:
 * every cutoff was a whole deliberation thrown away for "Contingency mode".
 * 90s covers 21 of 23. The agent's budget (`DELIBERATION_BUDGET_MS`) follows
 * from this constant, so one attempt always fits; the cost is an answer that
 * describes a world several crisis-minutes older — cheaper than the
 * deterministic playbook taking over every other turn.
 */
export const ATTEMPT_TIMEOUT_MS = 90_000;

/**
 * Requested ceiling on the answer. It is sent, but on this gateway it is NOT
 * what caps latency — measured with `max_tokens: 3000`, the same call came back
 * with 4.4k-14.4k completion tokens (2.9k-12.7k of them reasoning tokens) and
 * `finish_reason: "stop"` every time. `max_completion_tokens` and
 * `reasoning_effort: "low"` were measured too and are ignored just the same.
 * Nothing we can put in the request makes this model think less; the only real
 * lever left is the size of the prompt. Kept because it costs nothing and
 * would bind on a provider that does honour it.
 */
const MAX_OUTPUT_TOKENS = 3_000;

export interface LlmGateway {
  id: string;
  url: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
}

export interface LlmResponse {
  text: string;
  gateway: string;
  model: string;
  latencyMs: number;
}

export interface StructuredLlmResponse<T> extends LlmResponse {
  data: T;
}

export interface LlmClient {
  structured<T>(
    messages: ChatCompletionMessageParam[],
    schema: z.ZodType<T>,
    name: string,
  ): Promise<StructuredLlmResponse<T>>;
  /** Vectors aligned with `texts` (same position and length) */
  embeddings(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Classifies the error to decide whether to try the next gateway.
 * A gateway that rejects the credential (401) or denies service (403: expired
 * key, spent credit, unverified account) is as unavailable as one returning
 * 500 — and those are exactly the failures that show up live.
 * `null` = error on our request side, retrying on another gateway would not help.
 */
function failureReason(err: unknown): string | null {
  if (err instanceof APIConnectionError) return "timeout or connection";
  if (err instanceof APIError && err.status !== null) {
    if (err.status === 401) return "401 credential rejected";
    if (err.status === 403) return "403 service denied (credit or account)";
    if (err.status === 404) return "404 model not served by this gateway";
    if (err.status === 429) return "429";
    if (err.status >= 500) return `status ${err.status}`;
  }
  return null;
}

interface GatewayAttempt {
  gw: LlmGateway;
  client: OpenAI;
}

export function createLlmClient(gateways: readonly LlmGateway[], stats?: RunStats): LlmClient {
  const attempts: GatewayAttempt[] = gateways.map((gw) => ({
    gw,
    client: new OpenAI({
      baseURL: gw.url,
      apiKey: gw.apiKey,
      timeout: ATTEMPT_TIMEOUT_MS,
      maxRetries: 0,
    }),
  }));

  async function withFailover<T>(
    operation: (attempt: GatewayAttempt) => Promise<T>,
    describe?: (result: T) => string,
  ): Promise<{ result: T; gw: LlmGateway; latencyMs: number }> {
    let lastError: unknown;
    for (const attempt of attempts) {
      const start = performance.now();
      try {
        const result = await operation(attempt);
        const latencyMs = Math.round(performance.now() - start);
        console.log(
          `[llm] response via ${attempt.gw.id} (${latencyMs} ms${describe ? describe(result) : ""})`,
        );
        return { result, gw: attempt.gw, latencyMs };
      } catch (err) {
        lastError = err;
        const reason = failureReason(err);
        if (reason === null) throw err;
        const hasNext = attempt !== attempts[attempts.length - 1];
        console.error(
          `[llm] gateway ${attempt.gw.id} failed (${reason})${hasNext ? "; failing over to the next one" : "; no more gateways"}`,
        );
      }
    }
    throw new Error(`all gateways failed (${gateways.map((g) => g.id).join(", ")})`, {
      cause: lastError,
    });
  }

  return {
    structured: async (messages, schema, name) => {
      const { result, gw, latencyMs } = await withFailover(
        ({ client, gw }: GatewayAttempt) =>
          client.chat.completions.parse({
            model: gw.model,
            messages,
            response_format: zodResponseFormat(schema, name),
            max_tokens: MAX_OUTPUT_TOKENS,
          }),
        (completion) => {
          const usage = completion.usage;
          if (!usage) return "";
          return `, ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} tokens`;
        },
      );
      const usage: LlmUsage | null = result.usage
        ? {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            totalTokens: result.usage.total_tokens,
          }
        : null;
      stats?.recordLlmCall(latencyMs, usage);
      const message = result.choices[0]?.message;
      const text = message?.content ?? "";
      const data = message?.parsed;
      if (text === "" || data == null) {
        throw new Error(`gateway ${gw.id} did not return valid structured output`);
      }
      return { text, data, gateway: gw.id, model: gw.model, latencyMs };
    },

    embeddings: async (texts) => {
      if (texts.length === 0) return [];
      const { result, gw } = await withFailover(
        ({ client, gw }: GatewayAttempt) =>
          client.embeddings.create({ model: gw.embeddingModel, input: [...texts] }),
        (response) => {
          const usage = response.usage;
          if (!usage) return "";
          return `, ${usage.prompt_tokens} prompt = ${usage.total_tokens} tokens`;
        },
      );
      const vectors = result.data.map((d) => d.embedding);
      if (
        vectors.length !== texts.length ||
        vectors.some((v) => !Array.isArray(v) || v.length === 0)
      ) {
        throw new Error(`gateway ${gw.id} returned incomplete embeddings`);
      }
      return vectors;
    },
  };
}
