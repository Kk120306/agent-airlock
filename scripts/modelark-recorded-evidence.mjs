import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  liveModelArkEvidenceDirectoryName,
  liveModelArkEvidenceNameForRun,
  liveModelArkLatestEvidenceName,
  liveModelArkLatestResultName,
} from "./modelark-conformance-evidence.mjs";

export const LIVE_MODELARK_PROOF_RESULT_SCHEMA =
  "agent-airlock/live-modelark-proof-result";
export const LIVE_MODELARK_PROOF_RESULT_NAME = liveModelArkLatestResultName;

const MAXIMUM_RECORDED_EVIDENCE_BYTES = 2_097_152;
const MAXIMUM_RESULT_BYTES = 8_192;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXPECTED_RESULT_KEYS = [
  "clockClaim",
  "gates",
  "observedAt",
  "outcome",
  "packetFile",
  "receiptDigest",
  "runId",
  "schema",
  "schemaVersion",
];
const EXPECTED_GATE_KEYS = [
  "browserInvocation",
  "completePromotion",
  "offlineVerification",
  "packetCaptured",
];
const FORBIDDEN_RESULT_PATTERN =
  /Bearer\s|ARK_API_KEY|api[_-]?key\s*[=:]|https?:\/\/|\bep-[A-Za-z0-9]|\bark-[A-Za-z0-9]|(?:^|["'\s])\/(?:Users|home|private|tmp|var)\//i;

function ownedByCurrentUser(status) {
  return typeof process.geteuid !== "function" || status.uid === process.geteuid();
}

export function assertCanonicalLiveModelArkProofResult(result) {
  const actualResultKeys = Object.keys(result ?? {}).sort();
  const actualGateKeys = Object.keys(result?.gates ?? {}).sort();
  const observedAt = result?.observedAt;
  if (
    JSON.stringify(actualResultKeys) !== JSON.stringify(EXPECTED_RESULT_KEYS) ||
    result?.schema !== LIVE_MODELARK_PROOF_RESULT_SCHEMA ||
    result?.schemaVersion !== 1 ||
    result?.outcome !== "passed" ||
    result?.clockClaim !== "observer-clock-not-external-timestamp" ||
    typeof observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt ||
    !SAFE_IDENTIFIER_PATTERN.test(result?.runId ?? "") ||
    !SHA256_PATTERN.test(result?.receiptDigest ?? "") ||
    result?.packetFile !== liveModelArkEvidenceNameForRun(result?.runId) ||
    JSON.stringify(actualGateKeys) !== JSON.stringify(EXPECTED_GATE_KEYS) ||
    !Object.values(result.gates).every((value) => value === true)
  ) {
    throw new Error("Recorded ModelArk proof result is invalid");
  }
  const serialized = JSON.stringify(result);
  if (FORBIDDEN_RESULT_PATTERN.test(serialized)) {
    throw new Error("Recorded ModelArk proof result contains private material");
  }
  return serialized;
}

export function recordedLiveModelArkEvidencePath(
  stateRoot,
  packetFile = liveModelArkLatestEvidenceName,
) {
  if (
    packetFile !== liveModelArkLatestEvidenceName &&
    !/^modelark-live-[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\.packet\.json$/.test(
      packetFile,
    )
  ) {
    throw new Error("Recorded ModelArk evidence filename is unsafe");
  }
  return path.join(
    path.resolve(stateRoot),
    liveModelArkEvidenceDirectoryName,
    packetFile,
  );
}

async function readBoundedRegularFile(
  filePath,
  maximumBytes = MAXIMUM_RECORDED_EVIDENCE_BYTES,
) {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      !ownedByCurrentUser(stat) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > maximumBytes
    ) {
      throw new Error("Recorded ModelArk evidence must be a bounded regular file");
    }
    if (stat.nlink === 2) {
      const error = new Error(
        "Recorded ModelArk evidence publication is still committing",
      );
      error.code = "EVIDENCE_PUBLICATION_IN_PROGRESS";
      throw error;
    }
    if (stat.nlink !== 1) {
      throw new Error("Recorded ModelArk evidence has an unsafe link count");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readLatestResultPointer(stateRoot) {
  const filePath = path.join(
    path.resolve(stateRoot),
    liveModelArkEvidenceDirectoryName,
    liveModelArkLatestResultName,
  );
  let source;
  try {
    source = await readBoundedRegularFile(filePath, MAXIMUM_RESULT_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let result;
  try {
    result = JSON.parse(source);
  } catch {
    throw new Error("Recorded ModelArk proof result is malformed");
  }
  try {
    assertCanonicalLiveModelArkProofResult(result);
  } catch {
    throw new Error("Recorded ModelArk proof result is invalid");
  }
  return {
    runId: result.runId,
    receiptDigest: result.receiptDigest,
    packetFile: result.packetFile,
  };
}

export async function verifyRecordedLiveModelArkEvidence({
  stateRoot,
  packetFile = null,
}) {
  const { verifyPortableEvidencePacketJson } = await import(
    "@agent-airlock/portable-promotion-receipt"
  );
  const resultPointer =
    packetFile === null ? await readLatestResultPointer(stateRoot) : null;
  const selectedPacketFile =
    packetFile ?? resultPointer?.packetFile ?? liveModelArkLatestEvidenceName;
  const source = await readBoundedRegularFile(
    recordedLiveModelArkEvidencePath(stateRoot, selectedPacketFile),
  );
  const report = verifyPortableEvidencePacketJson(source);
  const packet = JSON.parse(source);
  const receipt = packet?.envelope?.receipt;
  const providerDisclosure = packet?.envelope?.disclosures?.find(
    (disclosure) =>
      disclosure.leaf?.required === true &&
      disclosure.leaf?.status === "passed" &&
      disclosure.leaf?.summary?.includes(
        "configured ModelArk Responses profile",
      ),
  );
  const runId = receipt?.decision?.runId;
  const receiptDigest = report.receipt.receiptDigest;
  const valid =
    report.valid &&
    packet?.schema === "agent-airlock/portable-evidence-packet" &&
    receipt?.decision?.disposition === "promoted" &&
    typeof runId === "string" &&
    runId.length > 0 &&
    /^sha256:[a-f0-9]{64}$/.test(receiptDigest ?? "") &&
    Boolean(providerDisclosure) &&
    (resultPointer === null ||
      (resultPointer.runId === runId &&
        resultPointer.receiptDigest === receiptDigest));

  return {
    valid,
    runId: typeof runId === "string" ? runId : null,
    receiptDigest: receiptDigest ?? null,
    executionProfileDisclosed: Boolean(providerDisclosure),
    packetFile: selectedPacketFile,
  };
}
