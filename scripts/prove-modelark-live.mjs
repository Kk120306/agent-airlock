import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeManagedRoot } from "./modelark-demo-profile.mjs";
import {
  LiveModelArkProofError,
  classifyLiveModelArkLauncherFailure,
  createPlaywrightLiveModelArkDriver,
  resolveLiveModelArkProofExitCode,
  runLiveModelArkProofSession,
  safeLiveModelArkFailure,
} from "./modelark-live-proof-runner.mjs";
import {
  createOwnedModelArkProcessTree,
  terminateOwnedModelArkProcessTree,
} from "./modelark-process-tree.mjs";
import { releaseModelArkDemoLease } from "./modelark-demo-lease.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const supportedArguments = new Set(["--reset", "--headed", "--json", "--help"]);
const unknownArguments = argumentsList.filter(
  (argument) => !supportedArguments.has(argument),
);

if (unknownArguments.length > 0) {
  console.error("Unknown live proof option: " + unknownArguments.join(", "));
  process.exit(2);
}

if (argumentsList.includes("--help")) {
  console.log("Usage: npm run prove:modelark -- [--reset] [--headed] [--json]");
  console.log(
    "Runs one bounded production-browser ModelArk conformance proof.",
  );
  console.log(
    "The command never disables Free Credits Only Mode or stores provider output.",
  );
  process.exit(0);
}

const resetRequested = argumentsList.includes("--reset");
const headed = argumentsList.includes("--headed");
const jsonOutput = argumentsList.includes("--json");
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

const stateRoot = assertSafeManagedRoot(
  projectRoot,
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);
const baseUrl = `http://${host}:${port}`;
const startupTimeoutMs = 180_000;
const maximumTranscriptBytes = 65_536;
let transcript = "";
let ready = false;
const controller = new AbortController();
let child = null;
let childExit = null;
let ownedTree = null;
let stopTask = null;
let interruptionSignal = null;
let proofCommitted = false;
const ownedProcessGroupEnvironmentKey =
  "AGENT_AIRLOCK_INTERNAL_MODELARK_PROCESS_GROUP_OWNER";
const leaseNonceEnvironmentKey = "AGENT_AIRLOCK_INTERNAL_MODELARK_LEASE_NONCE";
const leaseNonce = randomUUID();

async function stopChild(initialSignal = "SIGTERM") {
  if (!ownedTree) return;
  if (stopTask) return stopTask;
  stopTask = (async () => {
    await terminateOwnedModelArkProcessTree(ownedTree, {
      initialSignal,
      gracefulTimeoutMs: 15_000,
      forcedTimeoutMs: 5_000,
    });
    if (childExit) await childExit;
    if (process.platform !== "win32") {
      releaseModelArkDemoLease({
        stateRoot,
        ownerPid: child.pid,
        nonce: leaseNonce,
      });
    }
  })();
  return stopTask;
}

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    interruptionSignal ??= signalName;
    controller.abort();
    void stopChild(signalName).catch(() => {});
  });
}

child = spawn(
  process.execPath,
  [
    path.join(projectRoot, "scripts", "run-modelark-demo.mjs"),
    ...(resetRequested ? ["--reset"] : []),
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      [ownedProcessGroupEnvironmentKey]: "1",
      [leaseNonceEnvironmentKey]: leaseNonce,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  },
);
ownedTree = createOwnedModelArkProcessTree(child);

function capture(chunk, target) {
  const value = chunk.toString("utf8");
  target.write(value);
  transcript = (transcript + value).slice(-maximumTranscriptBytes);
  if (transcript.includes("Agent Airlock live ModelArk proof is ready:")) {
    ready = true;
  }
}

child.stdout.on("data", (chunk) =>
  capture(chunk, jsonOutput ? process.stderr : process.stdout),
);
child.stderr.on("data", (chunk) => capture(chunk, process.stderr));

childExit = new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
if (interruptionSignal) void stopChild(interruptionSignal).catch(() => {});

async function waitForLauncher() {
  const deadline = Date.now() + startupTimeoutMs;
  while (!ready && Date.now() <= deadline) {
    const exited = await Promise.race([
      childExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    if (controller.signal.aborted) {
      throw new LiveModelArkProofError("interrupted");
    }
    if (exited) throw classifyLiveModelArkLauncherFailure(transcript);
  }
  if (!ready) throw new LiveModelArkProofError("startup-failed");
}

try {
  await waitForLauncher();
  const browserDriver = await createPlaywrightLiveModelArkDriver({
    baseUrl,
    headless: !headed,
  });
  const result = await runLiveModelArkProofSession({
    baseUrl,
    stateRoot,
    browserDriver,
    signal: controller.signal,
  });
  proofCommitted = true;
  if (jsonOutput) {
    console.log(JSON.stringify(result));
  } else {
    console.log("");
    console.log("Live ModelArk proof: PASSED");
    console.log("Production browser invocation: passed");
    console.log("Complete Whole-Agent Promotion: passed");
    console.log("Signed packet capture: passed");
    console.log("Offline packet verification: passed");
    console.log(`Receipt digest: ${result.receiptDigest}`);
    console.log(
      "Historical proof remains verifiable with npm run verify:modelark-evidence.",
    );
  }
} catch (error) {
  const failure = safeLiveModelArkFailure(error);
  if (jsonOutput) {
    console.log(JSON.stringify(failure));
  } else {
    console.error("");
    console.error("Live ModelArk proof: FAILED");
    console.error(`Failure class: ${failure.failureClass}`);
    console.error(failure.message);
  }
  process.exitCode = 1;
} finally {
  try {
    await stopChild();
  } catch {
    if (!proofCommitted) process.exitCode = 1;
  }
  process.exitCode = resolveLiveModelArkProofExitCode({
    currentExitCode: process.exitCode,
    interrupted: controller.signal.aborted,
    proofCommitted,
  });
}

if (process.exitCode) process.exit(process.exitCode);
