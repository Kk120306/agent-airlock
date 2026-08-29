import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_PROOF_RECORDING_BUDGET_MS,
  RuntimeProofError,
  cleanupAbandonedRuntimeProofSessions,
  cleanupRuntimeProofSessionRoot,
  classifyRuntimeProofLauncherFailure,
  createPlaywrightRuntimeProofDriver,
  createRuntimeProofSessionRoot,
  finalizeRuntimeProofPublication,
  initializeRuntimeProofRoot,
  recoverRuntimeProofArtifactPublication,
  runRuntimeProofSession,
  safeRuntimeProofFailure,
  writeRuntimeProofArtifacts,
} from "./runtime-proof-runner.mjs";
import {
  attachBoundedRuntimeProofCapture,
  createOwnedRuntimeProofProcessTree,
  createRuntimeProofProgress,
  runtimeProofChildExitSucceeded,
  runtimeProofChildHasExited,
  stopOwnedRuntimeProofProcessTree,
  stopRuntimeProofChild,
  waitForRuntimeProofChildOutcome,
} from "./runtime-proof-terminal.mjs";
import {
  assertMatchingRuntimeSourceProvenance,
  inspectRuntimeSourceProvenance,
  inspectRuntimeSourceProvenanceSync,
} from "./runtime-source-provenance.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const supportedArguments = new Set(["--reset", "--headed", "--json", "--help"]);
const unknownArguments = argumentsList.filter(
  (argument) => !supportedArguments.has(argument),
);

if (unknownArguments.length > 0) {
  console.error("Unknown real Runtime proof option.");
  process.exit(2);
}

if (argumentsList.includes("--help")) {
  console.log("Usage: npm run prove:runtime -- [--reset] [--headed] [--json]");
  console.log("Runs one fresh production-browser proof through real pinned Codex.");
  console.log("--reset removes only abandoned marker-owned proof sessions.");
  console.log("The signed decision chain is authority; the result capsule is not.");
  process.exit(0);
}

const resetRequested = argumentsList.includes("--reset");
const headed = argumentsList.includes("--headed");
const jsonOutput = argumentsList.includes("--json");
const progress = createRuntimeProofProgress({ jsonOutput });
const host = "127.0.0.1";
const APPLICATION_BUILD_TIMEOUT_MS = 180_000;
const RUNTIME_IMAGE_BUILD_TIMEOUT_MS = 600_000;
let port = null;
let fixturePort = null;
let artifactRoot = null;
let leasePath = null;
const leaseNonce = randomUUID();
const ownedChildren = new Set();
const controller = new AbortController();
let launcher = null;
let launcherExit = null;
let launcherTree = null;
let launcherOutput = null;
let detachLauncherReadiness = null;
let engine = null;
let runtimeInstanceId = null;
let session = null;
let pendingArtifacts = null;
let result = null;
let failure = null;
let leaseHeld = false;
let recordingDeadlineAt = null;
let recordingController = null;
let recordingTimer = null;
let browserProofSignal = controller.signal;
let sourceProvenance = null;

