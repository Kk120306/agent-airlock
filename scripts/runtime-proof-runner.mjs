import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const RUNTIME_PROOF_RESULT_SCHEMA =
  "agent-airlock/real-runtime-proof-result";
export const RUNTIME_PROOF_CHAIN_DIRECTORY = "chains";
export const RUNTIME_PROOF_CAPSULE_DIRECTORY = "capsules";
export const RUNTIME_PROOF_RESULT_NAME = "real-runtime-proof.latest.json";
export const RUNTIME_PROOF_EVIDENCE_DIRECTORY = "evidence";
export const RUNTIME_PROOF_ROOT_MARKER =
  ".agent-airlock-runtime-proof-root";
export const RUNTIME_PROOF_SESSION_MARKER =
  ".agent-airlock-runtime-proof-session.json";

const ROOT_MARKER_CONTENT = "Agent Airlock real Runtime proof artifacts\n";
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const EXPECTED_RESOURCE_KINDS = [
  "codex-session",
  "external-actions",
  "sqlite",
  "workspace",
];
const DEFAULT_RUN_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
export const RUNTIME_PROOF_RECORDING_BUDGET_MS = 180_000;
export const RUNTIME_PROOF_RUN_POLLING_BUDGET_MS = 35_000;
export const RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS = 5_000;
const MAXIMUM_CHAIN_BYTES = 4_194_304;
const MAXIMUM_RESULT_BYTES = 262_144;
export const RUNTIME_PROOF_PRESENTATION_DWELL_MS = Object.freeze({
  "opening-cta": 15_000,
  "desktop-outcome-brief": 85_000,
  "desktop-verifier": 25_000,
});
export const RUNTIME_PROOF_PRESENTATION_DWELL_BUDGET_MS = Object.values(
  RUNTIME_PROOF_PRESENTATION_DWELL_MS,
).reduce((total, milliseconds) => total + milliseconds, 0);
export const RUNTIME_PROOF_POST_RUN_RESERVE_MS =
  RUNTIME_PROOF_PRESENTATION_DWELL_MS["desktop-outcome-brief"] +
  RUNTIME_PROOF_PRESENTATION_DWELL_MS["desktop-verifier"] +
  RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS;
export const RUNTIME_PROOF_RECORDING_HEADROOM_MS =
  RUNTIME_PROOF_RECORDING_BUDGET_MS -
  RUNTIME_PROOF_PRESENTATION_DWELL_MS["opening-cta"] -
  RUNTIME_PROOF_RUN_POLLING_BUDGET_MS -
  RUNTIME_PROOF_POST_RUN_RESERVE_MS;
const PUBLICATION_JOURNAL_NAME = ".real-runtime-proof-publication.json";
const PUBLICATION_DIRECTORY_PREFIX = ".runtime-proof-publish-";
const LEGACY_PUBLICATION_LOCK_NAME = ".real-runtime-proof-publication.lock";
const LEGACY_RUNTIME_PROOF_CHAIN_NAME =
  "real-runtime-decision-chain.latest.json";
const RUNTIME_PROOF_ARTIFACT_WORKER = fileURLToPath(
  new URL("./runtime-proof-artifact-worker.mjs", import.meta.url),
);
const ARTIFACT_WORKER_TIMEOUT_MS = 15_000;
const MAXIMUM_ARTIFACT_WORKER_OUTPUT_BYTES = 6_500_000;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FORBIDDEN_RESULT_PATTERN =
  /Bearer\s|ARK_API_KEY|api[_-]?key\s*[=:]|https?:\/\/|\bep-[A-Za-z0-9]|\bark-[A-Za-z0-9]|(?:^|["'\s])\/(?:Users|home|private|tmp|var)\//i;

const FAILURE_MESSAGES = Object.freeze({
  "runtime-unavailable":
    "A running Docker, Colima, or Podman engine is required for the real Runtime proof.",
  "image-build-failed":
    "The exact pinned Runtime image could not be prepared.",
  "startup-failed":
    "The fresh real Runtime proof launcher did not reach its admitted ready state.",
  "stale-state":
    "The supposedly fresh proof state already contains ordinary Runs.",
  "browser-failed":
    "Chrome could not invoke or observe the production complete safety loop.",
  "viewport-invalid":
    "The verified recording brief did not pass the 1280 by 720 and 390-pixel presentation gates.",
  "run-timeout":
    "The three-Run safety loop did not reach terminal evidence inside the bounded window.",
  "recording-timeout":
    "The complete browser proof did not finish inside the three-minute recording window.",
  "stage-timeout":
    "A real Runtime proof preparation stage exceeded its bounded execution window.",
  "run-failed":
    "One of the browser-created Runs failed or was cancelled.",
  "run-set-invalid":
    "The browser did not create exactly one promoted root, one quarantined root, and one promoted Repair child.",
  "promotion-invalid":
    "The promoted root does not prove the expected four-resource acceptance and post-Promotion effect.",
  "quarantine-invalid":
    "The rejected root does not prove four-resource Quarantine, unchanged Canonical State, and zero effects.",
  "repair-invalid":
    "The Repair child does not prove exact rejected-parent lineage, four-resource Promotion, and one fresh effect.",
  "verifier-invalid":
    "The zero-upload verifier did not show the complete two-decision recovery proof.",
  "chain-invalid":
    "The exact UI-generated decision chain failed independent offline verification.",
  "artifact-write-failed":
    "The verified authority artifact and safe result capsule could not be preserved atomically.",
  "cleanup-failed":
    "A process-owned proof resource could not be cleaned up safely.",
  interrupted:
    "The real Runtime proof was interrupted and no passed result was recorded.",
});

export class RuntimeProofError extends Error {
  constructor(failureClass, message = FAILURE_MESSAGES[failureClass]) {
    super(message ?? FAILURE_MESSAGES["startup-failed"]);
    this.name = "RuntimeProofError";
    this.failureClass = failureClass;
  }
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RuntimeProofError) throw signal.reason;
  throw new RuntimeProofError("interrupted");
}

function assertRuntimeProofRecordingWindow({
  recordingDeadlineAt = Number.POSITIVE_INFINITY,
  now = Date.now,
  signal,
}) {
  abortIfNeeded(signal);
  const observedAt = now();
  if (
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt) ||
    (recordingDeadlineAt !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(recordingDeadlineAt) ||
        observedAt >= recordingDeadlineAt))
  ) {
    throw new RuntimeProofError(
      Number.isFinite(observedAt) && Number.isFinite(recordingDeadlineAt)
        ? "recording-timeout"
        : "startup-failed",
    );
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeIdentifier(value) {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function samePhysicalIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function ownedByCurrentUser(status) {
  return typeof process.geteuid !== "function" ||
    status?.uid === process.geteuid();
}

function runtimeProofProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function parseRuntimeProofSessionMarker(markerBytes, sessionName) {
  let marker;
  try {
    marker = JSON.parse(markerBytes.toString("utf8"));
  } catch {
    throw new RuntimeProofError("cleanup-failed");
  }
  if (
    !exactKeys(marker, ["nonce", "ownerPid", "schema", "schemaVersion"]) ||
    marker.schema !== "agent-airlock/runtime-proof-session" ||
    marker.schemaVersion !== 1 ||
    !Number.isSafeInteger(marker.ownerPid) ||
    marker.ownerPid < 1 ||
    marker.ownerPid > 2_147_483_647 ||
    typeof marker.nonce !== "string" ||
    !UUID_PATTERN.test(marker.nonce) ||
    sessionName !== `session-${marker.ownerPid}-${marker.nonce}`
  ) {
    throw new RuntimeProofError("cleanup-failed");
  }
  return marker;
}

async function openOwnerOnlyDirectory(
  directoryPath,
  { realParentDirectory = null } = {},
  fsImpl,
) {
  let handle = null;
  try {
    const before = await fsImpl.lstat(directoryPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (
      !before?.isDirectory() ||
      before.isSymbolicLink() ||
      !ownedByCurrentUser(before) ||
      (before.mode & 0o077) !== 0 ||
      typeof fsConstants.O_NOFOLLOW !== "number" ||
      typeof fsConstants.O_DIRECTORY !== "number"
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const realDirectory = await fsImpl.realpath(directoryPath);
    if (
      realParentDirectory !== null &&
      path.dirname(realDirectory) !== realParentDirectory
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    handle = await fsImpl.open(
      directoryPath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_DIRECTORY,
    );
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      !ownedByCurrentUser(opened) ||
      (opened.mode & 0o077) !== 0 ||
      !samePhysicalIdentity(before, opened)
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const after = await fsImpl.lstat(directoryPath);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !ownedByCurrentUser(after) ||
      (after.mode & 0o077) !== 0 ||
      !samePhysicalIdentity(before, after) ||
      (await fsImpl.realpath(directoryPath)) !== realDirectory
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    return {
      directoryPath,
      realDirectory,
      dev: opened.dev,
      ino: opened.ino,
      handle,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof RuntimeProofError) throw error;
    throw new RuntimeProofError("artifact-write-failed");
  }
}

async function assertDirectoryAnchor(anchor, fsImpl) {
  try {
    const [current, opened, realDirectory] = await Promise.all([
      fsImpl.lstat(anchor.directoryPath),
      anchor.handle.stat(),
      fsImpl.realpath(anchor.directoryPath),
    ]);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !ownedByCurrentUser(current) ||
      (current.mode & 0o077) !== 0 ||
      !opened.isDirectory() ||
      !ownedByCurrentUser(opened) ||
      (opened.mode & 0o077) !== 0 ||
      current.dev !== anchor.dev ||
      current.ino !== anchor.ino ||
      opened.dev !== anchor.dev ||
      opened.ino !== anchor.ino ||
      realDirectory !== anchor.realDirectory
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
  } catch (error) {
    if (error instanceof RuntimeProofError) throw error;
    throw new RuntimeProofError("artifact-write-failed");
  }
}

async function closeDirectoryAnchor(anchor) {
  await anchor?.handle?.close().catch(() => {});
}

export async function runRuntimeProofArtifactWorker(
  anchor,
  request,
  { signal, spawnImpl = spawn } = {},
) {
  if (typeof spawnImpl !== "function") {
    throw new RuntimeProofError("artifact-write-failed");
  }
  abortIfNeeded(signal);
  await assertDirectoryAnchor(anchor, {
    lstat,
    realpath,
  });
  abortIfNeeded(signal);
  const workerRequest = {
    ...request,
    anchorDev: String(anchor.dev),
    anchorIno: String(anchor.ino),
  };
  let child;
  try {
    child = spawnImpl(process.execPath, [RUNTIME_PROOF_ARTIFACT_WORKER], {
      cwd: anchor.directoryPath,
      env: {},
      stdio: ["pipe", "pipe", "ignore", anchor.handle.fd],
    });
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const chunks = [];
  let outputBytes = 0;
  let outputExceeded = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAXIMUM_ARTIFACT_WORKER_OUTPUT_BYTES) {
      outputExceeded = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(workerRequest));
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let timedOut = false;
    let spawnFailed = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ARTIFACT_WORKER_TIMEOUT_MS);
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signalName) =>
      finish({
        code,
        signalName: spawnFailed
          ? "error"
          : timedOut
            ? "timeout"
            : signalName,
      }),
    );
  });
  signal?.removeEventListener("abort", onAbort);
  if (aborted || signal?.aborted) abortIfNeeded(signal);
  if (
    outputExceeded ||
    outcome.code !== 0 ||
    outcome.signalName !== null ||
    outputBytes < 1
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  let response;
  try {
    response = JSON.parse(Buffer.concat(chunks, outputBytes).toString("utf8"));
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  if (!response?.ok) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(anchor, {
    lstat,
    realpath,
  });
  return response;
}

export function runtimeProofChainFile(chainDigest) {
  if (!SHA256_PATTERN.test(chainDigest ?? "")) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return (
    RUNTIME_PROOF_CHAIN_DIRECTORY +
    "/sha256-" +
    chainDigest.slice("sha256:".length) +
    ".json"
  );
}

export function runtimeProofCapsuleFile(resultBytes) {
  if (!Buffer.isBuffer(resultBytes) || resultBytes.length < 1) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return (
    RUNTIME_PROOF_CAPSULE_DIRECTORY +
    "/sha256-" +
    sha256(resultBytes).slice("sha256:".length) +
    ".json"
  );
}

function ordinaryRuns(runs) {
  if (!Array.isArray(runs)) throw new RuntimeProofError("run-set-invalid");
  return runs.filter(
    (run) => run?.candidateSetId === null && run?.competitorId === null,
  );
}

async function requestJson(baseUrl, pathname, fetchImpl, signal, failureClass) {
  abortIfNeeded(signal);
  let response;
  try {
    const timeout = AbortSignal.timeout(10_000);
    response = await fetchImpl(baseUrl + pathname, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    abortIfNeeded(signal);
    throw new RuntimeProofError(failureClass);
  }
  if (!response?.ok) throw new RuntimeProofError(failureClass);
  try {
    return await response.json();
  } catch {
    throw new RuntimeProofError(failureClass);
  }
}

async function delay(milliseconds, signal, waitImpl) {
  abortIfNeeded(signal);
  await waitImpl(milliseconds, signal);
  abortIfNeeded(signal);
}

function abortableTimeout(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      try {
        abortIfNeeded(signal);
      } catch (error) {
        reject(error);
      }
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRuntimeProofPresentationPacer({
  enabled = false,
  now = Date.now,
  recordingDeadlineAt = Number.POSITIVE_INFINITY,
  signal,
  tailReserveMs = RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS,
  waitImpl = abortableTimeout,
} = {}) {
  if (
    typeof now !== "function" ||
    (!Number.isFinite(recordingDeadlineAt) &&
      recordingDeadlineAt !== Number.POSITIVE_INFINITY) ||
    !Number.isInteger(tailReserveMs) ||
    tailReserveMs < 0
  ) {
    throw new RuntimeProofError("browser-failed");
  }
  return {
    async dwell(moment, dwellSignal) {
      const effectiveSignal =
        signal && dwellSignal
          ? AbortSignal.any([signal, dwellSignal])
          : (signal ?? dwellSignal);
      const requestedMilliseconds = RUNTIME_PROOF_PRESENTATION_DWELL_MS[moment];
      if (
        !Number.isInteger(requestedMilliseconds) ||
        requestedMilliseconds <= 0
      ) {
        throw new RuntimeProofError("browser-failed");
      }
      abortIfNeeded(effectiveSignal);
      if (!enabled) return;
      const followingDwellReserve =
        moment === "desktop-outcome-brief"
          ? RUNTIME_PROOF_PRESENTATION_DWELL_MS["desktop-verifier"]
          : 0;
      const remainingPresentationMilliseconds = Number.isFinite(
        recordingDeadlineAt,
      )
        ? Math.floor(
            recordingDeadlineAt -
              now() -
              tailReserveMs -
              followingDwellReserve,
          )
        : requestedMilliseconds;
      if (remainingPresentationMilliseconds < requestedMilliseconds) {
        throw new RuntimeProofError("recording-timeout");
      }
      await delay(requestedMilliseconds, effectiveSignal, waitImpl);
    },
  };
}

function uniqueRuntimeProofAgent(agents) {
  if (!Array.isArray(agents)) throw new RuntimeProofError("startup-failed");
  const matches = agents.filter((agent) => agent?.name === "Real Runtime Proof");
  if (
    matches.length !== 1 ||
    !safeIdentifier(matches[0]?.id) ||
    !safeIdentifier(matches[0]?.canonicalStateId)
  ) {
    throw new RuntimeProofError("startup-failed");
  }
  return matches[0];
}

function hasExactResources(transaction, disposition) {
  if (!Array.isArray(transaction?.resources) || transaction.resources.length !== 4) {
    return false;
  }
  const resources = transaction.resources
    .map((resource) => ({
      kind: resource?.kind,
      disposition: resource?.disposition,
    }))
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind), "en"));
  return (
    resources.every((resource, index) =>
      resource.kind === EXPECTED_RESOURCE_KINDS[index] &&
      resource.disposition === disposition,
    )
  );
}

function exactEffect(transaction, { id, status, deliveredCount }) {
  const effects = transaction?.externalActions;
  const intent = effects?.intents?.[0];
  const promoting = transaction?.events?.filter(
    (event) => event?.status === "promoting",
  );
  const promoted = transaction?.events?.filter(
    (event) => event?.status === "promoted",
  );
  const deliveredAt = Date.parse(intent?.deliveredAt ?? "");
  const promotingAt = Date.parse(promoting?.[0]?.at ?? "");
  const promotedAt = Date.parse(promoted?.[0]?.at ?? "");
  const deliveryChronologyValid = status === "delivered"
    ? promoting?.length === 1 &&
      promoted?.length === 1 &&
      [deliveredAt, promotingAt, promotedAt].every(Number.isFinite) &&
      promotingAt <= deliveredAt &&
      deliveredAt <= promotedAt
    : intent?.deliveredAt === null &&
      promoting?.length === 0 &&
      promoted?.length === 0;
  return (
    effects?.deliveredCount === deliveredCount &&
    Array.isArray(effects?.intents) &&
    effects.intents.length === 1 &&
    intent?.id === id &&
    intent?.status === status &&
    safeIdentifier(intent?.idempotencyKey) &&
    deliveryChronologyValid
  );
}

function hasSqliteValue(transaction, value, snapshotName = "after") {
  const rows = transaction?.sqlite?.[snapshotName]?.rows;
  return (
    Array.isArray(rows) &&
    rows.some((row) => row?.id === "demo" && row?.value === value)
  );
}

function requiredValidations(transaction, expected) {
  const required = transaction?.validations?.filter(
    (validation) => validation?.required === true,
  );
  if (!Array.isArray(required) || required.length < 1) return false;
  if (expected === "passed") {
    return required.every((validation) => validation?.status === "passed");
  }
  return required.some(
    (validation) =>
      validation?.name === "command:protocol-content" &&
      validation?.status === "failed",
  );
}

function sameOutcomeContract(...transactions) {
  const version = transactions[0]?.outcomeContractVersion;
  const contract = transactions[0]?.outcomeContract;
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract)
  ) {
    return false;
  }
  const serialized = JSON.stringify(contract);
  return transactions.every(
    (transaction) =>
      transaction?.outcomeContractVersion === version &&
      JSON.stringify(transaction?.outcomeContract) === serialized,
  );
}

