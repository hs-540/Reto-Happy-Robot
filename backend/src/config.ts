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
  /* Proveedor LLM con interfaz OpenAI-compatible (Helmcode). El proveedor es
     configuración, no código: cambiarlo es editar el `.env`, sin tocar esto. */
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_EMBEDDING_MODEL: z.string().min(1).default("qwen3-embedding"),
  /** Etiqueta del proveedor; solo aparece en logs */
  LLM_PROVIDER: z.string().min(1).default("helmcode"),
  HAPPYROBOT_API_KEY: z.string().min(1),
  CHROMA_PATH: z.string().min(1).default("backend/chroma-data"),
  CHROMA_PORT: z.coerce.number().int().positive().default(8000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Configuración inválida, el backend no arranca. Variables con problema (los valores no se muestran por seguridad):",
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
 * Un solo proveedor. `crearClienteLlm` sigue recibiendo una lista y conserva su
 * lógica de failover: añadir un respaldo es añadir una entrada aquí, no
 * reescribir el cliente. Si este proveedor cae, el motor degrada al fallback
 * determinista de `agente.ts` y la simulación no se detiene.
 */
const proveedorLlm = {
  id: parsed.data.LLM_PROVIDER,
  url: parsed.data.LLM_BASE_URL,
  apiKey: parsed.data.LLM_API_KEY,
  modelo: parsed.data.LLM_MODEL,
  modeloEmbeddings: parsed.data.LLM_EMBEDDING_MODEL,
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
    gateways: [proveedorLlm],
  },
  happyrobot: {
    apiKey: parsed.data.HAPPYROBOT_API_KEY,
  },
  chroma: {
    path: path.resolve(repoRoot, parsed.data.CHROMA_PATH),
    port: parsed.data.CHROMA_PORT,
  },
});
