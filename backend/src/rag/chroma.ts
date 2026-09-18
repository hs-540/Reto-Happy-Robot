import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { config } from "../config.js";

/** El arranque del servidor local puede tardar: da margen a la primera indexación del disco */
const ARRANQUE_TIMEOUT_MS = 15_000;
const SONDEO_MS = 250;

export interface ChromaLocal {
  cliente: ChromaClient;
  /** Detiene el servidor solo si lo arrancó este proceso; si reutilizó uno, no lo toca */
  parar(): Promise<void>;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function latido(puerto: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${puerto}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** chromadb solo exporta su entrada ("."), y el CLI del servidor vive junto a ella */
function rutaCli(): string {
  const entrada = fileURLToPath(import.meta.resolve("chromadb"));
  return entrada.replace(/chromadb\.mjs$/, "cli.mjs");
}

let hijoActual: ChildProcess | null = null;

function alSalir(): void {
  if (hijoActual?.exitCode === null) hijoActual.kill("SIGKILL");
}

function adjuntarHijo(hijo: ChildProcess): void {
  hijoActual = hijo;
  const errores = hijo.stderr;
  if (errores) {
    errores.setEncoding("utf8");
    errores.on("data", (trozo: string) => {
      for (const linea of trozo.split("\n")) {
        if (linea.trim()) console.error(`[chroma] ${linea.trim()}`);
      }
    });
  }
  if (hijo === hijoActual) {
    process.once("exit", alSalir);
    process.once("SIGINT", () => process.exit(130));
    process.once("SIGTERM", () => process.exit(143));
  }
}

async function detener(hijo: ChildProcess): Promise<void> {
  if (hijo.exitCode !== null) return;
  hijo.kill("SIGTERM");
  for (let i = 0; i < 10 && hijo.exitCode === null; i++) await dormir(300);
  if (hijo.exitCode === null) hijo.kill("SIGKILL");
  await new Promise<void>((resolve) => hijo.once("exit", () => resolve()));
}

/**
 * Servidor Chroma local y persistido en disco (DESIGN.md "Aprendizaje entre
 * ejecuciones"): reutiliza uno ya presente en el puerto o arranca el CLI que
 * distribuye el propio paquete `chromadb`, con `--path` desde config.
 */
export async function arrancarChroma(
  opciones?: { ruta?: string; puerto?: number },
): Promise<ChromaLocal> {
  const ruta = opciones?.ruta ?? config.chroma.path;
  const puerto = opciones?.puerto ?? config.chroma.port;

  if (await latido(puerto)) {
    console.log(`[chroma] reutilizando el servidor ya presente en el puerto ${puerto}`);
    return { cliente: new ChromaClient({ host: "localhost", port: puerto }), parar: async () => {} };
  }

  // sin wrapper (npx/npm): el PID del hijo debe ser el del servidor para poder pararlo
  const hijo = spawn(
    process.execPath,
    [rutaCli(), "run", "--path", ruta, "--port", String(puerto)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  adjuntarHijo(hijo);

  const inicio = Date.now();
  while (Date.now() - inicio < ARRANQUE_TIMEOUT_MS) {
    if (await latido(puerto)) {
      console.log(`[chroma] servidor local en el puerto ${puerto}, datos en ${ruta}`);
      return {
        cliente: new ChromaClient({ host: "localhost", port: puerto }),
        parar: () => detener(hijo),
      };
    }
    if (hijo.exitCode !== null) {
      // otro proceso pudo ganar la carrera por el puerto mientras fallaba el nuestro
      if (await latido(puerto)) {
        console.log(`[chroma] reutilizando el servidor ya presente en el puerto ${puerto}`);
        return {
          cliente: new ChromaClient({ host: "localhost", port: puerto }),
          parar: async () => {},
        };
      }
      throw new Error(`el servidor Chroma murió al arrancar (código ${hijo.exitCode})`);
    }
    await dormir(SONDEO_MS);
  }
  throw new Error(`el servidor Chroma no respondió en el puerto ${puerto} tras 15 s`);
}