function rootLineage(run) {
  const lineage = run?.transaction?.lineage;
  return (
    lineage?.rootRunId === run?.id &&
    lineage?.parentRunId === null &&
    lineage?.depth === 0
  );
}

function commonTerminalRun(run, disposition) {
  return (
    safeIdentifier(run?.id) &&
    run?.status === "completed" &&
    run?.transaction?.status === disposition &&
    run?.transaction?.disposition === disposition &&
    safeIdentifier(run?.transaction?.canonicalStateIdBefore) &&
    safeIdentifier(run?.transaction?.canonicalStateIdAfter) &&
    SHA256_PATTERN.test(run?.transaction?.canonicalContentHashBefore ?? "") &&
    SHA256_PATTERN.test(run?.transaction?.canonicalContentHashAfter ?? "")
  );
}

export function verifyRuntimeProofRuns({ agent, runs }) {
  const ordinary = ordinaryRuns(runs);
  if (ordinary.length !== 3) throw new RuntimeProofError("run-set-invalid");
  if (
    new Set(ordinary.map((run) => run?.id)).size !== 3 ||
    ordinary.some((run) => run?.agentId !== agent?.id)
  ) {
    throw new RuntimeProofError("run-set-invalid");
  }
  if (
    ordinary.some(
      (run) =>
        run?.status === "failed" ||
        run?.status === "cancelled" ||
        run?.transaction?.status === "recovery-error",
    )
  ) {
    throw new RuntimeProofError("run-failed");
  }

  const promotedRoots = ordinary.filter(
    (run) =>
      run?.transaction?.disposition === "promoted" &&
      run?.transaction?.lineage?.depth === 0,
  );
  const quarantinedRoots = ordinary.filter(
    (run) =>
      run?.transaction?.disposition === "quarantined" &&
      run?.transaction?.lineage?.depth === 0,
  );
  const repairs = ordinary.filter(
    (run) =>
      run?.transaction?.disposition === "promoted" &&
      run?.transaction?.lineage?.depth === 1,
  );
  if (
    promotedRoots.length !== 1 ||
    quarantinedRoots.length !== 1 ||
    repairs.length !== 1
  ) {
    throw new RuntimeProofError("run-set-invalid");
  }

  const promotion = promotedRoots[0];
  const quarantine = quarantinedRoots[0];
  const repair = repairs[0];
  const promoted = promotion.transaction;
  const rejected = quarantine.transaction;
  const repaired = repair.transaction;

  if (!sameOutcomeContract(promoted, rejected, repaired)) {
    throw new RuntimeProofError("run-set-invalid");
  }

  const chronology = [promotion, quarantine, repair].map((run) =>
    Date.parse(run?.createdAt ?? ""),
  );
  if (
    chronology.some((value) => !Number.isFinite(value)) ||
    !(chronology[0] < chronology[1] && chronology[1] < chronology[2])
  ) {
    throw new RuntimeProofError("run-set-invalid");
  }

  if (
    !commonTerminalRun(promotion, "promoted") ||
    !rootLineage(promotion) ||
    promoted.canonicalStateIdBefore !== agent.canonicalStateId ||
    promoted.canonicalStateIdAfter === promoted.canonicalStateIdBefore ||
    promoted.canonicalContentHashAfter === promoted.canonicalContentHashBefore ||
    !hasExactResources(promoted, "promoted") ||
    !hasSqliteValue(promoted, "candidate-only", "candidate") ||
    !hasSqliteValue(promoted, "candidate-only") ||
    !requiredValidations(promoted, "passed") ||
    promoted.recovery?.journalPhase !== "completed" ||
    !exactEffect(promoted, {
      id: "protocol-release-ready",
      status: "delivered",
      deliveredCount: 1,
    })
  ) {
    throw new RuntimeProofError("promotion-invalid");
  }

  if (
    !commonTerminalRun(quarantine, "quarantined") ||
    !rootLineage(quarantine) ||
    rejected.canonicalStateIdBefore !== promoted.canonicalStateIdAfter ||
    rejected.canonicalContentHashBefore !== promoted.canonicalContentHashAfter ||
    rejected.canonicalStateIdAfter !== rejected.canonicalStateIdBefore ||
    rejected.canonicalContentHashAfter !== rejected.canonicalContentHashBefore ||
    !hasExactResources(rejected, "quarantined") ||
    !hasSqliteValue(rejected, "unsafe-candidate", "candidate") ||
    !hasSqliteValue(rejected, "candidate-only") ||
    !requiredValidations(rejected, "failed") ||
    !exactEffect(rejected, {
      id: "protocol-unsafe",
      status: "rejected",
      deliveredCount: 0,
    })
  ) {
    throw new RuntimeProofError("quarantine-invalid");
  }

  const repairEffect = repaired?.externalActions?.intents?.[0];
  const promotionEffect = promoted?.externalActions?.intents?.[0];
  if (
    !commonTerminalRun(repair, "promoted") ||
    repaired.lineage?.rootRunId !== quarantine.id ||
    repaired.lineage?.parentRunId !== quarantine.id ||
    repaired.lineage?.depth !== 1 ||
    repaired.canonicalStateIdBefore !== rejected.canonicalStateIdAfter ||
    repaired.canonicalContentHashBefore !== rejected.canonicalContentHashAfter ||
    repaired.canonicalStateIdAfter === repaired.canonicalStateIdBefore ||
    repaired.canonicalContentHashAfter === repaired.canonicalContentHashBefore ||
    !hasExactResources(repaired, "promoted") ||
    !hasSqliteValue(repaired, "candidate-only", "candidate") ||
    !hasSqliteValue(repaired, "candidate-only") ||
    !requiredValidations(repaired, "passed") ||
    repaired.recovery?.journalPhase !== "completed" ||
    !exactEffect(repaired, {
      id: "protocol-repair-ready",
      status: "delivered",
      deliveredCount: 1,
    }) ||
    repairEffect?.idempotencyKey === promotionEffect?.idempotencyKey ||
    repairEffect?.idempotencyKey ===
      rejected?.externalActions?.intents?.[0]?.idempotencyKey
  ) {
    throw new RuntimeProofError("repair-invalid");
  }

  return { promotion, quarantine, repair };
}

async function waitForExactRunSet({
  baseUrl,
  agent,
  initialRunIds,
  fetchImpl,
  now,
  pollIntervalMs,
  recordingDeadlineAt,
  runTimeoutMs,
  signal,
  waitImpl,
}) {
  const pollingStartedAt = now();
  const deadline = Math.min(
    pollingStartedAt + runTimeoutMs,
    pollingStartedAt + RUNTIME_PROOF_RUN_POLLING_BUDGET_MS,
    recordingDeadlineAt - RUNTIME_PROOF_POST_RUN_RESERVE_MS,
  );
  while (now() <= deadline) {
    const payload = await requestJson(
      baseUrl,
      `/api/agents/${agent.id}/runs`,
      fetchImpl,
      signal,
      "run-failed",
    );
    const created = ordinaryRuns(payload?.runs).filter(
      (run) => !initialRunIds.has(run?.id),
    );
    if (created.length > 3) throw new RuntimeProofError("run-set-invalid");
    if (
      created.some(
        (run) =>
          run?.status === "failed" ||
          run?.status === "cancelled" ||
          run?.transaction?.status === "recovery-error",
      )
    ) {
      throw new RuntimeProofError("run-failed");
    }
    if (
      created.length === 3 &&
      created.every((run) => TERMINAL_RUN_STATUSES.has(run?.status))
    ) {
      return verifyRuntimeProofRuns({ agent, runs: created });
    }
    const remainingMilliseconds = Math.floor(deadline - now());
    if (remainingMilliseconds <= 0) break;
    await delay(
      Math.min(pollIntervalMs, remainingMilliseconds),
      signal,
      waitImpl,
    );
  }
  throw new RuntimeProofError("run-timeout");
}

async function recheckExactRunSet({
  baseUrl,
  agent,
  initialRunIds,
  expectedRuns,
  fetchImpl,
  signal,
}) {
  const payload = await requestJson(
    baseUrl,
    `/api/agents/${agent.id}/runs`,
    fetchImpl,
    signal,
    "run-set-invalid",
  );
  const created = ordinaryRuns(payload?.runs).filter(
    (run) => !initialRunIds.has(run?.id),
  );
  const verified = verifyRuntimeProofRuns({ agent, runs: created });
  for (const name of ["promotion", "quarantine", "repair"]) {
    if (
      verified[name].id !== expectedRuns[name].id ||
      !isDeepStrictEqual(verified[name], expectedRuns[name])
    ) {
      throw new RuntimeProofError("run-set-invalid");
    }
  }
  return verified;
}

