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
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter(
  (argument) => !["--demo", "--ephemeral", "--reset"].includes(argument),
);
if (unknownArguments.length > 0) {
  throw new Error("Unknown container fixture option: " + unknownArguments.join(", "));
}
const demoRequested = argumentsList.includes("--demo");
const ephemeralRequested = argumentsList.includes("--ephemeral");
const resetRequested = argumentsList.includes("--reset");
if ((resetRequested || ephemeralRequested) && !demoRequested) {
  throw new Error("--reset and --ephemeral are available only with --demo");
}
if (resetRequested && ephemeralRequested) {
  throw new Error("--reset and --ephemeral are mutually exclusive");
}
const port = Number(
  demoRequested
    ? process.env.AIRLOCK_CONTAINER_DEMO_PORT ?? "3200"
    : process.env.AIRLOCK_CONTAINER_BROWSER_PORT ?? "3221",
);
const fixturePort = Number(
  demoRequested
    ? process.env.AIRLOCK_CONTAINER_DEMO_FIXTURE_PORT ?? "43994"
    : process.env.AIRLOCK_CONTAINER_BROWSER_FIXTURE_PORT ?? "43994",
);
for (const [name, value] of [
  [demoRequested ? "AIRLOCK_CONTAINER_DEMO_PORT" : "AIRLOCK_CONTAINER_BROWSER_PORT", port],
  [
    demoRequested
      ? "AIRLOCK_CONTAINER_DEMO_FIXTURE_PORT"
      : "AIRLOCK_CONTAINER_BROWSER_FIXTURE_PORT",
    fixturePort,
  ],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(name + " must be an integer from 1 through 65535");
  }
}
if (port === fixturePort) {
  throw new Error("The control-plane and Responses fixture ports must be distinct");
}
const stateRoot = path.resolve(
  repoRoot,
  demoRequested
    ? ephemeralRequested
      ? ".e2e-container-demo"
      : ".local/airlock-container-demo"
    : process.env.AIRLOCK_CONTAINER_BROWSER_DATA_ROOT ?? ".e2e-container-browser",
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

async function waitForReady(url, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(label + " did not become ready");
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${pathname}`);
  }
  return raw ? JSON.parse(raw) : null;
}

async function seedProtocolDemo(baseUrl) {
  const { agents } = await requestJson(baseUrl, "/api/agents");
  const matches = agents.filter((agent) => agent.name === "Real Runtime Proof");
  if (matches.length > 1) {
    throw new Error("The managed demo contains duplicate Real Runtime Proof Agents");
  }
  const contract = {
    requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
    protectedPaths: ["AGENTS.md"],
    maxChangedFiles: 4,
    maxAddedBytes: 4_096,
    secretPatterns: [],
    validationCommands: [
      {
        name: "protocol-content",
        command: 'test "$(cat protocol-proof.txt)" = candidate-only',
        required: true,
        timeoutMs: 10_000,
      },
    ],
  };
  let agent = matches[0];
  if (!agent) {
    ({ agent } = await requestJson(baseUrl, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Real Runtime Proof",
        description: "Real Codex, isolated Candidate, validated Promotion",
        instructions:
          "Keep every change inside isolated Candidate State and complete the requested protocol proof.",
      }),
    }));
    await requestJson(baseUrl, `/api/agents/${agent.id}/outcome-contract`, {
      method: "PUT",
      body: JSON.stringify(contract),
    });
    return agent;
  }
  const persistedContract = {
    requiredPaths: agent.outcomeContract.requiredPaths,
    protectedPaths: agent.outcomeContract.protectedPaths,
    maxChangedFiles: agent.outcomeContract.maxChangedFiles,
    maxAddedBytes: agent.outcomeContract.maxAddedBytes,
    secretPatterns: agent.outcomeContract.secretPatterns,
    validationCommands: agent.outcomeContract.validationCommands,
  };
  if (JSON.stringify(persistedContract) !== JSON.stringify(contract)) {
    throw new Error(
      "The persisted Real Runtime Proof Outcome Contract changed. Restart with --reset for the guaranteed judge path.",
    );
  }
  return agent;
}

const expectedRoot = path.join(
  repoRoot,
  demoRequested
    ? ephemeralRequested
      ? ".e2e-container-demo"
      : ".local/airlock-container-demo"
    : ".e2e-container-browser",
);
if (stateRoot !== expectedRoot) {
  throw new Error(
    "Container fixture state must resolve to its dedicated managed root",
  );
}
if (!demoRequested || resetRequested || ephemeralRequested) {
  await rm(stateRoot, { recursive: true, force: true });
}
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
    AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
  },
  stdio: demoRequested ? "inherit" : ["ignore", "ignore", "pipe"],
});

let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await stopChild(app);
  await stopChild(fixture);
  if (!demoRequested || ephemeralRequested) {
    await rm(stateRoot, { recursive: true, force: true });
  }
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

const baseUrl = `http://127.0.0.1:${port}`;
try {
  await Promise.all([
    waitForReady(baseUrl + "/api/health", "Agent Airlock control plane"),
    waitForReady(
      `http://127.0.0.1:${fixturePort}/health`,
      "Local Responses fixture",
    ),
  ]);
  if (demoRequested) {
    await seedProtocolDemo(baseUrl);
    console.log("");
    console.log("Agent Airlock real Runtime proof is ready: " + baseUrl);
    console.log("Runtime: real pinned Codex CLI in a disposable container.");
    console.log("Inference: local deterministic Responses fixture.");
    console.log("Cost: no ModelArk request or paid inference.");
    console.log("Prompt: Create protocol-proof.txt.");
    console.log("Expected: Candidate validation passes and Promotion advances Canonical State.");
    console.log(
      ephemeralRequested
        ? "State: ephemeral automated proof."
        : "State persists across restart. Add --reset for a clean proof.",
    );
    console.log("");
  } else {
    console.log(`[container-browser-fixture] ${baseUrl}`);
  }
} catch (error) {
  console.error(
    "[container-browser-fixture] " +
      (error instanceof Error ? error.message : "Startup failed"),
  );
  await shutdown(1);
}
