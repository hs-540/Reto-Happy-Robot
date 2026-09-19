import OpenAI, { APIConnectionError, APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";

/**
 * Budget per gateway attempt. Measured live against Helmcode with the agent's
 * real prompt (rules catalog + world + history): `deepseek-v4-flash` takes
 * between 8s and 19s because it reasons before answering, and latency grows as
 * the prompt swells during the run. With 10s (calibrated for `gpt-4.1-mini`)
 * only 1 in 4 calls survived. The engine tick does not wait for the
 * deliberation, so this does not slow the simulation: it only avoids killing
 * responses that were already on their way.
 */
const TIMEOUT_MS = 35_000;

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
  chat(messages: ChatCompletionMessageParam[]): Promise<LlmResponse>;
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

export function createLlmClient(gateways: readonly LlmGateway[]): LlmClient {
  const attempts: GatewayAttempt[] = gateways.map((gw) => ({
    gw,
    client: new OpenAI({ baseURL: gw.url, apiKey: gw.apiKey, timeout: TIMEOUT_MS, maxRetries: 0 }),
  }));

  async function withFailover<T>(
    operation: (attempt: GatewayAttempt) => Promise<T>,
  ): Promise<{ result: T; gw: LlmGateway; latencyMs: number }> {
    let lastError: unknown;
    for (const attempt of attempts) {
      const start = performance.now();
      try {
        const result = await operation(attempt);
        const latencyMs = Math.round(performance.now() - start);
        console.log(`[llm] response via ${attempt.gw.id} (${latencyMs} ms)`);
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
    chat: async (messages) => {
      const { result, gw, latencyMs } = await withFailover(({ client, gw }: GatewayAttempt) =>
        client.chat.completions.create({ model: gw.model, messages }),
      );
      const text = result.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error(`gateway ${gw.id} returned an empty response`);
      return { text, gateway: gw.id, model: gw.model, latencyMs };
    },

    structured: async (messages, schema, name) => {
      const { result, gw, latencyMs } = await withFailover(({ client, gw }: GatewayAttempt) =>
        client.chat.completions.parse({
          model: gw.model,
          messages,
          response_format: zodResponseFormat(schema, name),
        }),
      );
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
      const { result, gw } = await withFailover(({ client, gw }: GatewayAttempt) =>
        client.embeddings.create({ model: gw.embeddingModel, input: [...texts] }),
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
