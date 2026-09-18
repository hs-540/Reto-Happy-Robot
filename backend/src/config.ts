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
  VERCEL_AI_GATEWAY_URL: z.url(),
  VERCEL_AI_GATEWAY_API_KEY: z.string().min(1),
  VERCEL_AI_GATEWAY_MODEL: z.string().min(1),
  CLOUDFLARE_AI_GATEWAY_URL: z.url(),
  CLOUDFLARE_AI_GATEWAY_API_KEY: z.string().min(1),
  CLOUDFLARE_AI_GATEWAY_MODEL: z.string().min(1),
  LLM_GATEWAY_ORDER: z
    .string()
    .default("vercel,cloudflare")
    .transform((valor) => valor.split(",").map((parte) => parte.trim().toLowerCase()))
    .pipe(z.array(z.enum(["vercel", "cloudflare"])).length(2))
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "cada gateway solo puede aparecer una vez",
    }),
  HAPPYROBOT_API_KEY: z.string().min(1),
  CHROMA_PATH: z.string().min(1).default("backend/chroma-data"),
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

const secrets = [
  parsed.data.VERCEL_AI_GATEWAY_API_KEY,
  parsed.data.CLOUDFLARE_AI_GATEWAY_API_KEY,
  parsed.data.HAPPYROBOT_API_KEY,
];

export function redactSecrets(text: string): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), text);
}

const gatewayPorId = {
  vercel: {
    id: "vercel",
    url: parsed.data.VERCEL_AI_GATEWAY_URL,
    apiKey: parsed.data.VERCEL_AI_GATEWAY_API_KEY,
    modelo: parsed.data.VERCEL_AI_GATEWAY_MODEL,
  },
  cloudflare: {
    id: "cloudflare",
    url: parsed.data.CLOUDFLARE_AI_GATEWAY_URL,
    apiKey: parsed.data.CLOUDFLARE_AI_GATEWAY_API_KEY,
    modelo: parsed.data.CLOUDFLARE_AI_GATEWAY_MODEL,
  },
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
    gateways: parsed.data.LLM_GATEWAY_ORDER.map((id) => gatewayPorId[id]),
  },
  happyrobot: {
    apiKey: parsed.data.HAPPYROBOT_API_KEY,
  },
  chromaPath: path.resolve(repoRoot, parsed.data.CHROMA_PATH),
});
