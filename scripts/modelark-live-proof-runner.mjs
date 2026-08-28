import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isCompleteLiveModelArkPromotion,
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
} from "./modelark-conformance-evidence.mjs";
import { liveModelArkAgentName } from "./modelark-demo-profile.mjs";
import { verifyRecordedLiveModelArkEvidence } from "./modelark-recorded-evidence.mjs";

export const LIVE_MODELARK_PROOF_RESULT_SCHEMA =
  "agent-airlock/live-modelark-proof-result";
export const LIVE_MODELARK_PROOF_RESULT_NAME =
  "modelark-live-latest.result.json";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_RESULT_PATTERN =
  /Bearer\s|ARK_API_KEY|api[_-]?key\s*[=:]|https?:\/\/|\bep-[A-Za-z0-9]|\bark-[A-Za-z0-9]|(?:^|["'\s])\/(?:Users|home|private|tmp|var)\//i;

const FAILURE_MESSAGES = Object.freeze({
  "provider-unavailable":
    "ModelArk free-only capacity or quota is unavailable. Keep Free Credits Only Mode enabled and retry later.",
  "startup-failed":
    "The live proof launcher did not reach its admitted ready state.",
  "browser-failed":
    "Chrome could not invoke or observe the production live proof control.",
  "run-quarantined":
    "The live Candidate was quarantined, so no conformance success was recorded.",
  "run-failed":
    "The live Candidate did not produce the exact complete Whole-Agent Promotion.",
  "run-timeout":
    "The live Candidate did not reach a terminal decision inside the bounded proof window.",
  "evidence-timeout":
    "Promotion completed, but the signed evidence packet was not captured inside the bounded proof window.",
  "evidence-invalid":
    "The captured live evidence packet failed independent offline verification.",
  interrupted: "The live proof was interrupted and no success result was written.",
});

export class LiveModelArkProofError extends Error {
  constructor(failureClass, message = FAILURE_MESSAGES[failureClass]) {
    super(message ?? FAILURE_MESSAGES["startup-failed"]);
    this.name = "LiveModelArkProofError";
    this.failureClass = failureClass;
  }
}

function abortError(signal) {
  if (signal?.aborted) {
    throw new LiveModelArkProofError("interrupted");
  }
}

async function requestJson(baseUrl, pathname, fetchImpl, signal) {
  abortError(signal);
  let response;
  try {
    const timeout = AbortSignal.timeout(10_000);
    response = await fetchImpl(baseUrl + pathname, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    abortError(signal);
    throw new LiveModelArkProofError("run-failed");
  }
  if (!response.ok) throw new LiveModelArkProofError("run-failed");
  return response.json();
}

async function delay(milliseconds, signal, waitImpl) {
  abortError(signal);
  await waitImpl(milliseconds, signal);
  abortError(signal);
}

function uniqueLiveAgent(agents) {
  const matches = agents.filter((agent) => agent.name === liveModelArkAgentName);
  if (matches.length !== 1 || !SAFE_IDENTIFIER_PATTERN.test(matches[0]?.id ?? "")) {
    throw new LiveModelArkProofError("startup-failed");
  }
  return matches[0];
}

function terminalFailure(run) {
  if (run.transaction?.disposition === "quarantined") {
    return new LiveModelArkProofError("run-quarantined");
  }
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.transaction?.status === "recovery-error" ||
    run.transaction?.disposition === "cancelled"
  ) {
    return new LiveModelArkProofError("run-failed");
  }
  if (run.status === "completed" && !isCompleteLiveModelArkPromotion(run)) {
    return new LiveModelArkProofError("run-failed");
  }
  return null;
}

async function waitForTerminalRun({
  baseUrl,
  agentId,
  initialRunIds,
  fetchImpl,
  now,
  pollIntervalMs,
  runTimeoutMs,
  signal,
  waitImpl,
}) {
  const deadline = now() + runTimeoutMs;
  while (now() <= deadline) {
    const { runs } = await requestJson(
      baseUrl,
      `/api/agents/${agentId}/runs`,
      fetchImpl,
      signal,
    );
    const created = runs.filter(
      (run) => !initialRunIds.has(run.id) && !run.candidateSetId,
    );
    if (created.length > 1) {
      throw new LiveModelArkProofError("run-failed");
    }
    const run = created[0];
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
      const failure = terminalFailure(run);
      if (failure) throw failure;
      if (isCompleteLiveModelArkPromotion(run)) return run;
    }
    await delay(pollIntervalMs, signal, waitImpl);
  }
  throw new LiveModelArkProofError("run-timeout");
}

async function waitForVerifiedEvidence({
  runId,
  stateRoot,
  evidenceTimeoutMs,
  pollIntervalMs,
  now,
  signal,
  waitImpl,
  verifyEvidence,
}) {
  const deadline = now() + evidenceTimeoutMs;
  while (now() <= deadline) {
    try {
      const result = await verifyEvidence({ stateRoot });
      if (result.runId === runId) {
        if (!result.valid) {
          throw new LiveModelArkProofError("evidence-invalid");
        }
        return result;
      }
    } catch (error) {
      if (error instanceof LiveModelArkProofError) throw error;
      if (error?.code !== "ENOENT") {
        throw new LiveModelArkProofError("evidence-invalid");
      }
    }
    await delay(pollIntervalMs, signal, waitImpl);
  }
  throw new LiveModelArkProofError("evidence-timeout");
}

export function buildLiveModelArkProofResult({ observedAt, runId, receiptDigest }) {
  const result = {
    schema: LIVE_MODELARK_PROOF_RESULT_SCHEMA,
    schemaVersion: 1,
    outcome: "passed",
    observedAt,
    clockClaim: "observer-clock-not-external-timestamp",
    runId,
    receiptDigest,
    gates: {
      browserInvocation: true,
      completePromotion: true,
      packetCaptured: true,
      offlineVerification: true,
    },
    packetFile: liveModelArkLatestEvidenceName,
  };
  assertSafeLiveModelArkProofResult(result);
  return result;
}

export function assertSafeLiveModelArkProofResult(result) {
  const expectedGates = [
    "browserInvocation",
    "completePromotion",
    "offlineVerification",
    "packetCaptured",
  ];
  const actualGates = Object.keys(result?.gates ?? {}).sort();
  if (
    result?.schema !== LIVE_MODELARK_PROOF_RESULT_SCHEMA ||
    result?.schemaVersion !== 1 ||
    result?.outcome !== "passed" ||
    result?.clockClaim !== "observer-clock-not-external-timestamp" ||
    typeof result?.observedAt !== "string" ||
    !Number.isFinite(Date.parse(result.observedAt)) ||
    !SAFE_IDENTIFIER_PATTERN.test(result?.runId ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(result?.receiptDigest ?? "") ||
    result?.packetFile !== liveModelArkLatestEvidenceName ||
    JSON.stringify(actualGates) !== JSON.stringify(expectedGates) ||
    !Object.values(result.gates).every((value) => value === true)
  ) {
    throw new LiveModelArkProofError("evidence-invalid");
  }
  const serialized = JSON.stringify(result);
  if (FORBIDDEN_RESULT_PATTERN.test(serialized)) {
    throw new LiveModelArkProofError("evidence-invalid");
  }
  return serialized;
}

export async function writeLiveModelArkProofResult({ stateRoot, result }) {
  const serialized = assertSafeLiveModelArkProofResult(result) + "\n";
  const evidenceDirectory = path.join(
    path.resolve(stateRoot),
    liveModelArkEvidenceDirectoryName,
  );
  const resultPath = path.join(evidenceDirectory, LIVE_MODELARK_PROOF_RESULT_NAME);
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, resultPath);
  return resultPath;
}

export function safeLiveModelArkFailure(error) {
  const failureClass =
    error instanceof LiveModelArkProofError && FAILURE_MESSAGES[error.failureClass]
      ? error.failureClass
      : "startup-failed";
  return {
    schema: LIVE_MODELARK_PROOF_RESULT_SCHEMA,
    schemaVersion: 1,
    outcome: "failed",
    failureClass,
    message: FAILURE_MESSAGES[failureClass],
  };
}

export function classifyLiveModelArkLauncherFailure(transcript) {
  if (
    /HTTP 429|free quota|free-only|provider capacity|inference limit/i.test(
      transcript,
    )
  ) {
    return new LiveModelArkProofError("provider-unavailable");
  }
  return new LiveModelArkProofError("startup-failed");
}

export async function createPlaywrightLiveModelArkDriver({
  baseUrl,
  headless = true,
}) {
  const { chromium } = await import("@playwright/test");
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    return {
      async invokeLiveCandidate() {
        try {
          await page.goto(baseUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          const guide = page.getByRole("region", { name: "Live ModelArk proof" });
          await guide.waitFor({ state: "visible", timeout: 30_000 });
          const button = guide.getByRole("button", { name: /Run live Candidate/ });
          await button.waitFor({ state: "visible", timeout: 10_000 });
          await button.click();
        } catch {
          throw new LiveModelArkProofError("browser-failed");
        }
      },
      async assertBoundVerdict() {
        try {
          const guide = page.getByRole("region", { name: "Live ModelArk proof" });
          await guide
            .getByText("ModelArk preflight, Runtime, and Promotion bound", {
              exact: true,
            })
            .waitFor({ state: "visible", timeout: 30_000 });
        } catch {
          throw new LiveModelArkProofError("browser-failed");
        }
      },
      async close() {
        await browser.close();
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    if (error instanceof LiveModelArkProofError) throw error;
    throw new LiveModelArkProofError("browser-failed");
  }
}

export async function runLiveModelArkProofSession({
  baseUrl,
  stateRoot,
  browserDriver,
  fetchImpl = fetch,
  now = Date.now,
  observedAt = () => new Date().toISOString(),
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  evidenceTimeoutMs = DEFAULT_EVIDENCE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
  waitImpl = (milliseconds, waitSignal) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new LiveModelArkProofError("interrupted"));
      };
      const timer = setTimeout(() => {
        waitSignal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      waitSignal?.addEventListener("abort", onAbort, { once: true });
    }),
  verifyEvidence = verifyRecordedLiveModelArkEvidence,
  writeResult = writeLiveModelArkProofResult,
}) {
  try {
    const { agents } = await requestJson(
      baseUrl,
      "/api/agents",
      fetchImpl,
      signal,
    );
    const agent = uniqueLiveAgent(agents);
    const initial = await requestJson(
      baseUrl,
      `/api/agents/${agent.id}/runs`,
      fetchImpl,
      signal,
    );
    const initialRunIds = new Set(initial.runs.map((run) => run.id));
    await browserDriver.invokeLiveCandidate();
    const run = await waitForTerminalRun({
      baseUrl,
      agentId: agent.id,
      initialRunIds,
      fetchImpl,
      now,
      pollIntervalMs,
      runTimeoutMs,
      signal,
      waitImpl,
    });
    await browserDriver.assertBoundVerdict();
    const evidence = await waitForVerifiedEvidence({
      runId: run.id,
      stateRoot,
      evidenceTimeoutMs,
      pollIntervalMs,
      now,
      signal,
      waitImpl,
      verifyEvidence,
    });
    const result = buildLiveModelArkProofResult({
      observedAt: observedAt(),
      runId: run.id,
      receiptDigest: evidence.receiptDigest,
    });
    await writeResult({ stateRoot, result });
    return result;
  } finally {
    await browserDriver.close().catch(() => {});
  }
}