async function acquireLease() {
  if (!leasePath) throw new RuntimeProofError("startup-failed");
  const value = {
    schema: "agent-airlock/runtime-proof-lease",
    schemaVersion: 1,
    ownerPid: process.pid,
    nonce: leaseNonce,
  };
  let handle = null;
  try {
    handle = await open(leasePath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.close();
    handle = null;
    await chmod(leasePath, 0o600);
    leaseHeld = true;
  } catch {
    await handle?.close().catch(() => {});
    throw new RuntimeProofError("startup-failed");
  }
}

async function releaseLease() {
  if (!leaseHeld) return;
  const leaseStatus = await lstat(leasePath);
  if (!leaseStatus.isFile() || leaseStatus.isSymbolicLink()) {
    throw new RuntimeProofError("cleanup-failed");
  }
  const current = JSON.parse(await readFile(leasePath, "utf8"));
  if (
    current?.schema !== "agent-airlock/runtime-proof-lease" ||
    current?.schemaVersion !== 1 ||
    JSON.stringify(Object.keys(current).sort()) !==
      JSON.stringify(["nonce", "ownerPid", "schema", "schemaVersion"].sort()) ||
    current?.ownerPid !== process.pid ||
    current?.nonce !== leaseNonce
  ) {
    throw new RuntimeProofError("cleanup-failed");
  }
  await rm(leasePath, { force: true });
  leaseHeld = false;
}

async function clearAbandonedSessions() {
  if (!resetRequested) return;
  if (!artifactRoot) throw new RuntimeProofError("startup-failed");
  await cleanupAbandonedRuntimeProofSessions({ artifactRoot });
}

async function commandWorks(command, args = ["info"]) {
  try {
    await execFile(command, args, {
      cwd: projectRoot,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectEngine() {
  const configured = process.env.CONTAINER_ENGINE?.trim();
  if (configured) {
    if (await commandWorks(configured)) return configured;
    throw new RuntimeProofError("runtime-unavailable");
  }
  if (await commandWorks("docker")) return "docker";
  if (
    process.platform === "darwin" &&
    (await commandWorks("colima", ["version"]))
  ) {
    await execFile("colima", ["start"], {
      cwd: projectRoot,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(() => {});
    if (await commandWorks("docker")) return "docker";
  }
  if (
    !(await commandWorks("podman")) &&
    process.platform === "darwin" &&
    (await commandWorks("podman", ["--version"]))
  ) {
    await execFile("podman", ["machine", "start"], {
      cwd: projectRoot,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(() => {});
  }
  if (await commandWorks("podman")) return "podman";
  throw new RuntimeProofError("runtime-unavailable");
}

async function runCommand(command, args, failureClass, timeoutMs) {
  if (controller.signal.aborted) throw new RuntimeProofError("interrupted");
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = attachBoundedRuntimeProofCapture(child);
  ownedChildren.add(child);
  try {
    const outcome = await waitForRuntimeProofChildOutcome(child, {
      timeoutMs,
      signal: controller.signal,
    });
    if (
      outcome.status !== "exited" &&
      !runtimeProofChildHasExited(child)
    ) {
      try {
        await stopRuntimeProofChild(child);
      } catch {
        throw new RuntimeProofError("cleanup-failed");
      }
    }
    if (controller.signal.aborted) throw new RuntimeProofError("interrupted");
    if (outcome.status === "aborted") {
      throw new RuntimeProofError("interrupted");
    }
    if (outcome.status === "timed-out") {
      throw new RuntimeProofError("stage-timeout");
    }
    if (
      outcome.status === "exited" &&
      runtimeProofChildExitSucceeded(outcome)
    ) {
      return;
    }
    throw new RuntimeProofError(failureClass);
  } finally {
    output.detach();
    if (runtimeProofChildHasExited(child)) ownedChildren.delete(child);
  }
}

async function ensureRuntimeImage(selectedEngine) {
  const image =
    process.env.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local";
  const buildArguments = {
    nodeImage:
      process.env.CONTAINER_RUNTIME_BASE_IMAGE?.trim() ||
      "node:22-bookworm-slim",
    debianMirror: process.env.CONTAINER_APT_MIRROR?.trim() || "",
    securityMirror:
      process.env.CONTAINER_APT_SECURITY_MIRROR?.trim() || "",
    aptPackages:
      process.env.CONTAINER_RUNTIME_APT_PACKAGES?.trim() ||
      "ca-certificates git ripgrep",
  };
  const dockerfile = await readFile(
    path.join(projectRoot, "Dockerfile.runtime"),
    "utf8",
  );
  const specification =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify({ dockerfile, buildArguments }))
      .digest("hex");
  let current = null;
  try {
    const { stdout } = await execFile(selectedEngine, ["image", "inspect", image], {
      cwd: projectRoot,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const inspected = JSON.parse(stdout)?.[0];
    current =
      inspected?.Config?.Labels?.["io.agent-airlock.runtime-proof-spec"] ??
      inspected?.config?.Labels?.["io.agent-airlock.runtime-proof-spec"] ??
      null;
  } catch {
    current = null;
  }
  if (current === specification) return image;
  await runCommand(
    selectedEngine,
    [
      "build",
      "--file",
      path.join(projectRoot, "Dockerfile.runtime"),
      "--build-arg",
      `NODE_IMAGE=${buildArguments.nodeImage}`,
      "--build-arg",
      `DEBIAN_MIRROR=${buildArguments.debianMirror}`,
      "--build-arg",
      `DEBIAN_SECURITY_MIRROR=${buildArguments.securityMirror}`,
      "--build-arg",
      `RUNTIME_APT_PACKAGES=${buildArguments.aptPackages}`,
      "--label",
      `io.agent-airlock.runtime-proof-spec=${specification}`,
      "--tag",
      image,
      projectRoot,
    ],
    "image-build-failed",
    RUNTIME_IMAGE_BUILD_TIMEOUT_MS,
  );
  return image;
}

async function cleanupRuntimeContainers() {
  if (!engine || !runtimeInstanceId) return;
  let stdout = "";
  try {
    ({ stdout } = await execFile(
      engine,
      [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "label=io.codejam.launchpad=agent-runtime",
        "--filter",
        `label=io.codejam.instance-id=${runtimeInstanceId}`,
      ],
      { cwd: projectRoot, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    ));
  } catch {
    throw new RuntimeProofError("cleanup-failed");
  }
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (ids.length > 0) {
    await execFile(engine, ["rm", "--force", ...ids], {
      cwd: projectRoot,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(() => {
      throw new RuntimeProofError("cleanup-failed");
    });
  }
}

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    controller.abort();
    for (const child of ownedChildren) {
      if (child === launcher && launcherTree) continue;
      child.kill("SIGTERM");
    }
    try {
      launcherTree?.signal(signalName);
    } catch {
      // The bounded cleanup path below confirms whether the owned tree exited.
    }
  });
}

try {
  port = Number(process.env.AIRLOCK_RUNTIME_PROOF_PORT ?? "3222");
  fixturePort = Number(
    process.env.AIRLOCK_RUNTIME_PROOF_FIXTURE_PORT ?? "43996",
  );
  for (const value of [port, fixturePort]) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new RuntimeProofError("startup-failed");
    }
  }
  if (port === fixturePort) throw new RuntimeProofError("startup-failed");
  artifactRoot = await initializeRuntimeProofRoot({
    projectRoot,
    artifactRoot:
      process.env.AIRLOCK_RUNTIME_PROOF_ROOT ??
      path.join(projectRoot, ".local", "airlock-runtime-proof"),
  });
  leasePath = path.join(artifactRoot, ".active-proof.json");
  await acquireLease();
  await recoverRuntimeProofArtifactPublication({ artifactRoot });
  await clearAbandonedSessions();
  session = await createRuntimeProofSessionRoot({ artifactRoot });
  progress.emit("container-readiness");
  engine = await detectEngine();
  try {
    sourceProvenance = await inspectRuntimeSourceProvenance({
      root: projectRoot,
    });
  } catch {
    throw new RuntimeProofError("source-unverified");
  }
  progress.emit("application-build");
  await runCommand(
    "npm",
    ["run", "build"],
    "startup-failed",
    APPLICATION_BUILD_TIMEOUT_MS,
  );
  progress.emit("runtime-image");
  const runtimeImage = await ensureRuntimeImage(engine);

  let ready = false;
  let readinessDigest = null;
  progress.emit("runtime-launch");
  launcher = spawn(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "run-container-browser-fixture.mjs"),
      "--demo",
      "--ephemeral",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        AIRLOCK_CONTAINER_DEMO_PORT: String(port),
        AIRLOCK_CONTAINER_DEMO_FIXTURE_PORT: String(fixturePort),
        AIRLOCK_RUNTIME_PROOF_ROOT: artifactRoot,
        AIRLOCK_RUNTIME_PROOF_SESSION_ROOT: session.sessionRoot,
        AIRLOCK_RUNTIME_PROOF_SESSION_NONCE: session.nonce,
        AIRLOCK_RUNTIME_PROOF_OWNER_PID: String(process.pid),
        CONTAINER_ENGINE: engine,
        CONTAINER_RUNTIME_IMAGE: runtimeImage,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  ownedChildren.add(launcher);
  launcherTree = createOwnedRuntimeProofProcessTree(launcher);
  runtimeInstanceId = `browser-${launcher.pid}`;
  launcherOutput = attachBoundedRuntimeProofCapture(launcher);
  let readinessProbe = "";
  function observeLauncherReadiness(chunk) {
    const value = chunk.toString("utf8");
    const observed = readinessProbe + value;
    if (observed.includes("Agent Airlock real Runtime proof is ready:")) {
      ready = true;
    }
    const match = observed.match(
      /Readiness:\s+\d+\/\d+ checks passed \((sha256:[a-f0-9]{64})\)\./,
    );
    if (match) readinessDigest = match[1];
    readinessProbe = observed.slice(-4_096);
  }
  launcher.stdout.on("data", observeLauncherReadiness);
  launcher.stderr.on("data", observeLauncherReadiness);
  detachLauncherReadiness = () => {
    launcher.stdout.off("data", observeLauncherReadiness);
    launcher.stderr.off("data", observeLauncherReadiness);
  };
  launcherExit = new Promise((resolve) => {
    launcher.once("error", (error) => resolve({ code: 1, error }));
    launcher.once("exit", (code, signalName) => resolve({ code, signalName }));
  });

  const startupDeadline = Date.now() + 120_000;
  while ((!ready || !readinessDigest) && Date.now() <= startupDeadline) {
    if (controller.signal.aborted) throw new RuntimeProofError("interrupted");
    const exited = await Promise.race([
      launcherExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (exited) {
      throw classifyRuntimeProofLauncherFailure(launcherOutput.text());
    }
  }
  if (!ready || !readinessDigest) throw new RuntimeProofError("startup-failed");

  progress.emit("browser-proof");
  recordingDeadlineAt = Date.now() + RUNTIME_PROOF_RECORDING_BUDGET_MS;
  recordingController = new AbortController();
  recordingTimer = setTimeout(() => {
    recordingController.abort(new RuntimeProofError("recording-timeout"));
  }, Math.max(0, recordingDeadlineAt - Date.now()));
  browserProofSignal = AbortSignal.any([
    controller.signal,
    recordingController.signal,
  ]);
  const browserDriver = await createPlaywrightRuntimeProofDriver({
    baseUrl: `http://${host}:${port}`,
    headless: !headed,
    presentationPacing: headed && !jsonOutput,
    recordingDeadlineAt,
    signal: browserProofSignal,
  });
  result = await runRuntimeProofSession({
    baseUrl: `http://${host}:${port}`,
    artifactRoot,
    readinessDigest,
    sourceProvenance,
    browserDriver,
    recordingDeadlineAt,
    signal: browserProofSignal,
    writeArtifacts: async (artifacts) => {
      pendingArtifacts = artifacts;
    },
  });
} catch (error) {
  failure = error;
}

let cleanupFailure = null;
let ownedProcessCleanupConfirmed = true;
let runtimeCleanupConfirmed = true;
function recordCleanupFailure(error) {
  cleanupFailure ??=
    error instanceof RuntimeProofError && error.failureClass === "cleanup-failed"
      ? error
      : new RuntimeProofError("cleanup-failed");
}

progress.emit("cleanup");
if (launcher) {
  try {
    if (launcherTree) {
      await stopOwnedRuntimeProofProcessTree(launcherTree);
    } else {
      await stopRuntimeProofChild(launcher);
    }
    const launcherOutcome = await launcherExit;
    if (!runtimeProofChildExitSucceeded(launcherOutcome)) {
      throw new RuntimeProofError("cleanup-failed");
    }
  } catch (error) {
    ownedProcessCleanupConfirmed = false;
    recordCleanupFailure(error);
  } finally {
    if (runtimeProofChildHasExited(launcher)) ownedChildren.delete(launcher);
    detachLauncherReadiness?.();
    launcherOutput?.detach();
  }
}
for (const child of [...ownedChildren]) {
  try {
    await stopRuntimeProofChild(child);
    if (!runtimeProofChildHasExited(child)) {
      throw new RuntimeProofError("cleanup-failed");
    }
  } catch (error) {
    ownedProcessCleanupConfirmed = false;
    recordCleanupFailure(error);
  } finally {
    if (runtimeProofChildHasExited(child)) ownedChildren.delete(child);
  }
}
try {
  await cleanupRuntimeContainers();
} catch (error) {
  runtimeCleanupConfirmed = false;
  recordCleanupFailure(error);
}
if (session && ownedProcessCleanupConfirmed && runtimeCleanupConfirmed) {
  try {
    await cleanupRuntimeProofSessionRoot({
      artifactRoot,
      sessionRoot: session.sessionRoot,
      nonce: session.nonce,
    });
  } catch (error) {
    recordCleanupFailure(error);
  }
}
failure ??= cleanupFailure;

if (!failure && pendingArtifacts && result) {
  try {
    progress.emit("publication");
    const publication = await finalizeRuntimeProofPublication({
      releaseOwnership: releaseLease,
      beforePublicationCommit: () => {
        try {
          assertMatchingRuntimeSourceProvenance(
            sourceProvenance,
            inspectRuntimeSourceProvenanceSync({ root: projectRoot }),
          );
        } catch {
          throw new RuntimeProofError("source-unverified");
        }
      },
      publishArtifacts: ({ beforeCommit, afterCommit }) =>
        writeRuntimeProofArtifacts({
          ...pendingArtifacts,
          beforeCommit,
          afterCommit,
          recordingDeadlineAt,
        }),
      signal: browserProofSignal,
      recordingDeadlineAt,
    });
    if (publication.cleanupIncomplete && !jsonOutput) {
      console.error(
        "Warning: the passed proof committed, but proof ownership cleanup remains incomplete.",
      );
    }
  } catch (error) {
    failure = error;
  }
} else {
  try {
    await releaseLease();
  } catch (error) {
    failure ??= error;
  }
}

if (recordingTimer !== null) clearTimeout(recordingTimer);

if (failure || !result) {
  const safeFailure = safeRuntimeProofFailure(failure);
  if (jsonOutput) {
    console.log(JSON.stringify(safeFailure));
  } else {
    console.error("");
    console.error("Real Runtime proof: FAILED");
    console.error(`Failure class: ${safeFailure.failureClass}`);
    console.error(safeFailure.message);
  }
  process.exit(1);
}

if (jsonOutput) {
  console.log(JSON.stringify(result));
} else {
  console.log("");
  console.log("Real Runtime proof: PASSED");
  console.log("Fresh three-Run safety loop: passed");
  console.log("Recording board at 1280 by 720 and 390 pixels: passed");
  console.log("Zero-upload browser verification: passed");
  console.log("Independent Node chain verification: passed");
  console.log(`Leaf receipt digest: ${result.leafReceiptDigest}`);
  console.log(
    "Authority: .local/airlock-runtime-proof/evidence/" +
      result.chainFile,
  );
}
