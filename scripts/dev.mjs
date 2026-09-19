import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const PORTS = [3001, 5173];

function freePort(port) {
  if (isWindows) return;
  const found = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pids = (found.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`[dev] freed port ${port} (killed pid ${pid})`);
    } catch {}
  }
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {}
}

const children = [];
let shuttingDown = false;

function shutdown() {
  for (const child of children) killTree(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) killTree(child, "SIGKILL");
  }, 3000);
  force.unref();
}

function start(name, args) {
  const child = spawn(isWindows ? "npm.cmd" : "npm", args, {
    stdio: "inherit",
    detached: !isWindows,
    shell: isWindows,
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[dev] ${name} exited; stopping the rest`);
    shutdown();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  children.push(child);
}

for (const port of PORTS) freePort(port);

start("backend", ["run", "dev:backend"]);
start("frontend", ["run", "dev:frontend"]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    shutdown();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}
