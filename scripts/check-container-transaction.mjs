import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyPortablePromotionEnvelope } from "@agent-airlock/portable-promotion-receipt";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/responses-protocol-server.mjs", import.meta.url),
);
const serverEntry = path.join(repoRoot, "apps/server/dist/index.js");
const testRoot = path.join(repoRoot, ".local", "container-tests");
const requestTimeoutMs = 20_000;
const runTimeoutMs = 45_000;
const providerCredential = "deterministic-protocol-fixture";
const controlPlaneAuthToken = "deterministic-auth-token-1234567890";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(typeof address === "object" && address !== null, "Port allocation failed");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function commandWorks(command, args) {
  try {
    await execFile(command, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function detectEngine() {
  const configured = process.env.CONTAINER_ENGINE?.trim();
  const candidates = configured ? [configured] : ["docker", "podman"];
  for (const candidate of candidates) {
    if (await commandWorks(candidate, ["info"])) return candidate;
  }
  throw new Error("A running Docker or Podman engine is required");
}

async function requestJson(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(baseUrl + pathname, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${controlPlaneAuthToken}`,
        ...options.headers,
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${pathname}`);
    }
    return raw ? JSON.parse(raw) : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + "/api/health");
      if (response.ok) return;
    } catch {
      // The child process may still be loading its persisted state.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The production control plane did not become healthy");
}

async function waitForRun(baseUrl, runId) {
  const deadline = Date.now() + runTimeoutMs;
  while (Date.now() < deadline) {
    const { run } = await requestJson(baseUrl, `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The real container Run did not reach a terminal state");
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

async function assertTreeExcludesLiterals(root, literals) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(entryPath);
      for (const literal of literals) {
        invariant(
          !content.includes(Buffer.from(literal)),
          `Control-plane credential persisted in ${path.relative(root, entryPath)}`,
        );
      }
    }
  }
}

function startControlPlane(environment) {
  return spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function main() {
  const engine = await detectEngine();
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, "airlock-http-container-"));
  const fixturePort = await freePort();
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const isPodman = path.basename(engine).toLowerCase() === "podman";
  const fixtureHostname = isPodman
    ? "host.containers.internal"
    : "host.docker.internal";
  const environment = {
    ...safeHostEnvironment(),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(appPort),
    LOG_LEVEL: "silent",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex-home"),
    APP_AUTH_TOKEN: controlPlaneAuthToken,
    ARK_API_KEY: providerCredential,
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
    RUNTIME_INSTANCE_ID: `protocol-${process.pid}`,
    AIRLOCK_DEMO_MODE: "false",
  };
  let fixture = null;
  let app = null;
  try {
    fixture = spawn(process.execPath, [fixturePath], {
      cwd: repoRoot,
      env: {
        ...safeHostEnvironment(),
        AIRLOCK_PROTOCOL_FIXTURE_HOST: "0.0.0.0",
        AIRLOCK_PROTOCOL_FIXTURE_PORT: String(fixturePort),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    app = startControlPlane(environment);
    await waitForHealth(baseUrl);

    const created = await requestJson(baseUrl, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Real Container Transaction",
        instructions: "Keep every change inside isolated Candidate State.",
      }),
    });
    const agentId = created.agent.id;
    const canonicalPath = created.agent.workspacePath;
    const beforeStateId = created.agent.canonicalStateId;
    await access(path.join(canonicalPath, "AGENTS.md"));
    await access(path.join(canonicalPath, "protocol-proof.txt")).then(
      () => {
        throw new Error("Protocol proof unexpectedly existed in Canonical State");
      },
      () => undefined,
    );

    await requestJson(baseUrl, `/api/agents/${agentId}/outcome-contract`, {
      method: "PUT",
      body: JSON.stringify({
        requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
        protectedPaths: ["AGENTS.md"],
        maxChangedFiles: 4,
        maxAddedBytes: 16_384,
        secretPatterns: [],
        validationCommands: [
          {
            name: "protocol-content",
            command: "test \"$(cat protocol-proof.txt)\" = candidate-only",
            required: true,
            timeoutMs: 10_000,
          },
        ],
      }),
    });

    const admitted = await requestJson(baseUrl, `/api/agents/${agentId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Create protocol-proof.txt." }),
    });
    const firstRun = await waitForRun(baseUrl, admitted.run.id);
    invariant(firstRun.status === "completed", "The first real Run did not complete");
    invariant(
      firstRun.transaction?.disposition === "promoted",
      "The first real Candidate was not promoted: " +
        JSON.stringify({
          status: firstRun.status,
          disposition: firstRun.transaction?.disposition,
          validations: firstRun.transaction?.validations,
          error: firstRun.error,
        }),
    );
    invariant(
      firstRun.transaction.validations.every(
        (validation) => validation.status === "passed",
      ),
      "Required Validation did not pass",
    );
    invariant(
      firstRun.transaction.validations.some(
        (validation) => validation.name === "command:protocol-content",
      ),
      "The real validation command evidence is missing",
    );
    const afterFirst = await requestJson(baseUrl, `/api/agents/${agentId}`);
    invariant(
      afterFirst.agent.canonicalStateId !== beforeStateId,
      "Canonical State did not advance after Promotion",
    );
    invariant(
      typeof afterFirst.agent.codexThreadId === "string" &&
        afterFirst.agent.codexThreadId.length > 0,
      "The accepted Codex thread was not persisted",
    );
    invariant(
      (await readFile(
        path.join(afterFirst.agent.workspacePath, "protocol-proof.txt"),
        "utf8",
      )) === "candidate-only\n",
      "Promotion did not install the validated Candidate file",
    );

    const exported = await requestJson(
      baseUrl,
      `/api/runs/${firstRun.id}/portable-receipt`,
      {
        method: "POST",
        body: JSON.stringify({
          disclosureIdentities: [],
          includeAncestry: true,
          localAnchor: false,
          evmPayload: false,
        }),
      },
    );
    invariant(
      verifyPortablePromotionEnvelope(exported.envelope).valid,
      "The independently verified Promotion receipt is invalid",
    );

    await stopChild(app);
    app = startControlPlane(environment);
    await waitForHealth(baseUrl);
    const recovered = await requestJson(baseUrl, `/api/agents/${agentId}`);
    invariant(
      recovered.agent.canonicalStateId === afterFirst.agent.canonicalStateId,
      "Restart changed accepted Canonical State",
    );
    invariant(
      recovered.agent.codexThreadId === afterFirst.agent.codexThreadId,
      "Restart changed the accepted Codex thread",
    );

    const continued = await requestJson(
      baseUrl,
      `/api/agents/${agentId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Continue from the accepted session and recheck the proof file.",
        }),
      },
    );
    const secondRun = await waitForRun(baseUrl, continued.run.id);
    invariant(secondRun.status === "completed", "The resumed real Run did not complete");
    invariant(
      secondRun.transaction?.disposition === "promoted",
      "The resumed real Candidate was not promoted",
    );
    invariant(
      secondRun.transaction.canonicalStateIdBefore ===
        afterFirst.agent.canonicalStateId,
      "The resumed Run did not begin from accepted Canonical State",
    );
    invariant(
      secondRun.transaction.canonicalStateIdAfter !==
        secondRun.transaction.canonicalStateIdBefore,
      "The resumed Run did not advance Canonical State",
    );

    const credentialAgent = await requestJson(baseUrl, "/api/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${controlPlaneAuthToken}` },
      body: JSON.stringify({
        name: "Runtime Credential Boundary",
        instructions:
          "Prove that Runtime tools cannot observe control-plane credentials.",
      }),
    });
    const credentialAgentId = credentialAgent.agent.id;
    await requestJson(
      baseUrl,
      `/api/agents/${credentialAgentId}/outcome-contract`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${controlPlaneAuthToken}` },
        body: JSON.stringify({
          requiredPaths: ["AGENTS.md", "credential-probe.txt"],
          protectedPaths: ["AGENTS.md"],
          maxChangedFiles: 2,
          maxAddedBytes: 1_024,
          secretPatterns: [],
          validationCommands: [
            {
              name: "credential-unavailable",
              command:
                'test "$(cat credential-probe.txt)" = credential-unavailable',
              required: true,
              timeoutMs: 10_000,
            },
          ],
        }),
      },
    );
    const credentialAdmission = await requestJson(
      baseUrl,
      `/api/agents/${credentialAgentId}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${controlPlaneAuthToken}` },
        body: JSON.stringify({
          content: "Run the Runtime credential isolation proof.",
        }),
      },
    );
    const credentialRun = await waitForRun(baseUrl, credentialAdmission.run.id);
    invariant(
      credentialRun.status === "completed",
      "The Runtime credential isolation Run did not complete",
    );
    invariant(
      credentialRun.transaction?.disposition === "promoted",
      "The credential-isolated Candidate was not promoted: " +
        JSON.stringify({
          disposition: credentialRun.transaction?.disposition,
          validations: credentialRun.transaction?.validations,
        }),
    );
    const credentialAfter = await requestJson(
      baseUrl,
      `/api/agents/${credentialAgentId}`,
    );
    invariant(
      (
        await readFile(
          path.join(credentialAfter.agent.workspacePath, "credential-probe.txt"),
          "utf8",
        )
      ) === "credential-unavailable\n",
      "Runtime tool execution observed a control-plane credential",
    );
    await assertTreeExcludesLiterals(root, [
      providerCredential,
      controlPlaneAuthToken,
    ]);

    console.log("Real HTTP-to-container transaction passed");
    console.log("CodeJam HTTP request created an isolated Candidate State");
    console.log("Pinned Codex executed a two-turn Responses tool call in the Runtime");
    console.log("Required path, protected path, and real command Validation passed");
    console.log("Only the validated Candidate replaced Canonical State");
    console.log("A signed receipt verified independently without server trust");
    console.log("Restart preserved state and resumed the accepted Codex thread");
    console.log("Runtime tools and persisted state excluded control-plane credentials");
  } finally {
    await stopChild(app);
    await stopChild(fixture);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[container-transaction] ${error instanceof Error ? error.message : "Unknown failure"}`,
  );
  process.exitCode = 1;
});
