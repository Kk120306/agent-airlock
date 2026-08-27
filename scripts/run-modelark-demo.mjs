import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeManagedRoot,
  comparableContract,
  liveModelArkAgentName,
  liveModelArkContract,
  liveModelArkPrompt,
} from "./modelark-demo-profile.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  throw new Error("Unknown ModelArk demo option: " + unknownArguments.join(", "));
}

const resetRequested = argumentsList.includes("--reset");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.AIRLOCK_MODELARK_DEMO_PORT ?? "3201", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AIRLOCK_MODELARK_DEMO_PORT must be an integer from 1 through 65535");
}

const stateRoot = assertSafeManagedRoot(
  projectRoot,
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);
const markerPath = path.join(stateRoot, ".agent-airlock-modelark-demo-root");
const markerContent = "Agent Airlock live ModelArk demo state\n";

const existingEntries = await readdir(stateRoot).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existingEntries && existingEntries.length > 0) {
  const marker = await readFile(markerPath, "utf8").catch(() => null);
  if (marker !== markerContent) {
    throw new Error("Refusing to use a non-Airlock ModelArk demo data root: " + stateRoot);
  }
}
if (resetRequested) await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });
await writeFile(markerPath, markerContent, { encoding: "utf8", mode: 0o600 });

const portAvailable = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", () => resolve(false));
  probe.listen({ host, port, exclusive: true }, () => {
    probe.close(() => resolve(true));
  });
});
if (!portAvailable) {
  throw new Error(`The live ModelArk demo port is already in use: http://${host}:${port}`);
}

const child = spawn(path.join(projectRoot, "scripts", "start-local-poc.sh"), [], {
  cwd: projectRoot,
  env: {
    ...process.env,
    HOST: host,
    PORT: String(port),
    LOCAL_POC_DATA_ROOT: stateRoot,
    AIRLOCK_DEMO_MODE: "false",
    AIRLOCK_PROTOCOL_FIXTURE_MODE: "false",
    AIRLOCK_MODELARK_DEMO_MODE: "true",
    RUNTIME_PROVIDER: "container",
    CODEX_BIN: "codex",
    RUNTIME_INSTANCE_ID: "airlock-modelark-demo",
  },
  stdio: "inherit",
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (!child.killed) child.kill(signal);
  });
}
const childExit = new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const baseUrl = `http://${host}:${port}`;
let ready = false;
for (let attempt = 0; attempt < 1_200; attempt += 1) {
  const outcome = await Promise.race([
    fetch(baseUrl + "/api/health")
      .then((response) => (response.ok ? "ready" : "waiting"))
      .catch(() => "waiting"),
    childExit.then(() => "exited"),
  ]);
  if (outcome === "ready") {
    ready = true;
    break;
  }
  if (outcome === "exited") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return response.json();
}

async function seedLiveProof() {
  const { agents } = await requestJson("/api/agents");
  const matches = agents.filter((agent) => agent.name === liveModelArkAgentName);
  if (matches.length > 1) {
    throw new Error("The managed demo contains duplicate Live ModelArk Proof Agents");
  }
  let agent = matches[0];
  if (!agent) {
    ({ agent } = await requestJson("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: liveModelArkAgentName,
        description: "Provider-backed inference, isolated Candidate, validated Promotion",
        instructions:
          "Work only in isolated Candidate State. Create the requested proof artifact, run the required verification, and report the observed result.",
      }),
    }));
    await requestJson(`/api/agents/${agent.id}/outcome-contract`, {
      method: "PUT",
      body: JSON.stringify(liveModelArkContract),
    });
    return;
  }
  if (
    JSON.stringify(comparableContract(agent.outcomeContract)) !==
    JSON.stringify(liveModelArkContract)
  ) {
    throw new Error(
      "The Live ModelArk Proof Outcome Contract changed. Restart with --reset for the guaranteed judge path.",
    );
  }
}

if (!ready) {
  if (!child.killed) child.kill("SIGTERM");
  const outcome = await childExit;
  throw outcome.error instanceof Error
    ? outcome.error
    : new Error("The live ModelArk demo failed its preflight or startup checks");
}

try {
  await seedLiveProof();
  console.log("");
  console.log("Agent Airlock live ModelArk proof is ready: " + baseUrl);
  console.log("Inference: provider-backed ModelArk Responses API.");
  console.log("Runtime: real Codex CLI in a disposable container.");
  console.log("Judge action: Run live Candidate.");
  console.log("Falsifiable artifact: modelark-proof.txt must contain exactly modelark-live.");
  console.log("Prompt: " + liveModelArkPrompt);
  console.log("State persists across restart. Add --reset for a clean proof.");
  console.log("");
} catch (error) {
  if (!child.killed) child.kill("SIGTERM");
  throw error;
}

const outcome = await childExit;
if (outcome.error instanceof Error) throw outcome.error;
if (!stopping && outcome.code !== 0) process.exitCode = outcome.code ?? 1;