function assertVerifiedDecisionChain({ source, report, runs }) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") < 1 ||
    Buffer.byteLength(source, "utf8") > MAXIMUM_CHAIN_BYTES ||
    !report?.valid ||
    !Array.isArray(report?.packets) ||
    report.packets.length !== 2 ||
    !SHA256_PATTERN.test(report?.leafReceiptDigest ?? "") ||
    !Array.isArray(report?.checks) ||
    !["chain-links", "chain-state-continuity"].every((name) =>
      report.checks.some((check) => check?.name === name && check?.valid === true),
    )
  ) {
    throw new RuntimeProofError("chain-invalid");
  }
  let chain;
  try {
    chain = JSON.parse(source);
  } catch {
    throw new RuntimeProofError("chain-invalid");
  }
  const packets = chain?.packets;
  if (!Array.isArray(packets) || packets.length !== 2) {
    throw new RuntimeProofError("chain-invalid");
  }
  const parent = packets[0]?.envelope?.receipt;
  const child = packets[1]?.envelope?.receipt;
  const rejected = runs.quarantine.transaction;
  const repaired = runs.repair.transaction;
  if (
    parent?.decision?.runId !== runs.quarantine.id ||
    parent?.decision?.disposition !== "quarantined" ||
    child?.decision?.runId !== runs.repair.id ||
    child?.decision?.disposition !== "promoted" ||
    parent?.state?.before?.stateId !== rejected.canonicalStateIdBefore ||
    parent?.state?.before?.compositeHash !== rejected.canonicalContentHashBefore ||
    parent?.state?.after?.stateId !== rejected.canonicalStateIdAfter ||
    parent?.state?.after?.compositeHash !== rejected.canonicalContentHashAfter ||
    child?.state?.before?.stateId !== repaired.canonicalStateIdBefore ||
    child?.state?.before?.compositeHash !== repaired.canonicalContentHashBefore ||
    child?.state?.after?.stateId !== repaired.canonicalStateIdAfter ||
    child?.state?.after?.compositeHash !== repaired.canonicalContentHashAfter ||
    child?.ancestry?.parentRunId !== runs.quarantine.id ||
    child?.ancestry?.previousReceiptDigest !== packets[0]?.envelope?.receiptDigest ||
    report.leafReceiptDigest !== packets[1]?.envelope?.receiptDigest
  ) {
    throw new RuntimeProofError("chain-invalid");
  }
  return {
    chainDigest: sha256(Buffer.from(source, "utf8")),
    leafReceiptDigest: report.leafReceiptDigest,
  };
}

function capsuleRun(run) {
  return {
    runId: run.id,
    disposition: run.transaction.disposition,
    canonicalStateIdBefore: run.transaction.canonicalStateIdBefore,
    canonicalStateIdAfter: run.transaction.canonicalStateIdAfter,
    canonicalContentHashBefore: run.transaction.canonicalContentHashBefore,
    canonicalContentHashAfter: run.transaction.canonicalContentHashAfter,
  };
}

export function buildRuntimeProofResult({
  observedAt,
  readinessDigest,
  runs,
  chainDigest,
  leafReceiptDigest,
}) {
  const result = {
    schema: RUNTIME_PROOF_RESULT_SCHEMA,
    schemaVersion: 1,
    outcome: "passed",
    authority: "signed-decision-chain-not-this-capsule",
    observedAt,
    clockClaim: "observer-clock-not-external-timestamp",
    readinessDigest,
    runs: {
      promotion: capsuleRun(runs.promotion),
      quarantine: capsuleRun(runs.quarantine),
      repair: capsuleRun(runs.repair),
    },
    leafReceiptDigest,
    chainDigest,
    chainFile: runtimeProofChainFile(chainDigest),
    gates: {
      freshState: true,
      browserInvocation: true,
      exactRunSet: true,
      promotion: true,
      quarantine: true,
      repair: true,
      zeroUploadVerifier: true,
      offlineChainVerification: true,
      recordingBoardDesktop: true,
      recordingBoardMobile: true,
    },
  };
  assertSafeRuntimeProofResult(result);
  return result;
}

function assertCapsuleRun(value, disposition) {
  return (
    exactKeys(value, [
      "canonicalContentHashAfter",
      "canonicalContentHashBefore",
      "canonicalStateIdAfter",
      "canonicalStateIdBefore",
      "disposition",
      "runId",
    ]) &&
    safeIdentifier(value.runId) &&
    value.disposition === disposition &&
    safeIdentifier(value.canonicalStateIdBefore) &&
    safeIdentifier(value.canonicalStateIdAfter) &&
    SHA256_PATTERN.test(value.canonicalContentHashBefore) &&
    SHA256_PATTERN.test(value.canonicalContentHashAfter)
  );
}

