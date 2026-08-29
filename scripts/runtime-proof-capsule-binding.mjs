function same(value, expected) {
  if (value !== expected) {
    throw new Error("Runtime proof capsule and signed chain do not match");
  }
}

function bindCapsuleRun(capsuleRun, receipt, disposition) {
  same(capsuleRun?.runId, receipt?.decision?.runId);
  same(capsuleRun?.disposition, disposition);
  same(receipt?.decision?.disposition, disposition);
  same(capsuleRun?.canonicalStateIdBefore, receipt?.state?.before?.stateId);
  same(
    capsuleRun?.canonicalContentHashBefore,
    receipt?.state?.before?.compositeHash,
  );
  same(capsuleRun?.canonicalStateIdAfter, receipt?.state?.after?.stateId);
  same(
    capsuleRun?.canonicalContentHashAfter,
    receipt?.state?.after?.compositeHash,
  );
}

export function assertRuntimeProofCapsuleChainBinding({
  result,
  chainDocument,
}) {
  if (!Array.isArray(chainDocument?.packets) || chainDocument.packets.length !== 2) {
    throw new Error("Runtime proof signed chain must contain exactly two decisions");
  }
  const parentEnvelope = chainDocument.packets[0]?.envelope;
  const childEnvelope = chainDocument.packets[1]?.envelope;
  const parent = parentEnvelope?.receipt;
  const child = childEnvelope?.receipt;
  bindCapsuleRun(result?.runs?.quarantine, parent, "quarantined");
  bindCapsuleRun(result?.runs?.repair, child, "promoted");

  same(parent?.ancestry?.rootRunId, parent?.decision?.runId);
  same(parent?.ancestry?.parentRunId, null);
  same(parent?.ancestry?.depth, 0);
  same(parent?.ancestry?.previousReceiptDigest, null);
  same(child?.ancestry?.rootRunId, parent?.decision?.runId);
  same(child?.ancestry?.parentRunId, parent?.decision?.runId);
  same(child?.ancestry?.depth, 1);
  same(child?.ancestry?.previousReceiptDigest, parentEnvelope?.receiptDigest);
  same(result?.leafReceiptDigest, childEnvelope?.receiptDigest);

  same(parent?.state?.before?.stateId, parent?.state?.after?.stateId);
  same(
    parent?.state?.before?.compositeHash,
    parent?.state?.after?.compositeHash,
  );
  same(parent?.state?.after?.stateId, child?.state?.before?.stateId);
  same(
    parent?.state?.after?.compositeHash,
    child?.state?.before?.compositeHash,
  );
  if (
    child?.state?.before?.stateId === child?.state?.after?.stateId ||
    child?.state?.before?.compositeHash === child?.state?.after?.compositeHash
  ) {
    throw new Error("Runtime proof Repair receipt did not advance Canonical State");
  }

  same(
    result?.runs?.promotion?.canonicalStateIdAfter,
    parent?.state?.before?.stateId,
  );
  same(
    result?.runs?.promotion?.canonicalContentHashAfter,
    parent?.state?.before?.compositeHash,
  );
  if (
    result?.runs?.promotion?.canonicalStateIdBefore ===
      result?.runs?.promotion?.canonicalStateIdAfter ||
    result?.runs?.promotion?.canonicalContentHashBefore ===
      result?.runs?.promotion?.canonicalContentHashAfter
  ) {
    throw new Error("Runtime proof Promotion capsule did not advance Canonical State");
  }

  return {
    chainBackedRuns: ["quarantine", "repair"],
    promotionClaim: "runner-observed-capsule-not-signed",
  };
}
