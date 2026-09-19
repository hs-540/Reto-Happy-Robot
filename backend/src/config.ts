import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

/** An empty string counts as unset: optional URLs are switched off, not invalid */
const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  /* Engine cadence (design: tick every 5-10 s). At the demo's 5 s and 6x,
     30 crisis-seconds pass between ticks; the LLM wakes only on triggers, so
     call volume does not grow with the cadence. */
  TICK_MS: z.coerce.number().int().positive().default(2000),
  /* Crisis seconds per real second. 15x compresses 30 crisis-minutes into
     ~2 real minutes; a live demo usually wants less compression, because the
     LLM needs 15-48 s per deliberation and the clock should not outrun its own
     coordinator. 6x keeps one deliberation inside 3-5 crisis-minutes. */
  TIME_SCALE: z.coerce.number().int().positive().default(15),
  /* LLM provider with an OpenAI-compatible interface (Helmcode). The provider
     is configuration, not code: switching it means editing the `.env`, without
     touching this. */
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  /** Provider label; only shows up in logs */
  LLM_PROVIDER: z.string().min(1).default("helmcode"),
  /**
   * Master switch for real telephony. OFF unless someone turns it on: a call
   * reaches a person and cannot be taken back, so no combination of leftover
   * variables can make a phone ring on its own. Off, the simulated client runs
   * the same chain end to end and the hook is never contacted.
   */
  HAPPYROBOT_REAL_CALLS_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  /** Full URL of the HappyRobot mission hook; required once real calls are on */
  HAPPYROBOT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  /**
   * Key for the hook's `x-api-key`. HappyRobot can guard a webhook trigger with
   * one, and a guarded hook rejects every unauthenticated dispatch. Optional:
   * a hook left unguarded needs no key and the header is then not sent.
   */
  HAPPYROBOT_API_KEY: z.string().default(""),
  /** Outbound call queue: slots in flight, pending depth and the slot backstop */
  HAPPYROBOT_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(1),
  HAPPYROBOT_MAX_QUEUED_CALLS: z.coerce.number().int().positive().default(3),
  /* Backstop, not a deadline: it only fires when a closure never arrives. It
     has to clear the whole real round trip — call, summary, poll cadence and
     the LLM classification of the summary — or it releases the slot as
     no_answer moments before the true outcome lands. Measured on the live hook:
     an 87 s conversation closed at 120.3 s and lost to a 120 s backstop by
     287 ms, publishing a spurious no_answer over a call that had been accepted. */
  HAPPYROBOT_CALL_SLOT_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  /* Return path of a real call: the hook posts a call-summary event to this
     worker and the backend polls it for closures of the missions it sent. */
  EVENTS_API_URL: z.url().default("https://events-api.hs540events.workers.dev"),
  EVENTS_API_KEY: z.string().default(""),
  EVENTS_POLL_MS: z.coerce.number().int().positive().default(10_000),
  CHROMA_PATH: z.string().min(1).default("backend/chroma-data"),
  CHROMA_PORT: z.coerce.number().int().positive().default(8000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid configuration, the backend will not start. Problematic variables (values are not shown for security):",
  );
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

/* An empty secret would splice [REDACTED] into every character boundary, so
   only real values make the list */
const secrets = [
  parsed.data.LLM_API_KEY,
  parsed.data.HAPPYROBOT_WEBHOOK_URL ?? "",
  parsed.data.HAPPYROBOT_API_KEY,
  parsed.data.EVENTS_API_KEY,
].filter((secret) => secret.length > 0);

export function redactSecrets(text: string): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), text);
}

/**
 * A single provider. `createLlmClient` still receives a list and keeps its
 * failover logic: adding a backup means adding an entry here, not rewriting
 * the client. If this provider goes down, the engine degrades to the
 * deterministic fallback of `agent.ts` and the simulation does not stop.
 */
const llmProvider = {
  id: parsed.data.LLM_PROVIDER,
  url: parsed.data.LLM_BASE_URL,
  apiKey: parsed.data.LLM_API_KEY,
  model: parsed.data.LLM_MODEL,
  embeddingModel: parsed.data.LLM_EMBEDDING_MODEL,
} as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const prop of Object.values(value)) deepFreeze(prop);
  }
  return value;
}

export const config = deepFreeze({
  port: parsed.data.PORT,
  tickMs: parsed.data.TICK_MS,
  timeScale: parsed.data.TIME_SCALE,
  llm: {
    gateways: [llmProvider],
  },
  happyrobot: {
    realCallsEnabled: parsed.data.HAPPYROBOT_REAL_CALLS_ENABLED,
    webhookUrl: parsed.data.HAPPYROBOT_WEBHOOK_URL,
    apiKey: parsed.data.HAPPYROBOT_API_KEY,
    maxConcurrentCalls: parsed.data.HAPPYROBOT_MAX_CONCURRENT_CALLS,
    maxQueuedCalls: parsed.data.HAPPYROBOT_MAX_QUEUED_CALLS,
    callSlotTimeoutMs: parsed.data.HAPPYROBOT_CALL_SLOT_TIMEOUT_MS,
  },
  eventsApi: {
    url: parsed.data.EVENTS_API_URL,
    apiKey: parsed.data.EVENTS_API_KEY,
    pollMs: parsed.data.EVENTS_POLL_MS,
  },
  chroma: {
    path: path.resolve(repoRoot, parsed.data.CHROMA_PATH),
    port: parsed.data.CHROMA_PORT,
  },
});
