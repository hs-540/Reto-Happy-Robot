import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";

/** The local server startup can be slow: give it margin for the first disk indexing */
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

export interface LocalChroma {
  client: ChromaClient;
  /** Stops the server only if this process started it; if it reused one, it leaves it alone */
  stop(): Promise<void>;
}

export interface ChromaOptions {
  path: string;
  port: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function heartbeat(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** chromadb only exports its entry point ("."), and the server CLI lives next to it */
function cliPath(): string {
  const entry = fileURLToPath(import.meta.resolve("chromadb"));
  return entry.replace(/chromadb\.mjs$/, "cli.mjs");
}

let currentChild: ChildProcess | null = null;

function onExit(): void {
  if (currentChild?.exitCode === null) currentChild.kill("SIGKILL");
}

function attachChild(child: ChildProcess): void {
  currentChild = child;
  const errors = child.stderr;
  if (errors) {
    errors.setEncoding("utf8");
    errors.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.error(`[chroma] ${line.trim()}`);
      }
    });
  }
  if (child === currentChild) {
    process.once("exit", onExit);
    process.once("SIGINT", () => process.exit(130));
    process.once("SIGTERM", () => process.exit(143));
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 10 && child.exitCode === null; i++) await sleep(300);
  if (child.exitCode === null) child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

/**
 * Local, disk-persisted Chroma server (DESIGN.md "Learning between runs"):
 * reuses one already listening on the port or starts the CLI shipped by the
 * `chromadb` package itself, with `--path` from config.
 */
export async function startChroma(options: ChromaOptions): Promise<LocalChroma> {
  const { path, port } = options;

  if (await heartbeat(port)) {
    console.log(`[chroma] reusing the server already listening on port ${port}`);
    return { client: new ChromaClient({ host: "localhost", port }), stop: async () => {} };
  }

  // no wrapper (npx/npm): the child PID must be the server's so we can stop it
  const child = spawn(
    process.execPath,
    [cliPath(), "run", "--path", path, "--port", String(port)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  attachChild(child);

  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    if (await heartbeat(port)) {
      console.log(`[chroma] local server on port ${port}, data at ${path}`);
      return {
        client: new ChromaClient({ host: "localhost", port }),
        stop: () => terminate(child),
      };
    }
    if (child.exitCode !== null) {
      // another process may have won the race for the port while ours was failing
      if (await heartbeat(port)) {
        console.log(`[chroma] reusing the server already listening on port ${port}`);
        return {
          client: new ChromaClient({ host: "localhost", port }),
          stop: async () => {},
        };
      }
      throw new Error(`the Chroma server died on startup (exit code ${child.exitCode})`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`the Chroma server did not answer on port ${port} within 15 s`);
}
