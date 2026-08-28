import { open } from "node:fs/promises";
import path from "node:path";
import {
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
} from "./modelark-conformance-evidence.mjs";

const MAXIMUM_RECORDED_EVIDENCE_BYTES = 2_097_152;

export function recordedLiveModelArkEvidencePath(stateRoot) {
  return path.join(
    path.resolve(stateRoot),
    liveModelArkEvidenceDirectoryName,
    liveModelArkLatestEvidenceName,
  );
}

async function readBoundedRegularFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAXIMUM_RECORDED_EVIDENCE_BYTES
    ) {
      throw new Error("Recorded ModelArk evidence must be a bounded regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function verifyRecordedLiveModelArkEvidence({ stateRoot }) {
  const { verifyPortableEvidencePacketJson } = await import(
    "@agent-airlock/portable-promotion-receipt"
  );
  const source = await readBoundedRegularFile(
    recordedLiveModelArkEvidencePath(stateRoot),
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
    Boolean(providerDisclosure);

  return {
    valid,
    runId: typeof runId === "string" ? runId : null,
    receiptDigest: receiptDigest ?? null,
    executionProfileDisclosed: Boolean(providerDisclosure),
    packetFile: liveModelArkLatestEvidenceName,
  };
}