export function assertSafeRuntimeProofResult(result) {
  const expectedGates = [
    "browserInvocation",
    "exactRunSet",
    "freshState",
    "offlineChainVerification",
    "promotion",
    "quarantine",
    "recordingBoardDesktop",
    "recordingBoardMobile",
    "repair",
    "zeroUploadVerifier",
  ];
  if (
    !exactKeys(result, [
      "authority",
      "chainDigest",
      "chainFile",
      "clockClaim",
      "gates",
      "leafReceiptDigest",
      "observedAt",
      "outcome",
      "readinessDigest",
      "runs",
      "schema",
      "schemaVersion",
    ]) ||
    result.schema !== RUNTIME_PROOF_RESULT_SCHEMA ||
    result.schemaVersion !== 1 ||
    result.outcome !== "passed" ||
    result.authority !== "signed-decision-chain-not-this-capsule" ||
    result.clockClaim !== "observer-clock-not-external-timestamp" ||
    typeof result.observedAt !== "string" ||
    !Number.isFinite(Date.parse(result.observedAt)) ||
    !SHA256_PATTERN.test(result.readinessDigest ?? "") ||
    !SHA256_PATTERN.test(result.leafReceiptDigest ?? "") ||
    !SHA256_PATTERN.test(result.chainDigest ?? "") ||
    result.chainFile !== runtimeProofChainFile(result.chainDigest) ||
    !exactKeys(result.runs, ["promotion", "quarantine", "repair"]) ||
    !assertCapsuleRun(result.runs.promotion, "promoted") ||
    !assertCapsuleRun(result.runs.quarantine, "quarantined") ||
    !assertCapsuleRun(result.runs.repair, "promoted") ||
    !exactKeys(result.gates, expectedGates) ||
    !Object.values(result.gates).every((value) => value === true)
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const serialized = JSON.stringify(result);
  if (FORBIDDEN_RESULT_PATTERN.test(serialized)) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return serialized;
}

async function readOwnerOnlyPhysicalFile(
  filePath,
  { maximumBytes, parentAnchor = null },
  fsImpl,
  artifactIo = runRuntimeProofArtifactWorker,
) {
  try {
    if (
      !parentAnchor ||
      path.dirname(filePath) !== parentAnchor.directoryPath ||
      !Number.isInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > MAXIMUM_CHAIN_BYTES
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    const response = await artifactIo(parentAnchor, {
      operation: "read",
      name: path.basename(filePath),
      maximumBytes,
    });
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    if (response.content === null) return null;
    if (typeof response.content !== "string") {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const bytes = Buffer.from(response.content, "base64");
    if (
      bytes.length > maximumBytes ||
      bytes.toString("base64") !== response.content
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    return bytes;
  } catch (error) {
    if (error instanceof RuntimeProofError) throw error;
    throw new RuntimeProofError("artifact-write-failed");
  }
}

async function atomicWrite(
  filePath,
  content,
  fsImpl,
  parentAnchor,
  beforeRename = () => {},
  afterRename = () => {},
  artifactIo = runRuntimeProofArtifactWorker,
  signal,
  recordingDeadlineAt = Number.MAX_SAFE_INTEGER,
) {
  let token = null;
  try {
    if (
      !parentAnchor ||
      path.dirname(filePath) !== parentAnchor.directoryPath
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const bytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content, "utf8");
    if (bytes.length < 1 || bytes.length > MAXIMUM_CHAIN_BYTES) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    const prepared = await artifactIo(parentAnchor, {
      operation: "prepare-replace",
      name: path.basename(filePath),
      content: bytes.toString("base64"),
      maximumBytes: bytes.length,
    });
    token = prepared.token;
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    const boundaryResult = beforeRename();
    if (boundaryResult && typeof boundaryResult.then === "function") {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    let commitError = null;
    let committed = null;
    try {
      committed = await artifactIo(
        parentAnchor,
        {
          operation: "commit-replace",
          name: path.basename(filePath),
          token,
          recordingDeadlineAt,
        },
        { signal },
      );
      if (committed.committed !== true) {
        throw new RuntimeProofError("artifact-write-failed");
      }
    } catch (error) {
      commitError =
        error instanceof RuntimeProofError
          ? error
          : new RuntimeProofError("artifact-write-failed");
      let reconciled;
      try {
        reconciled = await artifactIo(
          parentAnchor,
          {
            operation: "reconcile-replace",
            name: path.basename(filePath),
            token,
          },
          { signal: undefined },
        );
      } catch {
        throw new RuntimeProofError("artifact-write-failed");
      }
      if (reconciled?.committed !== true) {
        if (reconciled?.committed !== false) {
          throw new RuntimeProofError("artifact-write-failed");
        }
        throw commitError;
      }
      committed = reconciled;
    }
    token = null;
    await assertDirectoryAnchor(parentAnchor, fsImpl);
    const completionResult = afterRename();
    if (completionResult && typeof completionResult.then === "function") {
      throw new RuntimeProofError("artifact-write-failed");
    }
  } finally {
    if (token) {
      await artifactIo(
        parentAnchor,
        {
          operation: "discard-prepared",
          token,
        },
        { signal: undefined },
      ).catch(() => {});
    }
  }
}

async function installImmutableFile(
  filePath,
  content,
  maximumBytes,
  parentAnchor,
  fsImpl,
  artifactIo = runRuntimeProofArtifactWorker,
) {
  if (
    !parentAnchor ||
    path.dirname(filePath) !== parentAnchor.directoryPath ||
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") < 1 ||
    Buffer.byteLength(content, "utf8") > maximumBytes
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  const response = await artifactIo(parentAnchor, {
    operation: "install-immutable",
    name: path.basename(filePath),
    content: Buffer.from(content, "utf8").toString("base64"),
    maximumBytes,
  });
  if (typeof response.installed !== "boolean") {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
}

async function ensurePrivateDirectory(
  parentAnchor,
  name,
  fsImpl,
  artifactIo = runRuntimeProofArtifactWorker,
) {
  if (
    !parentAnchor ||
    typeof name !== "string" ||
    path.basename(name) !== name
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  const response = await artifactIo(parentAnchor, {
    operation: "ensure-private-directory",
    name,
  });
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  const directoryPath = path.join(parentAnchor.directoryPath, name);
  const childAnchor = await openOwnerOnlyDirectory(
    directoryPath,
    { realParentDirectory: parentAnchor.realDirectory },
    fsImpl,
  );
  if (
    response.dev !== String(childAnchor.dev) ||
    response.ino !== String(childAnchor.ino)
  ) {
    await closeDirectoryAnchor(childAnchor);
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  return childAnchor;
}

async function removeOwnerOnlyLeaf(
  filePath,
  maximumBytes,
  parentAnchor,
  fsImpl,
  artifactIo = runRuntimeProofArtifactWorker,
) {
  if (
    !parentAnchor ||
    path.dirname(filePath) !== parentAnchor.directoryPath
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  const response = await artifactIo(parentAnchor, {
    operation: "remove-owner-only-leaf",
    name: path.basename(filePath),
    maximumBytes,
  });
  if (typeof response.removed !== "boolean") {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  return response.removed;
}

async function removeEmptyPrivateDirectory(
  directoryPath,
  parentAnchor,
  fsImpl,
  artifactIo = runRuntimeProofArtifactWorker,
) {
  if (
    !parentAnchor ||
    path.dirname(directoryPath) !== parentAnchor.directoryPath
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  const response = await artifactIo(parentAnchor, {
    operation: "remove-empty-private-directory",
    name: path.basename(directoryPath),
  });
  if (typeof response.removed !== "boolean") {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(parentAnchor, fsImpl);
  return response.removed;
}

function normalizeStoredRuntimeProofResult(result, allowLegacy = false) {
  if (allowLegacy && result?.chainFile === LEGACY_RUNTIME_PROOF_CHAIN_NAME) {
    const normalized = {
      ...result,
      chainFile: runtimeProofChainFile(result.chainDigest),
    };
    assertSafeRuntimeProofResult(normalized);
    return { result: normalized, legacy: true };
  }
  assertSafeRuntimeProofResult(result);
  return { result, legacy: false };
}

function assertStoredArtifactPair(
  chainBytes,
  resultBytes,
  { allowLegacy = false } = {},
) {
  if ((chainBytes === null) !== (resultBytes === null)) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  if (chainBytes === null) return null;
  const chainSource = Buffer.from(chainBytes).toString("utf8");
  const resultSource = Buffer.from(resultBytes).toString("utf8");
  let result;
  try {
    result = JSON.parse(resultSource);
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const normalized = normalizeStoredRuntimeProofResult(result, allowLegacy);
  if (
    sha256(Buffer.from(chainSource, "utf8")) !==
    normalized.result.chainDigest
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return { chainSource, resultSource, ...normalized };
}

async function safePublicationDirectory(evidenceAnchor, journal, fsImpl) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  if (
    !exactKeys(journal, [
      "nonce",
      "ownerPid",
      "previous",
      "schema",
      "schemaVersion",
      "transactionDirectory",
    ]) ||
    journal.schema !== "agent-airlock/runtime-proof-publication" ||
    journal.schemaVersion !== 1 ||
    !Number.isInteger(journal.ownerPid) ||
    journal.ownerPid < 1 ||
    typeof journal.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(journal.nonce) ||
    journal.transactionDirectory !== PUBLICATION_DIRECTORY_PREFIX + journal.nonce ||
    !["absent", "present"].includes(journal.previous)
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const transactionDirectory = path.join(
    evidenceDirectory,
    journal.transactionDirectory,
  );
  const relative = path.relative(evidenceDirectory, transactionDirectory);
  if (
    relative !== journal.transactionDirectory ||
    !isStrictDescendant(evidenceDirectory, transactionDirectory)
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  const transactionAnchor = await openOwnerOnlyDirectory(
    transactionDirectory,
    { realParentDirectory: evidenceAnchor.realDirectory },
    fsImpl,
  );
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  return transactionAnchor;
}

async function ensureChainDirectory(evidenceAnchor, fsImpl, artifactIo) {
  return ensurePrivateDirectory(
    evidenceAnchor,
    RUNTIME_PROOF_CHAIN_DIRECTORY,
    fsImpl,
    artifactIo,
  );
}

async function ensureCapsuleDirectory(evidenceAnchor, fsImpl, artifactIo) {
  return ensurePrivateDirectory(
    evidenceAnchor,
    RUNTIME_PROOF_CAPSULE_DIRECTORY,
    fsImpl,
    artifactIo,
  );
}

async function assertExistingChainDirectory(evidenceAnchor, fsImpl) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  const chainDirectory = path.join(
    evidenceDirectory,
    RUNTIME_PROOF_CHAIN_DIRECTORY,
  );
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  const chainAnchor = await openOwnerOnlyDirectory(
    chainDirectory,
    { realParentDirectory: evidenceAnchor.realDirectory },
    fsImpl,
  );
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  return chainAnchor;
}

async function assertExistingCapsuleDirectory(evidenceAnchor, fsImpl) {
  const capsuleDirectory = path.join(
    evidenceAnchor.directoryPath,
    RUNTIME_PROOF_CAPSULE_DIRECTORY,
  );
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  const capsuleAnchor = await openOwnerOnlyDirectory(
    capsuleDirectory,
    { realParentDirectory: evidenceAnchor.realDirectory },
    fsImpl,
  );
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  return capsuleAnchor;
}

function chainPathForResult(evidenceDirectory, result) {
  assertSafeRuntimeProofResult(result);
  const candidate = path.resolve(evidenceDirectory, result.chainFile);
  if (
    path.relative(evidenceDirectory, candidate) !== result.chainFile ||
    path.dirname(candidate) !==
      path.join(evidenceDirectory, RUNTIME_PROOF_CHAIN_DIRECTORY) ||
    !isStrictDescendant(evidenceDirectory, candidate)
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return candidate;
}

async function assertChainFile(
  chainPath,
  resultBytes,
  chainAnchor,
  fsImpl,
  artifactIo,
) {
  const chainBytes = await readOwnerOnlyPhysicalFile(
    chainPath,
    {
      maximumBytes: MAXIMUM_CHAIN_BYTES,
      parentAnchor: chainAnchor,
    },
    fsImpl,
    artifactIo,
  );
  if (chainBytes === null) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return assertStoredArtifactPair(chainBytes, resultBytes);
}

async function readExistingImmutableChain(
  chainPath,
  chainAnchor,
  fsImpl,
  artifactIo,
) {
  return readOwnerOnlyPhysicalFile(
    chainPath,
    {
      maximumBytes: MAXIMUM_CHAIN_BYTES,
      parentAnchor: chainAnchor,
    },
    fsImpl,
    artifactIo,
  );
}

async function currentStoredArtifact(evidenceAnchor, fsImpl, artifactIo) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  const resultBytes = await readOwnerOnlyPhysicalFile(
    resultPath,
    {
      maximumBytes: MAXIMUM_RESULT_BYTES,
      parentAnchor: evidenceAnchor,
    },
    fsImpl,
    artifactIo,
  );
  if (resultBytes === null) return null;
  let result;
  try {
    result = JSON.parse(Buffer.from(resultBytes).toString("utf8"));
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  assertSafeRuntimeProofResult(result);
  const chainAnchor = await assertExistingChainDirectory(
    evidenceAnchor,
    fsImpl,
  );
  try {
    const chainPath = chainPathForResult(evidenceDirectory, result);
    if (path.dirname(chainPath) !== chainAnchor.directoryPath) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const stored = await assertChainFile(
      chainPath,
      resultBytes,
      chainAnchor,
      fsImpl,
      artifactIo,
    );
    await assertDirectoryAnchor(chainAnchor, fsImpl);
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    return {
      ...stored,
      chainPath,
      resultPath,
    };
  } finally {
    await closeDirectoryAnchor(chainAnchor);
  }
}

async function ensureCurrentImmutableCapsule(evidenceAnchor, fsImpl, artifactIo) {
  const stored = await currentStoredArtifact(evidenceAnchor, fsImpl, artifactIo);
  if (!stored) return null;
  const resultBytes = Buffer.from(stored.resultSource, "utf8");
  const capsuleAnchor = await ensureCapsuleDirectory(
    evidenceAnchor,
    fsImpl,
    artifactIo,
  );
  try {
    const capsulePath = path.join(
      evidenceAnchor.directoryPath,
      runtimeProofCapsuleFile(resultBytes),
    );
    if (path.dirname(capsulePath) !== capsuleAnchor.directoryPath) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await installImmutableFile(
      capsulePath,
      stored.resultSource,
      MAXIMUM_RESULT_BYTES,
      capsuleAnchor,
      fsImpl,
      artifactIo,
    );
    const immutableResult = await readOwnerOnlyPhysicalFile(
      capsulePath,
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: capsuleAnchor,
      },
      fsImpl,
      artifactIo,
    );
    if (immutableResult === null || !immutableResult.equals(resultBytes)) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(capsuleAnchor, fsImpl);
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    return { ...stored, resultPath: capsulePath };
  } finally {
    await closeDirectoryAnchor(capsuleAnchor);
  }
}

export async function resolveRuntimeProofArtifactPaths({
  artifactRoot,
  artifactIo = runRuntimeProofArtifactWorker,
  fsImpl = {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
  },
}) {
  const resolvedRoot = path.resolve(artifactRoot);
  const evidenceDirectory = path.join(
    resolvedRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const rootAnchor = await openOwnerOnlyDirectory(resolvedRoot, {}, fsImpl);
  let evidenceAnchor = null;
  let capsuleAnchor = null;
  try {
    evidenceAnchor = await openOwnerOnlyDirectory(
      evidenceDirectory,
      { realParentDirectory: rootAnchor.realDirectory },
      fsImpl,
    );
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    const stored = await currentStoredArtifact(
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    if (!stored) throw new RuntimeProofError("artifact-write-failed");
    capsuleAnchor = await assertExistingCapsuleDirectory(
      evidenceAnchor,
      fsImpl,
    );
    const resultBytes = Buffer.from(stored.resultSource, "utf8");
    const capsulePath = path.join(
      evidenceDirectory,
      runtimeProofCapsuleFile(resultBytes),
    );
    if (path.dirname(capsulePath) !== capsuleAnchor.directoryPath) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const immutableResult = await readOwnerOnlyPhysicalFile(
      capsulePath,
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: capsuleAnchor,
      },
      fsImpl,
      artifactIo,
    );
    if (immutableResult === null || !immutableResult.equals(resultBytes)) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(capsuleAnchor, fsImpl);
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    return {
      resultPath: capsulePath,
      chainPath: stored.chainPath,
    };
  } finally {
    await closeDirectoryAnchor(capsuleAnchor);
    await closeDirectoryAnchor(evidenceAnchor);
    await closeDirectoryAnchor(rootAnchor);
  }
}

async function recoverLegacyPublicationJournal(
  evidenceAnchor,
  fsImpl,
  artifactIo,
) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  const journalPath = path.join(evidenceDirectory, PUBLICATION_JOURNAL_NAME);
  const journalBytes = await readOwnerOnlyPhysicalFile(
    journalPath,
    {
      maximumBytes: MAXIMUM_RESULT_BYTES,
      parentAnchor: evidenceAnchor,
    },
    fsImpl,
    artifactIo,
  );
  if (journalBytes === null) return false;
  let journal;
  try {
    journal = JSON.parse(journalBytes.toString("utf8"));
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const transactionAnchor = await safePublicationDirectory(
    evidenceAnchor,
    journal,
    fsImpl,
  );
  const transactionDirectory = transactionAnchor.directoryPath;
  const legacyChainPath = path.join(
    evidenceDirectory,
    LEGACY_RUNTIME_PROOF_CHAIN_NAME,
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  let transactionClosed = false;
  try {
    if (journal.previous === "present") {
      const [previousChain, previousResult] = await Promise.all([
        readOwnerOnlyPhysicalFile(
          path.join(transactionDirectory, "previous.chain.json"),
          {
            maximumBytes: MAXIMUM_CHAIN_BYTES,
            parentAnchor: transactionAnchor,
          },
          fsImpl,
          artifactIo,
        ),
        readOwnerOnlyPhysicalFile(
          path.join(transactionDirectory, "previous.result.json"),
          {
            maximumBytes: MAXIMUM_RESULT_BYTES,
            parentAnchor: transactionAnchor,
          },
          fsImpl,
          artifactIo,
        ),
      ]);
      if (previousChain === null || previousResult === null) {
        throw new RuntimeProofError("artifact-write-failed");
      }
      assertStoredArtifactPair(previousChain, previousResult, {
        allowLegacy: true,
      });
      await atomicWrite(
        legacyChainPath,
        previousChain,
        fsImpl,
        evidenceAnchor,
        () => {},
        () => {},
        artifactIo,
      );
      await atomicWrite(
        resultPath,
        previousResult,
        fsImpl,
        evidenceAnchor,
        () => {},
        () => {},
        artifactIo,
      );
    } else {
      await removeOwnerOnlyLeaf(
        legacyChainPath,
        MAXIMUM_CHAIN_BYTES,
        evidenceAnchor,
        fsImpl,
        artifactIo,
      );
      await removeOwnerOnlyLeaf(
        resultPath,
        MAXIMUM_RESULT_BYTES,
        evidenceAnchor,
        fsImpl,
        artifactIo,
      );
    }
    await removeOwnerOnlyLeaf(
      path.join(transactionDirectory, "previous.chain.json"),
      MAXIMUM_CHAIN_BYTES,
      transactionAnchor,
      fsImpl,
      artifactIo,
    );
    await removeOwnerOnlyLeaf(
      path.join(transactionDirectory, "previous.result.json"),
      MAXIMUM_RESULT_BYTES,
      transactionAnchor,
      fsImpl,
      artifactIo,
    );
    await assertDirectoryAnchor(transactionAnchor, fsImpl);
    await removeOwnerOnlyLeaf(
      journalPath,
      MAXIMUM_RESULT_BYTES,
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    await closeDirectoryAnchor(transactionAnchor);
    transactionClosed = true;
    await removeEmptyPrivateDirectory(
      transactionDirectory,
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    return true;
  } finally {
    if (!transactionClosed) await closeDirectoryAnchor(transactionAnchor);
  }
}

async function migrateLegacyArtifactPair(evidenceAnchor, fsImpl, artifactIo) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  const legacyChainPath = path.join(
    evidenceDirectory,
    LEGACY_RUNTIME_PROOF_CHAIN_NAME,
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  const [legacyChain, resultBytes] = await Promise.all([
    readOwnerOnlyPhysicalFile(
      legacyChainPath,
      {
        maximumBytes: MAXIMUM_CHAIN_BYTES,
        parentAnchor: evidenceAnchor,
      },
      fsImpl,
      artifactIo,
    ),
    readOwnerOnlyPhysicalFile(
      resultPath,
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: evidenceAnchor,
      },
      fsImpl,
      artifactIo,
    ),
  ]);
  if (resultBytes === null) {
    if (legacyChain !== null) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    return false;
  }
  let storedResult;
  try {
    storedResult = JSON.parse(Buffer.from(resultBytes).toString("utf8"));
  } catch {
    throw new RuntimeProofError("artifact-write-failed");
  }
  if (storedResult?.chainFile !== LEGACY_RUNTIME_PROOF_CHAIN_NAME) {
    if (legacyChain !== null) {
      await currentStoredArtifact(evidenceAnchor, fsImpl, artifactIo);
      await removeOwnerOnlyLeaf(
        legacyChainPath,
        MAXIMUM_CHAIN_BYTES,
        evidenceAnchor,
        fsImpl,
        artifactIo,
      );
      return true;
    }
    return false;
  }
  const legacyPair = assertStoredArtifactPair(legacyChain, resultBytes, {
    allowLegacy: true,
  });
  const chainAnchor = await ensureChainDirectory(evidenceAnchor, fsImpl, artifactIo);
  try {
    const chainPath = path.join(
      chainAnchor.directoryPath,
      path.basename(legacyPair.result.chainFile),
    );
    let existingChain = await readExistingImmutableChain(
      chainPath,
      chainAnchor,
      fsImpl,
      artifactIo,
    );
    if (existingChain === null) {
      await installImmutableFile(
        chainPath,
        legacyPair.chainSource,
        MAXIMUM_CHAIN_BYTES,
        chainAnchor,
        fsImpl,
        artifactIo,
      );
      existingChain = await readExistingImmutableChain(
        chainPath,
        chainAnchor,
        fsImpl,
        artifactIo,
      );
    }
    if (
      existingChain === null ||
      sha256(existingChain) !== legacyPair.result.chainDigest ||
      Buffer.from(existingChain).toString("utf8") !== legacyPair.chainSource
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    const normalizedResultSource =
      assertSafeRuntimeProofResult(legacyPair.result) + "\n";
    assertStoredArtifactPair(
      existingChain,
      Buffer.from(normalizedResultSource, "utf8"),
    );
    await atomicWrite(
      resultPath,
      normalizedResultSource,
      fsImpl,
      evidenceAnchor,
      () => {},
      () => {},
      artifactIo,
    );
    await currentStoredArtifact(evidenceAnchor, fsImpl, artifactIo);
    await removeOwnerOnlyLeaf(
      legacyChainPath,
      MAXIMUM_CHAIN_BYTES,
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    return true;
  } finally {
    await closeDirectoryAnchor(chainAnchor);
  }
}

async function recoverRuntimeProofArtifactPublicationWithAnchor(
  evidenceAnchor,
  fsImpl,
  artifactIo,
) {
  const evidenceDirectory = evidenceAnchor.directoryPath;
  const legacyLockPath = path.join(
    evidenceDirectory,
    LEGACY_PUBLICATION_LOCK_NAME,
  );
  const legacyLock = await readOwnerOnlyPhysicalFile(
    legacyLockPath,
    {
      maximumBytes: MAXIMUM_RESULT_BYTES,
      parentAnchor: evidenceAnchor,
    },
    fsImpl,
    artifactIo,
  );
  if (legacyLock !== null) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  let recovered = await recoverLegacyPublicationJournal(
    evidenceAnchor,
    fsImpl,
    artifactIo,
  );
  recovered =
    (await migrateLegacyArtifactPair(evidenceAnchor, fsImpl, artifactIo)) ||
    recovered;
  await ensureCurrentImmutableCapsule(evidenceAnchor, fsImpl, artifactIo);
  await assertDirectoryAnchor(evidenceAnchor, fsImpl);
  return recovered;
}

export async function recoverRuntimeProofArtifactPublication({
  artifactRoot,
  artifactIo = runRuntimeProofArtifactWorker,
  fsImpl = {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
  },
}) {
  const resolvedRoot = path.resolve(artifactRoot);
  const evidenceDirectory = path.join(
    resolvedRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const evidenceStatus = await fsImpl.lstat(evidenceDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!evidenceStatus) return false;
  const rootAnchor = await openOwnerOnlyDirectory(resolvedRoot, {}, fsImpl);
  let evidenceAnchor = null;
  try {
    evidenceAnchor = await openOwnerOnlyDirectory(
      evidenceDirectory,
      { realParentDirectory: rootAnchor.realDirectory },
      fsImpl,
    );
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    const recovered = await recoverRuntimeProofArtifactPublicationWithAnchor(
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    return recovered;
  } finally {
    await closeDirectoryAnchor(evidenceAnchor);
    await closeDirectoryAnchor(rootAnchor);
  }
}

export async function writeRuntimeProofArtifacts({
  artifactRoot,
  chainSource,
  result,
  beforeCommit = () => {},
  afterCommit = () => {},
  signal = beforeCommit?.signal,
  recordingDeadlineAt = Number.MAX_SAFE_INTEGER,
  artifactIo = runRuntimeProofArtifactWorker,
  fsImpl = {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
  },
}) {
  assertSafeRuntimeProofResult(result);
  if (
    typeof chainSource !== "string" ||
    Buffer.byteLength(chainSource, "utf8") < 1 ||
    Buffer.byteLength(chainSource, "utf8") > MAXIMUM_CHAIN_BYTES ||
    sha256(Buffer.from(chainSource, "utf8")) !== result.chainDigest
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  const evidenceDirectory = path.join(
    path.resolve(artifactRoot),
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  const rootAnchor = await openOwnerOnlyDirectory(
    path.resolve(artifactRoot),
    {},
    fsImpl,
  );
  let evidenceAnchor = null;
  let chainAnchor = null;
  let capsuleAnchor = null;
  try {
    evidenceAnchor = await ensurePrivateDirectory(
      rootAnchor,
      RUNTIME_PROOF_EVIDENCE_DIRECTORY,
      fsImpl,
      artifactIo,
    );
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    await recoverRuntimeProofArtifactPublicationWithAnchor(
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    chainAnchor = await ensureChainDirectory(evidenceAnchor, fsImpl, artifactIo);
    capsuleAnchor = await ensureCapsuleDirectory(
      evidenceAnchor,
      fsImpl,
      artifactIo,
    );
    await currentStoredArtifact(evidenceAnchor, fsImpl, artifactIo);
    const chainPath = chainPathForResult(evidenceDirectory, result);
    if (path.dirname(chainPath) !== chainAnchor.directoryPath) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    let existingChain = await readExistingImmutableChain(
      chainPath,
      chainAnchor,
      fsImpl,
      artifactIo,
    );
    if (existingChain === null) {
      await installImmutableFile(
        chainPath,
        chainSource,
        MAXIMUM_CHAIN_BYTES,
        chainAnchor,
        fsImpl,
        artifactIo,
      );
      existingChain = await readExistingImmutableChain(
        chainPath,
        chainAnchor,
        fsImpl,
        artifactIo,
      );
    }
    if (
      existingChain === null ||
      sha256(existingChain) !== result.chainDigest ||
      Buffer.from(existingChain).toString("utf8") !== chainSource
    ) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(chainAnchor, fsImpl);
    const resultSource = assertSafeRuntimeProofResult(result) + "\n";
    const resultBytes = Buffer.from(resultSource, "utf8");
    const capsulePath = path.join(
      evidenceDirectory,
      runtimeProofCapsuleFile(resultBytes),
    );
    if (path.dirname(capsulePath) !== capsuleAnchor.directoryPath) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await installImmutableFile(
      capsulePath,
      resultSource,
      MAXIMUM_RESULT_BYTES,
      capsuleAnchor,
      fsImpl,
      artifactIo,
    );
    const immutableResult = await readOwnerOnlyPhysicalFile(
      capsulePath,
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: capsuleAnchor,
      },
      fsImpl,
      artifactIo,
    );
    if (immutableResult === null || !immutableResult.equals(resultBytes)) {
      throw new RuntimeProofError("artifact-write-failed");
    }
    await assertDirectoryAnchor(capsuleAnchor, fsImpl);
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    await atomicWrite(
      resultPath,
      resultSource,
      fsImpl,
      evidenceAnchor,
      beforeCommit,
      afterCommit,
      artifactIo,
      signal,
      recordingDeadlineAt,
    );
    await assertDirectoryAnchor(chainAnchor, fsImpl);
    await assertDirectoryAnchor(capsuleAnchor, fsImpl);
    await assertDirectoryAnchor(evidenceAnchor, fsImpl);
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    return { chainPath, resultPath };
  } catch (error) {
    throw error instanceof RuntimeProofError
      ? error
      : new RuntimeProofError("artifact-write-failed");
  } finally {
    await closeDirectoryAnchor(capsuleAnchor);
    await closeDirectoryAnchor(chainAnchor);
    await closeDirectoryAnchor(evidenceAnchor);
    await closeDirectoryAnchor(rootAnchor);
  }
}

export function safeRuntimeProofFailure(error) {
  const failureClass =
    error instanceof RuntimeProofError && FAILURE_MESSAGES[error.failureClass]
      ? error.failureClass
      : "startup-failed";
  return {
    schema: RUNTIME_PROOF_RESULT_SCHEMA,
    schemaVersion: 1,
    outcome: "failed",
    failureClass,
    message: FAILURE_MESSAGES[failureClass],
  };
}

export async function finalizeRuntimeProofPublication({
  releaseOwnership,
  publishArtifacts,
  signal,
  recordingDeadlineAt = Number.POSITIVE_INFINITY,
  now = Date.now,
}) {
  let committed = false;
  let cleanupIncomplete = false;
  let primaryError = null;
  let commitBoundaryReached = false;
  let commitDeadlineTimer = null;
  const commitDeadlineController = new AbortController();
  const commitSignal = signal
    ? AbortSignal.any([signal, commitDeadlineController.signal])
    : commitDeadlineController.signal;
  const beforeCommit = () => {
    const commitStartedAt = now();
    assertRuntimeProofRecordingWindow({
      recordingDeadlineAt,
      now: () => commitStartedAt,
      signal,
    });
    if (Number.isFinite(recordingDeadlineAt)) {
      commitDeadlineTimer = setTimeout(() => {
        commitDeadlineController.abort(
          new RuntimeProofError("recording-timeout"),
        );
      }, Math.max(0, recordingDeadlineAt - commitStartedAt));
    }
    commitBoundaryReached = true;
  };
  Object.defineProperty(beforeCommit, "signal", {
    value: commitSignal,
  });
  try {
    assertRuntimeProofRecordingWindow({
      recordingDeadlineAt,
      now,
      signal,
    });
    await publishArtifacts({
      beforeCommit,
      afterCommit: () => {
        committed = true;
      },
    });
    if (!commitBoundaryReached || !committed) {
      throw new RuntimeProofError("artifact-write-failed");
    }
  } catch (error) {
    if (committed) {
      cleanupIncomplete = true;
    } else {
      primaryError =
        error instanceof RuntimeProofError
          ? error
          : new RuntimeProofError("artifact-write-failed");
    }
  } finally {
    if (commitDeadlineTimer !== null) clearTimeout(commitDeadlineTimer);
  }
  try {
    await releaseOwnership();
  } catch (error) {
    if (committed) {
      cleanupIncomplete = true;
    } else {
      primaryError ??=
        error instanceof RuntimeProofError
          ? error
          : new RuntimeProofError("cleanup-failed");
    }
  }
  if (primaryError) throw primaryError;
  return { committed, cleanupIncomplete };
}

export function classifyRuntimeProofLauncherFailure(transcript) {
  if (/Docker|Podman|Colima|container engine|daemon/i.test(transcript ?? "")) {
    return new RuntimeProofError("runtime-unavailable");
  }
  if (/build.*failed|Runtime image/i.test(transcript ?? "")) {
    return new RuntimeProofError("image-build-failed");
  }
  return new RuntimeProofError("startup-failed");
}

export function offlineVerifierNetworkAction({ guardArmed }) {
  return guardArmed === true ? "block" : "continue";
}

const RUNTIME_PROOF_DESKTOP_VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
});
const RUNTIME_PROOF_MOBILE_VIEWPORT = Object.freeze({
  width: 390,
  height: 844,
});

function runtimeProofRunIds(runs) {
  const runIds = {
    safeRunId: runs?.promotion?.id,
    unsafeRunId: runs?.quarantine?.id,
    repairedRunId: runs?.repair?.id,
  };
  if (
    !Object.values(runIds).every(safeIdentifier) ||
    new Set(Object.values(runIds)).size !== 3
  ) {
    throw new RuntimeProofError("run-set-invalid");
  }
  return runIds;
}

export function runtimeProofReplayUrl({ baseUrl, runs }) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RuntimeProofError("browser-failed");
  }
  const { safeRunId, unsafeRunId, repairedRunId } = runtimeProofRunIds(runs);
  url.searchParams.set("recording", "1");
  url.searchParams.set("recordingSafeRunId", safeRunId);
  url.searchParams.set("recordingUnsafeRunId", unsafeRunId);
  url.searchParams.set("recordingRepairRunId", repairedRunId);
  return url.toString();
}

export function assertMatchingRuntimeProofDecisionChainSources(
  primarySource,
  replaySource,
) {
  if (
    typeof primarySource !== "string" ||
    primarySource.length === 0 ||
    replaySource !== primarySource
  ) {
    throw new RuntimeProofError("chain-invalid");
  }
  return primarySource;
}

function requiredValidationCounts(run) {
  const required = run?.transaction?.validations?.filter(
    (validation) => validation?.required === true,
  );
  if (!Array.isArray(required) || required.length === 0) {
    throw new RuntimeProofError("run-set-invalid");
  }
  return {
    failed: required.filter((validation) => validation?.status !== "passed")
      .length,
    passed: required.filter((validation) => validation?.status === "passed")
      .length,
    total: required.length,
  };
}

function recordingHashPrefix(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeProofError("run-set-invalid");
  }
  return (value.startsWith("sha256:") ? value.slice(7) : value).slice(0, 8);
}

function runtimeProofRecordingExpectation(runs) {
  const runIds = runtimeProofRunIds(runs);
  const promotion = runs.promotion;
  const quarantine = runs.quarantine;
  const repair = runs.repair;
  const promotionValidations = requiredValidationCounts(promotion);
  const quarantineValidations = requiredValidationCounts(quarantine);
  const repairValidations = requiredValidationCounts(repair);
  return {
    runIds,
    headers: [
      `01 · SAFE ROOT · RUN ${runIds.safeRunId.slice(0, 8)}`,
      `02 · UNSAFE FUTURE · RUN ${runIds.unsafeRunId.slice(0, 8)}`,
      `03 · REPAIRED CHILD · RUN ${runIds.repairedRunId.slice(0, 8)}`,
      "04 · PORTABLE TRUST",
    ],
    promotion: {
      runId: runIds.safeRunId,
      validations: `${promotionValidations.passed}/${promotionValidations.total}`,
      resourcesAndEffects: `${promotion.transaction.resources.length}/4 + ${promotion.transaction.externalActions.deliveredCount}`,
      fingerprint: `${recordingHashPrefix(promotion.transaction.canonicalContentHashBefore)} → ${recordingHashPrefix(promotion.transaction.canonicalContentHashAfter)}`,
    },
    quarantine: {
      runId: runIds.unsafeRunId,
      failedAndResources: `${quarantineValidations.failed} failed · ${quarantine.transaction.resources.length}/4 quarantined`,
      fingerprint: `${recordingHashPrefix(quarantine.transaction.canonicalContentHashBefore)} = ${recordingHashPrefix(quarantine.transaction.canonicalContentHashAfter)}`,
      effects: String(quarantine.transaction.externalActions.deliveredCount),
    },
    repair: {
      runId: runIds.repairedRunId,
      validationsAndDepth: `${repairValidations.passed}/${repairValidations.total} passed · Depth ${repair.transaction.lineage.depth}`,
      parent: `required Validations · parent ${repair.transaction.lineage.parentRunId.slice(0, 8)}`,
      resourcesAndEffects: `${repair.transaction.resources.length}/4 + ${repair.transaction.externalActions.deliveredCount}`,
      fingerprint: `${recordingHashPrefix(repair.transaction.canonicalContentHashBefore)} → ${recordingHashPrefix(repair.transaction.canonicalContentHashAfter)}`,
    },
  };
}

async function createFailClosedVerifierGuard(context) {
  let guardArmed = false;
  let blockedRequestCount = 0;
  const recordViolation = () => {
    blockedRequestCount += 1;
  };
  const action = () =>
    offlineVerifierNetworkAction({ guardArmed });

  await context.route("**/*", async (route) => {
    if (action() === "continue") {
      await route.continue();
      return;
    }
    recordViolation();
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", async (webSocket) => {
    if (action() === "block") {
      recordViolation();
      await webSocket.close({ code: 1008, reason: "offline verifier" });
      return;
    }
    const server = webSocket.connectToServer();
    webSocket.onMessage((message) => {
      if (action() === "continue") {
        server.send(message);
      } else {
        recordViolation();
      }
    });
    server.onMessage((message) => {
      if (action() === "continue") {
        webSocket.send(message);
      } else {
        recordViolation();
      }
    });
  });

  return {
    arm() {
      guardArmed = true;
    },
    assertStayedLocal() {
      if (blockedRequestCount !== 0) {
        throw new RuntimeProofError("verifier-invalid");
      }
    },
    get armed() {
      return guardArmed;
    },
  };
}

function captureDecisionChainResponses(page, onCapture) {
  page.on("response", async (response) => {
    try {
      if (
        response.request().method() !== "POST" ||
        !/\/api\/runs\/[^/]+\/portable-receipt(?:\?|$)/.test(response.url()) ||
        !response.ok()
      ) {
        return;
      }
      const payload = await response.json();
      if (
        payload?.decisionChain?.schema ===
          "agent-airlock/portable-decision-chain" &&
        Array.isArray(payload.decisionChain.packets) &&
        payload.decisionChain.packets.length === 2
      ) {
        onCapture(JSON.stringify(payload.decisionChain));
      }
    } catch {
      // The authoritative Node verifier handles a missing or malformed capture.
    }
  });
}

async function waitForDecisionChainSource({ page, readSource, signal }) {
  const deadline = Date.now() + 15_000;
  while (!readSource() && Date.now() <= deadline) {
    abortIfNeeded(signal);
    await page.waitForTimeout(25);
  }
  abortIfNeeded(signal);
  const source = readSource();
  if (!source) throw new RuntimeProofError("chain-invalid");
  return source;
}

async function expectExactVisibleText(locator, text) {
  const match = locator.getByText(text, { exact: true });
  if ((await match.count()) !== 1) {
    throw new RuntimeProofError("viewport-invalid");
  }
  await match.waitFor({ state: "visible", timeout: 5_000 });
  return match;
}

async function assertInsideRecordingViewport(
  locator,
  viewport,
  { scroll = false } = {},
) {
  if (scroll) await locator.scrollIntoViewIfNeeded();
  const isInside = await locator.evaluate((element, expectedViewport) => {
    const rect = element.getBoundingClientRect();
    const dialog = element.closest(".receipt-verifier")?.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const details = element.closest("details");
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      (!details || details.open);
    return (
      visible &&
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= expectedViewport.width &&
      rect.bottom <= expectedViewport.height &&
      (!dialog ||
        (rect.left >= dialog.left &&
          rect.top >= dialog.top &&
          rect.right <= dialog.right &&
          rect.bottom <= dialog.bottom))
    );
  }, viewport);
  if (!isInside) throw new RuntimeProofError("viewport-invalid");
}

async function assertDynamicRecordingBoard({ page, runs, viewport }) {
  const expectation = runtimeProofRecordingExpectation(runs);
  const board = page.getByRole("region", { name: "Verified Outcome Brief" });
  await board.waitFor({ state: "visible", timeout: 15_000 });
  const recordingFields = [];
  recordingFields.push(await expectExactVisibleText(board, "Release proven safe"));
  const articles = board.locator("article[data-outcome]");
  if ((await articles.count()) !== 4) {
    throw new RuntimeProofError("viewport-invalid");
  }
  for (const outcome of ["promoted", "quarantined", "repaired", "verified"]) {
    if ((await board.locator(`article[data-outcome="${outcome}"]`).count()) !== 1) {
      throw new RuntimeProofError("viewport-invalid");
    }
  }
  const headers = await board
    .locator(".recording-outcome-grid article > header > span")
    .allTextContents();
  if (
    headers.length !== expectation.headers.length ||
    headers.some(
      (header, index) =>
        header.replace(/\s+/g, " ").trim() !== expectation.headers[index],
    )
  ) {
    throw new RuntimeProofError("viewport-invalid");
  }

  const promoted = board.locator('article[data-outcome="promoted"]');
  recordingFields.push(
    await expectExactVisibleText(promoted, "Promotion"),
    await expectExactVisibleText(promoted, expectation.promotion.validations),
    await expectExactVisibleText(
      promoted,
      expectation.promotion.resourcesAndEffects,
    ),
    await expectExactVisibleText(promoted, expectation.promotion.fingerprint),
    await expectExactVisibleText(promoted, "required Validations passed"),
    await expectExactVisibleText(
      promoted,
      "resources promoted + post-Promotion effect",
    ),
    await expectExactVisibleText(promoted, "Canonical fingerprint advanced"),
  );
  const quarantined = board.locator('article[data-outcome="quarantined"]');
  recordingFields.push(
    await expectExactVisibleText(quarantined, "Quarantine"),
    await expectExactVisibleText(
      quarantined,
      expectation.quarantine.failedAndResources,
    ),
    await expectExactVisibleText(
      quarantined,
      expectation.quarantine.fingerprint,
    ),
    await expectExactVisibleText(quarantined, expectation.quarantine.effects),
    await expectExactVisibleText(
      quarantined,
      "required Validation blocked every resource",
    ),
    await expectExactVisibleText(
      quarantined,
      "identical Canonical fingerprint",
    ),
    await expectExactVisibleText(quarantined, "effects delivered"),
  );
  const repaired = board.locator('article[data-outcome="repaired"]');
  recordingFields.push(
    await expectExactVisibleText(repaired, "Promotion"),
    await expectExactVisibleText(
      repaired,
      expectation.repair.validationsAndDepth,
    ),
    await expectExactVisibleText(repaired, expectation.repair.parent),
    await expectExactVisibleText(
      repaired,
      expectation.repair.resourcesAndEffects,
    ),
    await expectExactVisibleText(repaired, expectation.repair.fingerprint),
    await expectExactVisibleText(
      repaired,
      "resources promoted + fresh effect",
    ),
    await expectExactVisibleText(repaired, "Canonical fingerprint advanced"),
  );
  const verified = board.locator('article[data-outcome="verified"]');
  recordingFields.push(
    await expectExactVisibleText(verified, "Verified"),
    await expectExactVisibleText(verified, "2"),
    await expectExactVisibleText(verified, "signed decisions linked"),
    await expectExactVisibleText(
      verified,
      "browser cryptographic check passed",
    ),
    await expectExactVisibleText(
      verified,
      "parent links and state handoffs verified",
    ),
  );

  for (const runId of [
    expectation.promotion.runId,
    expectation.quarantine.runId,
    expectation.repair.runId,
  ]) {
    const exactRun = board.locator(`[data-recording-run-id="${runId}"]`);
    if (
      (await exactRun.count()) !== 1 ||
      (await exactRun.getByText(`Run ${runId}`, { exact: true }).count()) !== 1
    ) {
      throw new RuntimeProofError("viewport-invalid");
    }
    recordingFields.push(exactRun);
  }
  const exactParent = repaired.locator(
    `[data-recording-parent-id="${expectation.quarantine.runId}"]`,
  );
  if (
    (await exactParent.count()) !== 1 ||
    (await exactParent
      .getByText(`Parent ${expectation.quarantine.runId}`, { exact: true })
      .count()) !== 1
  ) {
    throw new RuntimeProofError("viewport-invalid");
  }
  recordingFields.push(exactParent);

  const documentWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  if (documentWidth > viewport.width) {
    throw new RuntimeProofError("viewport-invalid");
  }
  const inspectButton = board.getByRole("button", {
    name: "Inspect in zero-upload verifier",
    exact: true,
  });
  if ((await inspectButton.count()) !== 1 || !(await inspectButton.isEnabled())) {
    throw new RuntimeProofError("viewport-invalid");
  }
  recordingFields.push(inspectButton);
  const isMobile = viewport.width === RUNTIME_PROOF_MOBILE_VIEWPORT.width;
  const headerFields = board.locator(
    ".recording-outcome-grid article > header > span",
  );
  for (let index = 0; index < expectation.headers.length; index += 1) {
    recordingFields.push(headerFields.nth(index));
  }
  for (const field of recordingFields) {
    await assertInsideRecordingViewport(field, viewport, { scroll: isMobile });
  }
  return { board, inspectButton };
}

async function assertVerifierRecordingSummary({
  page,
  verifier,
  viewport,
  runs,
  scroll = false,
}) {
  const expectation = runtimeProofRecordingExpectation(runs);
  const summary = verifier.locator('[aria-label="Verified chain summary"]');
  await summary.waitFor({ state: "visible", timeout: 15_000 });
  if (!scroll) {
    const scrollTop = await verifier.evaluate((element) => element.scrollTop);
    if (scrollTop !== 0) throw new RuntimeProofError("viewport-invalid");
  }
  const boundary = verifier.getByText(/0 API calls · 0 uploads/);
  const signatures = summary
    .locator('[data-recording-proof="signatures"]')
    .getByText("2/2 valid", { exact: true });
  const parentDigest = summary.locator(
    '[data-recording-proof="parent-digest"]',
  );
  const stateHandoff = summary.locator(
    '[data-recording-proof="state-handoff"] code',
  );
  const exactLineage = summary
    .locator('[data-recording-proof="exact-lineage"]')
    .getByText(
      `Parent ${expectation.quarantine.runId} → Repair ${expectation.repair.runId}`,
      { exact: true },
    );
  const verdict = verifier.getByText("Cryptographic proof valid", {
    exact: true,
  });
  if (
    (await boundary.count()) !== 1 ||
    (await signatures.count()) !== 1 ||
    (await parentDigest.getByText("PASS", { exact: true }).count()) !== 1 ||
    (await stateHandoff.count()) !== 1 ||
    (await exactLineage.count()) !== 1 ||
    (await verdict.count()) !== 1
  ) {
    throw new RuntimeProofError("viewport-invalid");
  }
  const handoffText = (await stateHandoff.textContent())?.trim() ?? "";
  const handoffParts = handoffText.split(/\s*=\s*/);
  if (
    handoffParts.length !== 2 ||
    !/^[a-f0-9]{12}$/.test(handoffParts[0] ?? "") ||
    handoffParts[0] !== handoffParts[1]
  ) {
    throw new RuntimeProofError("verifier-invalid");
  }
  for (const field of [
    boundary,
    signatures,
    parentDigest,
    stateHandoff,
    exactLineage,
    verdict,
  ]) {
    await assertInsideRecordingViewport(field, viewport, { scroll });
  }
  const [dialogMetrics, documentWidth] = await Promise.all([
    verifier.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
    page.evaluate(() => document.documentElement.scrollWidth),
  ]);
  if (
    dialogMetrics.scrollWidth > dialogMetrics.clientWidth ||
    documentWidth > viewport.width
  ) {
    throw new RuntimeProofError("viewport-invalid");
  }
}

export async function createPlaywrightRuntimeProofDriver({
  baseUrl,
  headless = true,
  now = Date.now,
  presentationPacing = !headless,
  presentationWaitImpl = abortableTimeout,
  recordingDeadlineAt = now() + RUNTIME_PROOF_RECORDING_BUDGET_MS,
  signal,
}) {
  const { chromium } = await import("@playwright/test");
  let browser;
  let mobileBrowser;
  let mobileGuard = null;
  let detachBrowserAbort = () => {};
  try {
    const presentation = createRuntimeProofPresentationPacer({
      enabled: presentationPacing && !headless,
      now,
      recordingDeadlineAt,
      signal,
      waitImpl: presentationWaitImpl,
    });
    browser = await chromium.launch({ channel: "chrome", headless });
    const closeBrowserOnAbort = () => {
      void Promise.allSettled(
        [mobileBrowser, browser]
          .filter(Boolean)
          .map((ownedBrowser) => ownedBrowser.close()),
      );
    };
    signal?.addEventListener("abort", closeBrowserOnAbort, { once: true });
    detachBrowserAbort = () => {
      signal?.removeEventListener("abort", closeBrowserOnAbort);
    };
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: RUNTIME_PROOF_DESKTOP_VIEWPORT,
    });
    const primaryGuard = await createFailClosedVerifierGuard(context);
    let invocationCount = 0;
    let capturedChainSource = null;
    let recordingRuns = null;
    const page = await context.newPage();
    captureDecisionChainResponses(page, (source) => {
      capturedChainSource = source;
    });
    let mobileChainSource = null;

    async function assertMobileReplay(runs) {
      if (mobileBrowser) throw new RuntimeProofError("viewport-invalid");
      mobileBrowser = await chromium.launch({ channel: "chrome", headless: true });
      const mobileContext = await mobileBrowser.newContext({
        serviceWorkers: "block",
        viewport: RUNTIME_PROOF_MOBILE_VIEWPORT,
      });
      mobileGuard = await createFailClosedVerifierGuard(mobileContext);
      const mobilePage = await mobileContext.newPage();
      captureDecisionChainResponses(mobilePage, (source) => {
        mobileChainSource = source;
      });
      await mobilePage.goto(runtimeProofReplayUrl({ baseUrl, runs }), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const { board, inspectButton } = await assertDynamicRecordingBoard({
        page: mobilePage,
        runs,
        viewport: RUNTIME_PROOF_MOBILE_VIEWPORT,
      });
      await inspectButton.scrollIntoViewIfNeeded();
      const buttonBox = await inspectButton.boundingBox();
      const cardBoxes = await board
        .locator("article[data-outcome]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().left),
        );
      if (
        !buttonBox ||
        buttonBox.x < 0 ||
        buttonBox.x + buttonBox.width > RUNTIME_PROOF_MOBILE_VIEWPORT.width ||
        buttonBox.height < 44 ||
        cardBoxes.length !== 4 ||
        cardBoxes.some((left) => Math.abs(left - cardBoxes[0]) > 0.5)
      ) {
        throw new RuntimeProofError("viewport-invalid");
      }
      const [primarySource, replaySource] = await Promise.all([
        waitForDecisionChainSource({
          page,
          readSource: () => capturedChainSource,
          signal,
        }),
        waitForDecisionChainSource({
          page: mobilePage,
          readSource: () => mobileChainSource,
          signal,
        }),
      ]);
      assertMatchingRuntimeProofDecisionChainSources(
        primarySource,
        replaySource,
      );

      mobileGuard.arm();
      await inspectButton.click();
      const verifier = mobilePage.getByRole("dialog", {
        name: "Verify trust without trusting this server",
      });
      await verifier
        .getByText("Cryptographic proof valid", { exact: true })
        .waitFor({ state: "visible", timeout: 15_000 });
      await verifier
        .getByText("2 signed decisions linked", { exact: true })
        .waitFor({ state: "visible", timeout: 15_000 });
      await verifier
        .getByText("Every receipt, parent link, and state handoff agrees.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 15_000 });
      await assertVerifierRecordingSummary({
        page: mobilePage,
        verifier,
        viewport: RUNTIME_PROOF_MOBILE_VIEWPORT,
        runs,
        scroll: true,
      });
      const dialogBox = await verifier.boundingBox();
      const dialogScrollWidth = await verifier.evaluate(
        (element) => element.scrollWidth,
      );
      const dialogClientWidth = await verifier.evaluate(
        (element) => element.clientWidth,
      );
      const documentWidth = await mobilePage.evaluate(
        () => document.documentElement.scrollWidth,
      );
      if (
        !dialogBox ||
        dialogBox.x < 0 ||
        dialogBox.x + dialogBox.width > RUNTIME_PROOF_MOBILE_VIEWPORT.width ||
        documentWidth > RUNTIME_PROOF_MOBILE_VIEWPORT.width ||
        dialogScrollWidth > dialogClientWidth
      ) {
        throw new RuntimeProofError("viewport-invalid");
      }
      await mobilePage.waitForTimeout(100);
      mobileGuard.assertStayedLocal();
    }

    return {
      recordingDeadlineAt,
      async invokeCompleteSafetyLoop() {
        if (invocationCount !== 0) throw new RuntimeProofError("browser-failed");
        invocationCount += 1;
        try {
          const url = new URL(baseUrl);
          url.searchParams.set("recording", "1");
          await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          const runtimeStatus = page.getByRole("status").filter({
            hasText: "REAL RUNTIME PROOF",
          });
          await runtimeStatus.waitFor({ state: "visible", timeout: 30_000 });
          await runtimeStatus
            .getByText("Real Codex CLI in a disposable container", {
              exact: true,
            })
            .waitFor({ state: "visible", timeout: 5_000 });
          await runtimeStatus
            .getByText(
              "Local deterministic Responses fixture. No ModelArk request or paid inference.",
              { exact: true },
            )
            .waitFor({ state: "visible", timeout: 5_000 });
          const guide = page.getByRole("region", { name: "Full safety loop" });
          const button = guide.getByRole("button", {
            name: "Prove this release is safe",
            exact: true,
          });
          await button.waitFor({ state: "visible", timeout: 10_000 });
          if (!(await button.isEnabled())) throw new Error("control unavailable");
          await presentation.dwell("opening-cta");
          if (
            (await button.count()) === 1 &&
            (await button.isVisible()) &&
            (await button.isEnabled())
          ) {
            await button.click();
          }
        } catch (error) {
          abortIfNeeded(signal);
          if (error instanceof RuntimeProofError) throw error;
          throw new RuntimeProofError("browser-failed");
        }
      },
      async assertSignedRecovery() {
        try {
          await page
            .getByRole("region", { name: "Verified Outcome Brief" })
            .waitFor({ state: "visible", timeout: 45_000 });
        } catch (error) {
          abortIfNeeded(signal);
          if (error instanceof RuntimeProofError) throw error;
          throw new RuntimeProofError("browser-failed");
        }
      },
      async assertRecordingBoard(runs) {
        try {
          recordingRuns = runs;
          const currentViewport = page.viewportSize();
          if (
            currentViewport?.width !== RUNTIME_PROOF_DESKTOP_VIEWPORT.width ||
            currentViewport?.height !== RUNTIME_PROOF_DESKTOP_VIEWPORT.height
          ) {
            throw new RuntimeProofError("viewport-invalid");
          }
          const { board } = await assertDynamicRecordingBoard({
            page,
            runs,
            viewport: RUNTIME_PROOF_DESKTOP_VIEWPORT,
          });
          const desktopBox = await board.boundingBox();
          const desktopHeight = await page.evaluate(
            () => document.documentElement.scrollHeight,
          );
          if (
            !desktopBox ||
            desktopBox.x < 0 ||
            desktopBox.y < 0 ||
            desktopBox.x + desktopBox.width >
              RUNTIME_PROOF_DESKTOP_VIEWPORT.width ||
            desktopBox.y + desktopBox.height >
              RUNTIME_PROOF_DESKTOP_VIEWPORT.height ||
            desktopHeight > RUNTIME_PROOF_DESKTOP_VIEWPORT.height
          ) {
            throw new Error("desktop brief does not fit");
          }
          if (
            (await board.getByText("Exact evidence", { exact: true }).count()) !== 3
          ) {
            throw new Error("the complete evidence board is unavailable");
          }
          const mobileFailure = new AbortController();
          const mobileReplay = assertMobileReplay(runs).catch((error) => {
            mobileFailure.abort(
              error instanceof RuntimeProofError
                ? error
                : new RuntimeProofError("viewport-invalid"),
            );
            throw error;
          });
          await Promise.all([
            presentation.dwell(
              "desktop-outcome-brief",
              mobileFailure.signal,
            ),
            mobileReplay,
          ]);
        } catch (error) {
          abortIfNeeded(signal);
          if (error instanceof RuntimeProofError) throw error;
          throw new RuntimeProofError("viewport-invalid");
        }
      },
      async captureAndInspectDecisionChain() {
        try {
          if (!recordingRuns) throw new RuntimeProofError("verifier-invalid");
          const primarySource = await waitForDecisionChainSource({
            page,
            readSource: () => capturedChainSource,
            signal,
          });
          assertMatchingRuntimeProofDecisionChainSources(
            primarySource,
            mobileChainSource,
          );
          primaryGuard.arm();
          const board = page.getByRole("region", {
            name: "Verified Outcome Brief",
          });
          await board
            .getByRole("button", {
              name: "Inspect in zero-upload verifier",
              exact: true,
            })
            .click();
          const verifier = page.getByRole("dialog", {
            name: "Verify trust without trusting this server",
          });
          await verifier
            .getByText(/0 API calls/)
            .waitFor({ state: "visible", timeout: 15_000 });
          await verifier
            .getByText("2 signed decisions linked", { exact: true })
            .waitFor({ state: "visible", timeout: 15_000 });
          await verifier
            .getByText("Every receipt, parent link, and state handoff agrees.", {
              exact: true,
            })
            .waitFor({ state: "visible", timeout: 15_000 });
          await verifier
            .getByText(
              "The complete chain includes this parent and validates its exact receipt digest and Canonical State handoff.",
              { exact: true },
            )
            .waitFor({ state: "visible", timeout: 15_000 });
          await assertVerifierRecordingSummary({
            page,
            verifier,
            viewport: RUNTIME_PROOF_DESKTOP_VIEWPORT,
            runs: recordingRuns,
          });
          await page.waitForTimeout(100);
          primaryGuard.assertStayedLocal();
          await presentation.dwell("desktop-verifier");
          primaryGuard.assertStayedLocal();
          return primarySource;
        } catch (error) {
          abortIfNeeded(signal);
          if (error instanceof RuntimeProofError) throw error;
          throw new RuntimeProofError("verifier-invalid");
        }
      },
      async close() {
        let closeError = null;
        for (const guard of [mobileGuard, primaryGuard]) {
          try {
            if (guard?.armed) guard.assertStayedLocal();
          } catch (error) {
            closeError ??= error;
          }
        }
        detachBrowserAbort();
        for (const ownedBrowser of [mobileBrowser, browser]) {
          if (!ownedBrowser) continue;
          try {
            await ownedBrowser.close();
          } catch (error) {
            closeError ??= error;
          }
        }
        for (const guard of [mobileGuard, primaryGuard]) {
          try {
            if (guard?.armed) guard.assertStayedLocal();
          } catch (error) {
            closeError ??= error;
          }
        }
        if (closeError) throw closeError;
      },
    };
  } catch (error) {
    detachBrowserAbort();
    await Promise.allSettled(
      [mobileBrowser, browser]
        .filter(Boolean)
        .map((ownedBrowser) => ownedBrowser.close()),
    );
    abortIfNeeded(signal);
    if (error instanceof RuntimeProofError) throw error;
    throw new RuntimeProofError("browser-failed");
  }
}

async function defaultVerifyChain(source) {
  const { verifyPortableDecisionChainJson } = await import(
    "@agent-airlock/portable-promotion-receipt"
  );
  return verifyPortableDecisionChainJson(source);
}

export async function runRuntimeProofSession({
  baseUrl,
  artifactRoot,
  readinessDigest,
  browserDriver,
  fetchImpl = fetch,
  verifyChain = defaultVerifyChain,
  writeArtifacts = writeRuntimeProofArtifacts,
  now = Date.now,
  observedAt = () => new Date().toISOString(),
  recordingDeadlineAt =
    browserDriver?.recordingDeadlineAt ??
    now() + RUNTIME_PROOF_RECORDING_BUDGET_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
  waitImpl = abortableTimeout,
}) {
  let primaryError = null;
  let browserClosed = false;
  try {
    if (
      !SHA256_PATTERN.test(readinessDigest ?? "") ||
      !Number.isFinite(recordingDeadlineAt)
    ) {
      throw new RuntimeProofError("startup-failed");
    }
    const agentPayload = await requestJson(
      baseUrl,
      "/api/agents",
      fetchImpl,
      signal,
      "startup-failed",
    );
    const agent = uniqueRuntimeProofAgent(agentPayload?.agents);
    const initialPayload = await requestJson(
      baseUrl,
      `/api/agents/${agent.id}/runs`,
      fetchImpl,
      signal,
      "startup-failed",
    );
    const initialOrdinary = ordinaryRuns(initialPayload?.runs);
    if (initialOrdinary.length !== 0) throw new RuntimeProofError("stale-state");
    const initialRunIds = new Set(initialOrdinary.map((run) => run.id));

    await browserDriver.invokeCompleteSafetyLoop();
    const runs = await waitForExactRunSet({
      baseUrl,
      agent,
      initialRunIds,
      fetchImpl,
      now,
      pollIntervalMs,
      recordingDeadlineAt,
      runTimeoutMs,
      signal,
      waitImpl,
    });
    await browserDriver.assertSignedRecovery();
    await browserDriver.assertRecordingBoard(runs);
    const chainSource = await browserDriver.captureAndInspectDecisionChain();
    abortIfNeeded(signal);
    const finalRuns = await recheckExactRunSet({
      baseUrl,
      agent,
      initialRunIds,
      expectedRuns: runs,
      fetchImpl,
      signal,
    });
    let report;
    try {
      report = await verifyChain(chainSource);
    } catch {
      abortIfNeeded(signal);
      throw new RuntimeProofError("chain-invalid");
    }
    const chainEvidence = assertVerifiedDecisionChain({
      source: chainSource,
      report,
      runs: finalRuns,
    });
    assertRuntimeProofRecordingWindow({
      recordingDeadlineAt,
      now,
      signal,
    });
    const result = buildRuntimeProofResult({
      observedAt: observedAt(),
      readinessDigest,
      runs: finalRuns,
      ...chainEvidence,
    });
    try {
      await browserDriver.close();
      browserClosed = true;
    } catch (error) {
      if (error instanceof RuntimeProofError) throw error;
      throw new RuntimeProofError("cleanup-failed");
    }
    assertRuntimeProofRecordingWindow({
      recordingDeadlineAt,
      now,
      signal,
    });
    await writeArtifacts({
      artifactRoot,
      chainSource,
      result,
      recordingDeadlineAt,
      beforeCommit: () =>
        assertRuntimeProofRecordingWindow({
          recordingDeadlineAt,
          now,
          signal,
        }),
    });
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!browserClosed) {
      try {
        await browserDriver.close();
      } catch (error) {
        if (!primaryError) {
          if (error instanceof RuntimeProofError) throw error;
          throw new RuntimeProofError("cleanup-failed");
        }
      }
    }
  }
}

export function assertSafeRuntimeProofRoot(projectRoot, candidateRoot) {
  const project = path.resolve(projectRoot);
  const localRoot = path.join(project, ".local");
  const resolved = path.resolve(candidateRoot);
  if (!isStrictDescendant(localRoot, resolved)) {
    throw new RuntimeProofError("startup-failed");
  }
  return resolved;
}

async function assertDirectoryAncestorsArePhysical(parent, candidate) {
  const relative = path.relative(parent, candidate);
  let current = parent;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const status = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!status) break;
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new RuntimeProofError("startup-failed");
    }
  }
}

export async function initializeRuntimeProofRoot({ projectRoot, artifactRoot }) {
  const root = assertSafeRuntimeProofRoot(projectRoot, artifactRoot);
  const localRoot = path.join(path.resolve(projectRoot), ".local");
  const markerPath = path.join(root, RUNTIME_PROOF_ROOT_MARKER);
  const localStatus = await lstat(localRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (localStatus && (!localStatus.isDirectory() || localStatus.isSymbolicLink())) {
    throw new RuntimeProofError("startup-failed");
  }
  if (localStatus) {
    await assertDirectoryAncestorsArePhysical(localRoot, root);
  }
  const existing = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  let existingMarker = false;
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new RuntimeProofError("startup-failed");
  }
  if (existing) {
    const markerStatus = await lstat(markerPath).catch(() => null);
    if (
      !markerStatus?.isFile() ||
      markerStatus.isSymbolicLink()
    ) {
      throw new RuntimeProofError("startup-failed");
    }
    const marker = await readFile(markerPath, "utf8").catch(() => null);
    if (marker !== ROOT_MARKER_CONTENT) {
      throw new RuntimeProofError("startup-failed");
    }
    existingMarker = true;
  }
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const [realProject, realRoot] = await Promise.all([
    realpath(path.resolve(projectRoot)),
    realpath(root),
  ]);
  const realLocalRoot = path.join(realProject, ".local");
  if (!isStrictDescendant(realLocalRoot, realRoot)) {
    throw new RuntimeProofError("startup-failed");
  }
  if (!existingMarker) {
    await writeFile(markerPath, ROOT_MARKER_CONTENT, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  await chmod(markerPath, 0o600);
  return root;
}

export async function createRuntimeProofSessionRoot({ artifactRoot }) {
  const root = path.resolve(artifactRoot);
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new RuntimeProofError("startup-failed");
  }
  const rootMarkerStatus = await lstat(
    path.join(root, RUNTIME_PROOF_ROOT_MARKER),
  ).catch(() => null);
  if (!rootMarkerStatus?.isFile() || rootMarkerStatus.isSymbolicLink()) {
    throw new RuntimeProofError("startup-failed");
  }
  if (
    (await readFile(path.join(root, RUNTIME_PROOF_ROOT_MARKER), "utf8")) !==
    ROOT_MARKER_CONTENT
  ) {
    throw new RuntimeProofError("startup-failed");
  }
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  const sessionsStatus = await lstat(sessionsRoot);
  if (!sessionsStatus.isDirectory() || sessionsStatus.isSymbolicLink()) {
    throw new RuntimeProofError("startup-failed");
  }
  const [realRoot, realSessions] = await Promise.all([
    realpath(root),
    realpath(sessionsRoot),
  ]);
  if (path.dirname(realSessions) !== realRoot) {
    throw new RuntimeProofError("startup-failed");
  }
  await chmod(sessionsRoot, 0o700);
  const nonce = randomUUID();
  const sessionRoot = path.join(sessionsRoot, `session-${process.pid}-${nonce}`);
  await mkdir(sessionRoot, { mode: 0o700 });
  const marker = {
    schema: "agent-airlock/runtime-proof-session",
    schemaVersion: 1,
    ownerPid: process.pid,
    nonce,
  };
  const markerPath = path.join(sessionRoot, RUNTIME_PROOF_SESSION_MARKER);
  await writeFile(markerPath, JSON.stringify(marker) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(markerPath, 0o600);
  return { sessionRoot, nonce };
}

export async function cleanupAbandonedRuntimeProofSessions({
  artifactRoot,
  processExists = runtimeProofProcessExists,
  artifactIo = runRuntimeProofArtifactWorker,
  fsImpl = { lstat, open, readdir, realpath },
}) {
  let rootAnchor = null;
  let sessionsAnchor = null;
  try {
    if (typeof processExists !== "function") {
      throw new RuntimeProofError("cleanup-failed");
    }
    const root = path.resolve(artifactRoot);
    const sessionsRoot = path.join(root, "sessions");
    rootAnchor = await openOwnerOnlyDirectory(root, {}, fsImpl);
    const rootMarkerBytes = await readOwnerOnlyPhysicalFile(
      path.join(root, RUNTIME_PROOF_ROOT_MARKER),
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: rootAnchor,
      },
      fsImpl,
      artifactIo,
    );
    if (
      rootMarkerBytes === null ||
      !rootMarkerBytes.equals(Buffer.from(ROOT_MARKER_CONTENT, "utf8"))
    ) {
      throw new RuntimeProofError("cleanup-failed");
    }
    const sessionsStatus = await fsImpl.lstat(sessionsRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (sessionsStatus === null) return { removedSessions: 0 };
    sessionsAnchor = await openOwnerOnlyDirectory(
      sessionsRoot,
      { realParentDirectory: rootAnchor.realDirectory },
      fsImpl,
    );
    const entries = await fsImpl.readdir(sessionsRoot, {
      withFileTypes: true,
    });
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    await assertDirectoryAnchor(sessionsAnchor, fsImpl);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    let removedSessions = 0;
    for (const entry of entries) {
      if (
        typeof entry.name !== "string" ||
        path.basename(entry.name) !== entry.name ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new RuntimeProofError("cleanup-failed");
      }
      await assertDirectoryAnchor(rootAnchor, fsImpl);
      await assertDirectoryAnchor(sessionsAnchor, fsImpl);
      const sessionRoot = path.join(sessionsRoot, entry.name);
      let sessionAnchor = null;
      try {
        sessionAnchor = await openOwnerOnlyDirectory(
          sessionRoot,
          { realParentDirectory: sessionsAnchor.realDirectory },
          fsImpl,
        );
        const markerBytes = await readOwnerOnlyPhysicalFile(
          path.join(sessionRoot, RUNTIME_PROOF_SESSION_MARKER),
          {
            maximumBytes: MAXIMUM_RESULT_BYTES,
            parentAnchor: sessionAnchor,
          },
          fsImpl,
          artifactIo,
        );
        if (markerBytes === null) {
          throw new RuntimeProofError("cleanup-failed");
        }
        const marker = parseRuntimeProofSessionMarker(
          markerBytes,
          entry.name,
        );
        let ownerIsLive;
        try {
          ownerIsLive = processExists(marker.ownerPid);
        } catch {
          throw new RuntimeProofError("cleanup-failed");
        }
        if (typeof ownerIsLive !== "boolean") {
          throw new RuntimeProofError("cleanup-failed");
        }
        if (ownerIsLive) throw new RuntimeProofError("startup-failed");
        const purge = await artifactIo(sessionAnchor, {
          operation: "purge-private-directory",
          markerName: RUNTIME_PROOF_SESSION_MARKER,
          markerContent: markerBytes.toString("base64"),
          maximumBytes: MAXIMUM_RESULT_BYTES,
        });
        if (purge.purged !== true) {
          throw new RuntimeProofError("cleanup-failed");
        }
        await assertDirectoryAnchor(sessionAnchor, fsImpl);
        await closeDirectoryAnchor(sessionAnchor);
        sessionAnchor = null;
        const removed = await removeEmptyPrivateDirectory(
          sessionRoot,
          sessionsAnchor,
          fsImpl,
          artifactIo,
        );
        if (!removed) throw new RuntimeProofError("cleanup-failed");
        removedSessions += 1;
      } finally {
        await closeDirectoryAnchor(sessionAnchor);
      }
    }
    await assertDirectoryAnchor(rootAnchor, fsImpl);
    await assertDirectoryAnchor(sessionsAnchor, fsImpl);
    return { removedSessions };
  } catch (error) {
    if (
      error instanceof RuntimeProofError &&
      error.failureClass === "startup-failed"
    ) {
      throw error;
    }
    throw new RuntimeProofError("cleanup-failed");
  } finally {
    await closeDirectoryAnchor(sessionsAnchor);
    await closeDirectoryAnchor(rootAnchor);
  }
}

export async function cleanupRuntimeProofSessionRoot({
  artifactRoot,
  sessionRoot,
  nonce,
}) {
  const root = path.resolve(artifactRoot);
  const sessionsRoot = path.join(root, "sessions");
  const resolved = path.resolve(sessionRoot);
  if (
    path.dirname(resolved) !== sessionsRoot ||
    !isStrictDescendant(sessionsRoot, resolved)
  ) {
    throw new RuntimeProofError("cleanup-failed");
  }
  const sessionStatus = await lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!sessionStatus) return;
  if (!sessionStatus.isDirectory() || sessionStatus.isSymbolicLink()) {
    throw new RuntimeProofError("cleanup-failed");
  }
  let rootAnchor = null;
  let sessionsAnchor = null;
  let sessionAnchor = null;
  try {
    rootAnchor = await openOwnerOnlyDirectory(root, {}, {
      lstat,
      open,
      realpath,
    });
    sessionsAnchor = await openOwnerOnlyDirectory(
      sessionsRoot,
      { realParentDirectory: rootAnchor.realDirectory },
      { lstat, open, realpath },
    );
    sessionAnchor = await openOwnerOnlyDirectory(
      resolved,
      { realParentDirectory: sessionsAnchor.realDirectory },
      { lstat, open, realpath },
    );
    const markerPath = path.join(resolved, RUNTIME_PROOF_SESSION_MARKER);
    const markerBytes = await readOwnerOnlyPhysicalFile(
      markerPath,
      {
        maximumBytes: MAXIMUM_RESULT_BYTES,
        parentAnchor: sessionAnchor,
      },
      { lstat, realpath },
    );
    if (markerBytes === null) throw new RuntimeProofError("cleanup-failed");
    const marker = parseRuntimeProofSessionMarker(
      markerBytes,
      path.basename(resolved),
    );
    if (
      marker.nonce !== nonce ||
      marker.ownerPid !== process.pid
    ) {
      throw new RuntimeProofError("cleanup-failed");
    }
    const purge = await runRuntimeProofArtifactWorker(sessionAnchor, {
      operation: "purge-private-directory",
      markerName: RUNTIME_PROOF_SESSION_MARKER,
      markerContent: markerBytes.toString("base64"),
      maximumBytes: MAXIMUM_RESULT_BYTES,
    });
    if (purge.purged !== true) {
      throw new RuntimeProofError("cleanup-failed");
    }
    await assertDirectoryAnchor(sessionAnchor, { lstat, realpath });
    await closeDirectoryAnchor(sessionAnchor);
    sessionAnchor = null;
    await removeEmptyPrivateDirectory(
      resolved,
      sessionsAnchor,
      { lstat, realpath },
    );
    await assertDirectoryAnchor(sessionsAnchor, { lstat, realpath });
    await assertDirectoryAnchor(rootAnchor, { lstat, realpath });
  } catch (error) {
    if (error instanceof RuntimeProofError && error.failureClass === "cleanup-failed") {
      throw error;
    }
    throw new RuntimeProofError("cleanup-failed");
  } finally {
    await closeDirectoryAnchor(sessionAnchor);
    await closeDirectoryAnchor(sessionsAnchor);
    await closeDirectoryAnchor(rootAnchor);
  }
}
