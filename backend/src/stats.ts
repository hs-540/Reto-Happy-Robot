export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmStats {
  calls: number;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  meanLatencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RunStatsSnapshot {
  llm: LlmStats;
  reactions: number;
  meanReactionMs: number | null;
}

/**
 * Per-run counters for the end-of-simulation summary: LLM latency and token
 * consumption per call, and how long the engine took to turn a trigger into an
 * executed decision. Everything is wall-clock; `reset()` starts a new run.
 */
export interface RunStats {
  recordLlmCall(latencyMs: number, usage: LlmUsage | null): void;
  /** Wall time from a deliberation trigger to its decision being executed */
  recordReaction(latencyMs: number): void;
  snapshot(): RunStatsSnapshot;
  reset(): void;
}

export function createRunStats(): RunStats {
  let calls = 0;
  let minLatencyMs: number | null = null;
  let maxLatencyMs: number | null = null;
  let totalLatencyMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reactions = 0;
  let totalReactionMs = 0;

  return {
    recordLlmCall(latencyMs, usage) {
      calls += 1;
      totalLatencyMs += latencyMs;
      minLatencyMs = minLatencyMs === null ? latencyMs : Math.min(minLatencyMs, latencyMs);
      maxLatencyMs = maxLatencyMs === null ? latencyMs : Math.max(maxLatencyMs, latencyMs);
      if (usage) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        totalTokens += usage.totalTokens;
      }
    },
    recordReaction(latencyMs) {
      reactions += 1;
      totalReactionMs += latencyMs;
    },
    snapshot() {
      return {
        llm: {
          calls,
          minLatencyMs,
          maxLatencyMs,
          meanLatencyMs: calls > 0 ? Math.round(totalLatencyMs / calls) : null,
          promptTokens,
          completionTokens,
          totalTokens,
        },
        reactions,
        meanReactionMs: reactions > 0 ? Math.round(totalReactionMs / reactions) : null,
      };
    },
    reset() {
      calls = 0;
      minLatencyMs = null;
      maxLatencyMs = null;
      totalLatencyMs = 0;
      promptTokens = 0;
      completionTokens = 0;
      totalTokens = 0;
      reactions = 0;
      totalReactionMs = 0;
    },
  };
}
