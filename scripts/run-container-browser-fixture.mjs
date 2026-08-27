import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/responses-protocol-server.mjs", import.meta.url),
);
const port = Number(process.env.AIRLOCK_CONTAINER_BROWSER_PORT ?? "3221");
const fixturePort = Number(
  process.env.AIRLOCK_CONTAINER_BROWSER_FIXTURE_PORT ?? "43994",
);
const stateRoot = path.resolve(
  repoRoot,
  process.env.AIRLOCK_CONTAINER_BROWSER_DATA_ROOT ?? ".e2e-container-browser",
);

function safeHostEnvironment() {
  const environment = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function commandWorks(command) {
  try {
    await execFile(command, ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function detectEngine() {
  const configured = process.env.CONTAINER_ENGINE?.trim();
  const candidates = configured ? [configured] : ["docker", "podman"];
  for (const candidate of candidates) {
    if (await commandWorks(candidate)) return candidate;
  }
  throw new Error("A running Docker or Podman engine is required");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const expectedRoot = path.join(repoRoot, ".e2e-container-browser");
if (stateRoot !== expectedRoot) {
  throw new Error(
    "AIRLOCK_CONTAINER_BROWSER_DATA_ROOT must resolve to the dedicated test root",
  );
}
await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });

const engine = await detectEngine();
const isPodman = path.basename(engine).toLowerCase() === "podman";
const fixtureHostname = isPodman
  ? "host.containers.internal"
  : "host.docker.internal";
const fixture = spawn(process.execPath, [fixturePath], {
  cwd: repoRoot,
  env: {
    ...safeHostEnvironment(),
    AIRLOCK_PROTOCOL_FIXTURE_HOST: "0.0.0.0",
    AIRLOCK_PROTOCOL_FIXTURE_PORT: String(fixturePort),
  },
  stdio: ["ignore", "ignore", "ignore"],
});
const app = spawn(process.execPath, [path.join(repoRoot, "apps/server/dist/index.js")], {
  cwd: repoRoot,
  env: {
    ...safeHostEnvironment(),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "silent",
    APP_DATA_DIR: path.join(stateRoot, "data"),
    AGENT_WORKSPACE_ROOT: path.join(stateRoot, "workspaces"),
    CODEX_HOME: path.join(stateRoot, "codex-home"),
    ARK_API_KEY: "deterministic-protocol-fixture",
    ARK_MODEL: "protocol-fixture",
    ARK_BASE_URL: `http://${fixtureHostname}:${fixturePort}/v1`,
    RUNTIME_PROVIDER: "container",
    CONTAINER_ENGINE: engine,
    CONTAINER_RUNTIME_IMAGE:
      process.env.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local",
    CONTAINER_HOST_GATEWAY: isPodman ? "false" : "true",
    CONTAINER_USER:
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : "1000:1000",
    RUNTIME_INSTANCE_ID: `browser-${process.pid}`,
    AIRLOCK_DEMO_MODE: "false",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await stopChild(app);
  await stopChild(fixture);
  await rm(stateRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0));
}
app.once("exit", (code) => {
  if (!stopping) void shutdown(code ?? 1);
});
fixture.once("exit", (code) => {
  if (!stopping) void shutdown(code ?? 1);
});

console.log(`[container-browser-fixture] http://127.0.0.1:${port}`);
