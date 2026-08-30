import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeManagedRoot,
  buildLiveModelArkDemoEnvironment,
  liveModelArkPrompt,
  seedLiveModelArkDemo,
} from "./modelark-demo-profile.mjs";
import { monitorLiveModelArkConformance } from "./modelark-conformance-evidence.mjs";
import {
  createOwnedModelArkProcessTree,
  terminateOwnedModelArkProcessTree,
} from "./modelark-process-tree.mjs";
import {
  assertJudgeReadiness,
  inspectJudgeReadiness,
} from "./judge-readiness.mjs";
import {
  acquireModelArkDemoStartupLease,
  releaseModelArkDemoLease,
} from "./modelark-demo-lease.mjs";
import { startModelArkEffectReceiver } from "./modelark-effect-receiver.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter(
  (argument) => argument !== "--reset",
);
if (unknownArguments.length > 0) {
  throw new Error(
    "Unknown ModelArk demo option: " + unknownArguments.join(", "),
  );
}

const requestedStateRoot = assertSafeManagedRoot(
  projectRoot,
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);

const ownedProcessGroupEnvironmentKey =
  "AGENT_AIRLOCK_INTERNAL_MODELARK_PROCESS_GROUP_OWNER";
const leaseNonceEnvironmentKey = "AGENT_AIRLOCK_INTERNAL_MODELARK_LEASE_NONCE";
const ownsProcessGroup =
  process.platform === "win32" ||
  process.env[ownedProcessGroupEnvironmentKey] === "1";

async function launchOwnedProcessGroup() {
  let child = null;
  let ownedTree = null;
  let stopTask = null;
  let interruptionSignal = null;
  const leaseNonce = randomUUID();

  function stopOwnedTree(initialSignal = "SIGTERM") {
    if (!ownedTree) return Promise.resolve({ forced: false });
    if (!stopTask) {
      stopTask = terminateOwnedModelArkProcessTree(ownedTree, {
        initialSignal,
        gracefulTimeoutMs: 15_000,
        forcedTimeoutMs: 5_000,
      });
    }
    return stopTask;
  }

  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      interruptionSignal ??= signal;
      void stopOwnedTree(signal).catch(() => {});
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), ...argumentsList],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          [ownedProcessGroupEnvironmentKey]: "1",
          [leaseNonceEnvironmentKey]: leaseNonce,
        },
        stdio: "inherit",
        detached: true,
      },
    );
    const childExit = new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: 1, error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    ownedTree = createOwnedModelArkProcessTree(child);
    if (interruptionSignal) {
      void stopOwnedTree(interruptionSignal).catch(() => {});
    }

    const outcome = await childExit;
    await stopOwnedTree(interruptionSignal ?? "SIGTERM");
    releaseModelArkDemoLease({
      stateRoot: requestedStateRoot,
      ownerPid: child.pid,
      nonce: leaseNonce,
    });
    if (outcome.error instanceof Error) throw outcome.error;
    if (interruptionSignal || outcome.signal) return 1;
    return outcome.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

if (!ownsProcessGroup) {
  process.exit(await launchOwnedProcessGroup());
}
if (process.platform !== "win32") {
  const processGroupId = Number.parseInt(
    execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    }).trim(),
    10,
  );
  if (processGroupId !== process.pid) {
    throw new Error(
      "The ModelArk demo launcher is not the owner of its Unix process group",
    );
  }
  if (!process.env[leaseNonceEnvironmentKey]) {
    throw new Error(
      "The ModelArk demo process-group owner has no supervisor lease nonce",
    );
  }
}

const resetRequested = argumentsList.includes("--reset");
const host = "127.0.0.1";
const port = Number.parseInt(
  process.env.AIRLOCK_MODELARK_DEMO_PORT ?? "3201",
  10,
);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    "AIRLOCK_MODELARK_DEMO_PORT must be an integer from 1 through 65535",
  );
}
const effectReceiverPort = Number.parseInt(
  process.env.AIRLOCK_MODELARK_EFFECT_PORT ?? String(port + 1),
  10,
);
if (
  !Number.isInteger(effectReceiverPort) ||
  effectReceiverPort < 1 ||
  effectReceiverPort > 65_535 ||
  effectReceiverPort === port
) {
  throw new Error(
    "AIRLOCK_MODELARK_EFFECT_PORT must be a distinct integer from 1 through 65535",
  );
}

const markerContent = "Agent Airlock live ModelArk demo state\n";
const leaseNonce =
  process.platform === "win32"
    ? undefined
    : process.env[leaseNonceEnvironmentKey];
const ownership = await acquireModelArkDemoStartupLease({
  host,
  port,
  additionalPorts: [effectReceiverPort],
  stateRoot: requestedStateRoot,
  resetRequested,
  ownerProcessGroupId: process.platform === "win32" ? null : process.pid,
  ...(leaseNonce ? { nonce: leaseNonce } : {}),
});
const stateRoot = ownership.stateRoot;
try {
  assertSafeManagedRoot(projectRoot, stateRoot);
} catch (error) {
  ownership.release();
  throw error;
}
const markerPath = path.join(stateRoot, ".agent-airlock-modelark-demo-root");
let childConfirmedExited = true;
process.once("exit", () => {
  if (process.platform !== "win32" || !childConfirmedExited) return;
  try {
    ownership.release();
  } catch {}
});

