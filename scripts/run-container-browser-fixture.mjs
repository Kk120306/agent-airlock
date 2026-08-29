import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertJudgeReadiness,
  inspectJudgeReadiness,
} from "./judge-readiness.mjs";
import { stopRuntimeProofChild } from "./runtime-proof-terminal.mjs";

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
const configuredProofRoot =
  process.env.AIRLOCK_RUNTIME_PROOF_ROOT?.trim() || null;
const configuredProofSessionRoot =
  process.env.AIRLOCK_RUNTIME_PROOF_SESSION_ROOT?.trim() || null;
const configuredProofSessionNonce =
  process.env.AIRLOCK_RUNTIME_PROOF_SESSION_NONCE?.trim() || null;
const configuredProofOwnerPid = Number(
  process.env.AIRLOCK_RUNTIME_PROOF_OWNER_PID ?? "",
);
if (
  [
    configuredProofRoot,
    configuredProofSessionRoot,
    configuredProofSessionNonce,
    process.env.AIRLOCK_RUNTIME_PROOF_OWNER_PID,
  ].some(Boolean) &&
  (!demoRequested ||
    !ephemeralRequested ||
    !configuredProofRoot ||
    !configuredProofSessionRoot ||
    !configuredProofSessionNonce ||
    !/^[a-f0-9-]{36}$/.test(configuredProofSessionNonce) ||
    !Number.isInteger(configuredProofOwnerPid) ||
    configuredProofOwnerPid < 1)
) {
  throw new Error(
    "A managed Runtime proof root, session root, and nonce require --demo --ephemeral together",
  );
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
const stateRoot = configuredProofSessionRoot
  ? path.resolve(configuredProofSessionRoot)
  : path.resolve(
      repoRoot,
      demoRequested
        ? ephemeralRequested
          ? ".e2e-container-demo"
          : ".local/airlock-container-demo"
        : process.env.AIRLOCK_CONTAINER_BROWSER_DATA_ROOT ??
            ".e2e-container-browser",
    );

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function assertManagedProofSession() {
  if (
    !configuredProofRoot ||
    !configuredProofSessionRoot ||
    !configuredProofSessionNonce
  ) {
    return;
  }
  const proofRoot = path.resolve(configuredProofRoot);
  const localRoot = path.join(repoRoot, ".local");
  const sessionsRoot = path.join(proofRoot, "sessions");
  if (
    proofRoot === localRoot ||
    !isStrictDescendant(localRoot, proofRoot) ||
    !isStrictDescendant(sessionsRoot, stateRoot)
  ) {
    throw new Error("The managed Runtime proof session path is outside its owner root");
  }
  const [proofStatus, sessionsStatus, rootStatus] = await Promise.all([
    lstat(proofRoot),
    lstat(sessionsRoot),
    lstat(stateRoot),
  ]);
  if (
    !proofStatus.isDirectory() ||
    proofStatus.isSymbolicLink() ||
    !sessionsStatus.isDirectory() ||
    sessionsStatus.isSymbolicLink() ||
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink()
  ) {
    throw new Error("The managed Runtime proof session root is unsafe");
  }
  const [realRepoRoot, realProofRoot, realSessionsRoot, realStateRoot] =
    await Promise.all([
      realpath(repoRoot),
      realpath(proofRoot),
      realpath(sessionsRoot),
      realpath(stateRoot),
    ]);
  const realLocalRoot = path.join(realRepoRoot, ".local");
  if (
    realProofRoot === realLocalRoot ||
    !isStrictDescendant(realLocalRoot, realProofRoot) ||
    path.dirname(realSessionsRoot) !== realProofRoot ||
    !isStrictDescendant(realSessionsRoot, realStateRoot)
  ) {
    throw new Error("The managed Runtime proof session path is unsafe");
  }
  if (
    !(await lstat(
      path.join(proofRoot, ".agent-airlock-runtime-proof-root"),
    )).isFile() ||
    (await readFile(
      path.join(proofRoot, ".agent-airlock-runtime-proof-root"),
      "utf8",
    )) !== "Agent Airlock real Runtime proof artifacts\n"
  ) {
    throw new Error("The managed Runtime proof owner marker is invalid");
  }
  const sessionMarkerPath = path.join(
    stateRoot,
    ".agent-airlock-runtime-proof-session.json",
  );
  const sessionMarkerStatus = await lstat(sessionMarkerPath);
  if (!sessionMarkerStatus.isFile() || sessionMarkerStatus.isSymbolicLink()) {
    throw new Error("The managed Runtime proof session marker is invalid");
  }
  const marker = JSON.parse(
    await readFile(sessionMarkerPath, "utf8"),
  );
  const actualKeys = Object.keys(marker).sort();
  const expectedKeys = ["nonce", "ownerPid", "schema", "schemaVersion"].sort();
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    marker.schema !== "agent-airlock/runtime-proof-session" ||
    marker.schemaVersion !== 1 ||
    marker.nonce !== configuredProofSessionNonce ||
    marker.ownerPid !== configuredProofOwnerPid
  ) {
    throw new Error("The managed Runtime proof session marker is invalid");
  }
}

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
    maxAddedBytes: 65_536,
    secretPatterns: [],
    validationCommands: [
      {
        name: "protocol-content",
        command: [
          'test "$(cat protocol-proof.txt)" = candidate-only',
          "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
        ].join(" && "),
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
          "Keep every workspace, SQLite, and deferred-action change inside isolated Candidate State and complete the requested Whole-Agent protocol proof.",
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

const expectedRoot = configuredProofSessionRoot
  ? stateRoot
  : path.join(
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
if (configuredProofSessionRoot) {
  await assertManagedProofSession();
} else if (!demoRequested || resetRequested || ephemeralRequested) {
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
async function stopFixtureChild(child) {
  await stopRuntimeProofChild(child, {
    gracefulTimeoutMs: 5_000,
    forcedTimeoutMs: 5_000,
  });
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const childCleanup = await Promise.allSettled(
    [app, fixture].map(stopFixtureChild),
  );
  const childCleanupFailed = childCleanup.some(
    (result) => result.status === "rejected",
  );
  if (childCleanupFailed) exitCode = 1;
  if (
    (!demoRequested || ephemeralRequested) &&
    !childCleanupFailed &&
    !configuredProofSessionRoot
  ) {
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
    const agent = await seedProtocolDemo(baseUrl);
    const readiness = assertJudgeReadiness(
      await inspectJudgeReadiness({
        baseUrl,
        expectedMode: "runtime",
        expectedAgentId: agent.id,
      }),
    );
    console.log("");
    console.log("Agent Airlock real Runtime proof is ready: " + baseUrl);
    console.log(
      `Readiness: ${readiness.checks.length}/${readiness.checks.length} checks passed (${readiness.evidenceDigest}).`,
    );
    console.log("Runtime: real pinned Codex CLI in a disposable container.");
    console.log("Inference: local deterministic Responses fixture.");
    console.log("Cost: no ModelArk request or paid inference.");
    console.log("Proof 1: Run passing Candidate.");
    console.log(
      "Expected: exact file and database Validation passes, all four resources promote, and one deferred effect delivers after Promotion.",
    );
    console.log("Proof 2: Run failing Candidate.");
    console.log(
      "Expected: Candidate file, database, session, and intent enter Quarantine; Canonical State and delivery count stay unchanged.",
    );
    console.log("Proof 3: Repair retained Candidate.");
    console.log(
      "Expected: bounded Repair promotes all four resources, delivers one fresh effect, and exports a signed two-decision chain.",
    );
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
