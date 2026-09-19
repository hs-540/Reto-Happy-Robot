import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  TICK_MS: z.coerce.number().int().positive().default(5000),
  /* LLM provider with an OpenAI-compatible interface (Helmcode). The provider
     is configuration, not code: switching it means editing the `.env`, without
     touching this. */
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  /** Provider label; only shows up in logs */
  LLM_PROVIDER: z.string().min(1).default("helmcode"),
  HAPPYROBOT_API_KEY: z.string().min(1),
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

const secrets = [parsed.data.LLM_API_KEY, parsed.data.HAPPYROBOT_API_KEY];

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
  llm: {
    gateways: [llmProvider],
  },
  happyrobot: {
    apiKey: parsed.data.HAPPYROBOT_API_KEY,
  },
  chroma: {
    path: path.resolve(repoRoot, parsed.data.CHROMA_PATH),
    port: parsed.data.CHROMA_PORT,
  },
});