const existingEntries = await readdir(stateRoot).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existingEntries && existingEntries.length > 0) {
  const marker = await readFile(markerPath, "utf8").catch(() => null);
  if (marker !== markerContent) {
    throw new Error(
      "Refusing to use a non-Airlock ModelArk demo data root: " + stateRoot,
    );
  }
}
if (resetRequested) await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });
await writeFile(markerPath, markerContent, { encoding: "utf8", mode: 0o600 });

const effectReceiver = await startModelArkEffectReceiver({
  host,
  port: effectReceiverPort,
  filePath: path.join(
    stateRoot,
    "external-action-receiver",
    "deliveries.json",
  ),
});
let effectReceiverClosed = false;
async function closeEffectReceiver() {
  if (effectReceiverClosed) return;
  effectReceiverClosed = true;
  await effectReceiver.close();
}

let child = null;
let childExit = null;
let stopping = false;
let stopTask = null;
let interruptionSignal = null;

function signalChild(signal) {
  if (!child || childConfirmedExited || !child.pid) return false;
  try {
    child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopChild(initialSignal = "SIGTERM") {
  if (!childExit || childConfirmedExited) return childExit;
  if (stopTask) return stopTask;
  stopTask = (async () => {
    stopping = true;
    signalChild(initialSignal);
    const stopped = await Promise.race([
      childExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!stopped && !childConfirmedExited) {
      signalChild("SIGKILL");
      await childExit;
    }
  })();
  return stopTask;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptionSignal ??= signal;
    void stopChild(signal).catch(() => {});
  });
}

child = spawn(path.join(projectRoot, "scripts", "start-local-poc.sh"), [], {
  cwd: projectRoot,
  env: buildLiveModelArkDemoEnvironment(process.env, {
    host,
    port,
    stateRoot,
    effectReceiverUrl: effectReceiver.url,
  }),
  stdio: "inherit",
  detached: false,
});
childConfirmedExited = false;

childExit = new Promise((resolve) => {
  child.once("error", (error) => {
    childConfirmedExited = true;
    resolve({ code: 1, error });
  });
  child.once("exit", (code, signal) => {
    childConfirmedExited = true;
    resolve({ code, signal });
  });
});
if (interruptionSignal) void stopChild(interruptionSignal).catch(() => {});

const baseUrl = `http://${host}:${port}`;
const startupDeadline = Date.now() + 180_000;
let ready = false;
while (Date.now() < startupDeadline) {
  const remainingMs = startupDeadline - Date.now();
  const outcome = await Promise.race([
    fetch(baseUrl + "/api/health", {
      signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remainingMs))),
    })
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

if (!ready) {
  await stopChild();
  await closeEffectReceiver();
  console.error(
    "[modelark-demo] The live ModelArk demo failed its preflight or startup checks.",
  );
  process.exit(1);
}

let captureController = null;
let captureTask = Promise.resolve();
try {
  const agent = await seedLiveModelArkDemo(baseUrl);
  const readiness = assertJudgeReadiness(
    await inspectJudgeReadiness({
      baseUrl,
      expectedMode: "modelark",
      expectedAgentId: agent.id,
    }),
  );
  captureController = new AbortController();
  captureTask = monitorLiveModelArkConformance({
    baseUrl,
    agentId: agent.id,
    stateRoot,
    signal: captureController.signal,
    onCaptured: ({ relativePath }) => {
      console.log(
        "Signed live ModelArk conformance evidence captured: " + relativePath,
      );
      console.log(
        "Verify it later with npm run verify:modelark-evidence without contacting ModelArk.",
      );
    },
    onError: () => {
      console.error(
        "Signed conformance evidence capture is waiting to retry; the live Run evidence remains in Agent Airlock.",
      );
    },
  });
  console.log("");
  console.log("Agent Airlock live ModelArk proof is ready: " + baseUrl);
  console.log(
    `Readiness: ${readiness.checks.length}/${readiness.checks.length} checks passed (${readiness.evidenceDigest}).`,
  );
  console.log("Inference: provider-backed ModelArk Responses API.");
  console.log("Runtime: real Codex CLI in a disposable container.");
  console.log(
    "Effects: real loopback HTTP delivery with receiver-enforced idempotency after Promotion.",
  );
  console.log("Judge action: Run live Candidate.");
  console.log(
    "Whole-Agent proof: exact artifact, SQLite value, real HTTP effect, and signed Promotion.",
  );
  console.log("Prompt: " + liveModelArkPrompt);
  console.log("State persists across restart. Add --reset for a clean proof.");
  console.log("");
} catch (error) {
  await stopChild();
  await closeEffectReceiver();
  throw error;
}

const outcome = await childExit;
captureController?.abort();
await captureTask;
await closeEffectReceiver();
if (process.platform === "win32") ownership.release();
if (outcome.error instanceof Error) throw outcome.error;
if (!stopping && outcome.code !== 0) process.exitCode = outcome.code ?? 1;
