import type {
  PortableDecisionChain,
  ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import type { AgentRun, RunTransaction } from "./types";

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

type TerminalRecordingRun = AgentRun & { transaction: RunTransaction };

export type RecordingReplayRunIds = {
  safeRunId: string;
  unsafeRunId: string;
  repairedRunId: string;
};

export type RecordingReplaySelection =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; runIds: RecordingReplayRunIds };

export type RecordingReplayHydration = {
  agentId: string;
  baselineRunIds: string[];
  canonicalStateId: string;
  repairedRun: TerminalRecordingRun;
  runIds: RecordingReplayRunIds;
};

export const recordingReplayQueryParameters = {
  safeRunId: "recordingSafeRunId",
  unsafeRunId: "recordingUnsafeRunId",
  repairedRunId: "recordingRepairRunId",
} as const;

type RecordingEffectExpectation = {
  id: string;
  type?: string;
  status: "delivered" | "rejected";
  deliveredCount: 0 | 1;
};

export const recordingResourceKinds: RunTransaction["resources"][number]["kind"][] =
  ["workspace", "codex-session", "sqlite", "external-actions"];

export function hasLocallyVerifiedPortableProof({
  serverVerificationValid,
  browserVerificationValid,
  dirty,
}: {
  serverVerificationValid: boolean | null | undefined;
  browserVerificationValid: boolean | null;
  dirty: boolean;
}): boolean {
  return (
    serverVerificationValid === true &&
    browserVerificationValid === true &&
    !dirty
  );
}

export type PortableProofDisplayState =
  | "empty"
  | "verifying"
  | "stale"
  | "verified"
  | "failed";

export type RequestGenerationState = { current: number };

export function beginRequestGeneration(
  state: RequestGenerationState,
): number {
  state.current += 1;
  return state.current;
}

export function invalidateRequestGeneration(
  state: RequestGenerationState,
): void {
  state.current += 1;
}

export function isCurrentRequestGeneration(
  state: RequestGenerationState,
  generation: number,
): boolean {
  return state.current === generation;
}

export function getPortableProofDisplayState({
  hasResult,
  verificationValid,
  busy,
  dirty,
}: {
  hasResult: boolean;
  verificationValid: boolean;
  busy: boolean;
  dirty: boolean;
}): PortableProofDisplayState {
  if (!hasResult) return "empty";
  if (busy) return "verifying";
  if (dirty) return "stale";
  return verificationValid ? "verified" : "failed";
}

export function isPortableProofActionable(
  state: PortableProofDisplayState,
): boolean {
  return state === "verified";
}

export function hasExactRecordingResources(
  transaction: RunTransaction,
  disposition: "promoted" | "quarantined",
): boolean {
  return (
    transaction.resources.length === recordingResourceKinds.length &&
    recordingResourceKinds.every(
      (kind) =>
        transaction.resources.filter(
          (resource) =>
            resource.kind === kind && resource.disposition === disposition,
        ).length === 1,
    )
  );
}

export function advancesCanonicalState(transaction: RunTransaction): boolean {
  return (
    transaction.canonicalStateIdAfter !== null &&
    transaction.canonicalContentHashAfter !== null &&
    transaction.canonicalStateIdAfter !== transaction.canonicalStateIdBefore &&
    transaction.canonicalContentHashAfter !==
      transaction.canonicalContentHashBefore
  );
}

export function isSafeRecordingIdentifier(value: unknown): value is string {
  return typeof value === "string" && safeIdentifierPattern.test(value);
}

export function hasValidTerminalRecordingRun(
  run: TerminalRecordingRun,
  disposition: "promoted" | "quarantined",
): boolean {
  return (
    isSafeRecordingIdentifier(run.id) &&
    isSafeRecordingIdentifier(run.agentId) &&
    run.status === "completed" &&
    run.transaction.status === disposition &&
    run.transaction.disposition === disposition &&
    isSafeRecordingIdentifier(run.transaction.canonicalStateIdBefore) &&
    isSafeRecordingIdentifier(run.transaction.canonicalStateIdAfter) &&
    sha256Pattern.test(run.transaction.canonicalContentHashBefore) &&
    sha256Pattern.test(run.transaction.canonicalContentHashAfter ?? "")
  );
}

export function hasRootRecordingLineage(run: TerminalRecordingRun): boolean {
  return (
    run.transaction.lineage.rootRunId === run.id &&
    run.transaction.lineage.parentRunId === null &&
    run.transaction.lineage.depth === 0
  );
}

export function hasRepairRecordingLineage(
  repair: TerminalRecordingRun,
  rejectedParent: TerminalRecordingRun,
): boolean {
  return (
    repair.transaction.lineage.rootRunId === rejectedParent.id &&
    repair.transaction.lineage.parentRunId === rejectedParent.id &&
    repair.transaction.lineage.depth === 1
  );
}

export function hasExactRecordingDecisionChain(
  chain: PortableDecisionChain,
  rejectedParent: TerminalRecordingRun,
  repair: TerminalRecordingRun,
  verifiedLeafReceiptDigest: ReceiptDigest | null,
): boolean {
  if (
    !chain ||
    chain.schema !== "agent-airlock/portable-decision-chain" ||
    chain.schemaVersion !== 1 ||
    !Array.isArray(chain.packets) ||
    chain.packets.length !== 2 ||
    !hasValidTerminalRecordingRun(rejectedParent, "quarantined") ||
    !hasValidTerminalRecordingRun(repair, "promoted") ||
    !hasRootRecordingLineage(rejectedParent) ||
    !hasRepairRecordingLineage(repair, rejectedParent)
  ) {
    return false;
  }

  const parentPacket = chain.packets[0];
  const repairPacket = chain.packets[1];
  const parentEnvelope = parentPacket?.envelope;
  const repairEnvelope = repairPacket?.envelope;
  const parentReceipt = parentEnvelope?.receipt;
  const repairReceipt = repairEnvelope?.receipt;
  if (
    parentPacket?.schema !== "agent-airlock/portable-evidence-packet" ||
    parentPacket.schemaVersion !== 1 ||
    repairPacket?.schema !== "agent-airlock/portable-evidence-packet" ||
    repairPacket.schemaVersion !== 1 ||
    !parentEnvelope ||
    !repairEnvelope ||
    parentEnvelope.schema !== "agent-airlock/portable-promotion-envelope" ||
    parentEnvelope.schemaVersion !== 1 ||
    repairEnvelope.schema !== "agent-airlock/portable-promotion-envelope" ||
    repairEnvelope.schemaVersion !== 1 ||
    !parentReceipt?.decision ||
    !repairReceipt?.decision ||
    !parentReceipt.state?.before ||
    !parentReceipt.state.after ||
    !repairReceipt.state?.before ||
    !repairReceipt.state.after ||
    !parentReceipt.ancestry ||
    !repairReceipt.ancestry ||
    !sha256Pattern.test(parentEnvelope.receiptDigest) ||
    !sha256Pattern.test(repairEnvelope.receiptDigest)
  ) {
    return false;
  }

  const parentTransaction = rejectedParent.transaction;
  const repairTransaction = repair.transaction;
  const parentLineage = parentTransaction.lineage;
  const repairLineage = repairTransaction.lineage;
  const leafDigestMatches =
    verifiedLeafReceiptDigest !== null &&
    sha256Pattern.test(verifiedLeafReceiptDigest) &&
    verifiedLeafReceiptDigest === repairEnvelope.receiptDigest;

  return (
    parentReceipt.decision.runId === rejectedParent.id &&
    parentReceipt.decision.agentId === rejectedParent.agentId &&
    parentReceipt.decision.disposition === "quarantined" &&
    repairReceipt.decision.runId === repair.id &&
    repairReceipt.decision.agentId === repair.agentId &&
    repairReceipt.decision.disposition === "promoted" &&
    parentReceipt.state.before.stateId ===
      parentTransaction.canonicalStateIdBefore &&
    parentReceipt.state.before.compositeHash ===
      parentTransaction.canonicalContentHashBefore &&
    parentReceipt.state.after.stateId ===
      parentTransaction.canonicalStateIdAfter &&
    parentReceipt.state.after.compositeHash ===
      parentTransaction.canonicalContentHashAfter &&
    repairReceipt.state.before.stateId ===
      repairTransaction.canonicalStateIdBefore &&
    repairReceipt.state.before.compositeHash ===
      repairTransaction.canonicalContentHashBefore &&
    repairReceipt.state.after.stateId ===
      repairTransaction.canonicalStateIdAfter &&
    repairReceipt.state.after.compositeHash ===
      repairTransaction.canonicalContentHashAfter &&
    parentReceipt.ancestry.rootRunId === parentLineage.rootRunId &&
    parentReceipt.ancestry.parentRunId === parentLineage.parentRunId &&
    parentReceipt.ancestry.depth === parentLineage.depth &&
    parentReceipt.ancestry.maxDepth === parentLineage.maxDepth &&
    parentReceipt.ancestry.previousReceiptDigest === null &&
    repairReceipt.ancestry.rootRunId === repairLineage.rootRunId &&
    repairReceipt.ancestry.parentRunId === repairLineage.parentRunId &&
    repairReceipt.ancestry.depth === repairLineage.depth &&
    repairReceipt.ancestry.maxDepth === repairLineage.maxDepth &&
    repairReceipt.ancestry.previousReceiptDigest ===
      parentEnvelope.receiptDigest &&
    repairReceipt.state.before.stateId === parentReceipt.state.after.stateId &&
    repairReceipt.state.before.compositeHash ===
      parentReceipt.state.after.compositeHash &&
    leafDigestMatches
  );
}

export function hasExactRecordingEffect(
  transaction: RunTransaction,
  expectation: RecordingEffectExpectation,
): boolean {
  const intents = transaction.externalActions.intents;
  const intent = intents[0];
  if (
    transaction.externalActions.deliveredCount !== expectation.deliveredCount ||
    intents.length !== 1 ||
    intent?.id !== expectation.id ||
    (expectation.type !== undefined && intent.type !== expectation.type) ||
    intent.status !== expectation.status ||
    !isSafeRecordingIdentifier(intent.idempotencyKey)
  ) {
    return false;
  }

  if (expectation.status === "rejected") {
    return (
      intent.deliveredAt === null &&
      transaction.events.every(
        (event) => event.status !== "promoting" && event.status !== "promoted",
      )
    );
  }

  const promoting = transaction.events.filter(
    (event) => event.status === "promoting",
  );
  const promoted = transaction.events.filter(
    (event) => event.status === "promoted",
  );
  if (promoting.length !== 1 || promoted.length !== 1) return false;

  const promotingAt = Date.parse(promoting[0]!.at);
  const deliveredAt = Date.parse(intent.deliveredAt ?? "");
  const promotedAt = Date.parse(promoted[0]!.at);
  return (
    [promotingAt, deliveredAt, promotedAt].every(Number.isFinite) &&
    promotingAt <= deliveredAt &&
    deliveredAt <= promotedAt
  );
}

export function hasDistinctRepairEffectKey(
  promotion: RunTransaction,
  rejected: RunTransaction,
  repair: RunTransaction,
): boolean {
  const promotionKey = promotion.externalActions.intents[0]?.idempotencyKey;
  const rejectedKey = rejected.externalActions.intents[0]?.idempotencyKey;
  const repairKey = repair.externalActions.intents[0]?.idempotencyKey;
  return (
    isSafeRecordingIdentifier(promotionKey) &&
    isSafeRecordingIdentifier(rejectedKey) &&
    isSafeRecordingIdentifier(repairKey) &&
    repairKey !== promotionKey &&
    repairKey !== rejectedKey
  );
}

export function hasExactFreshRecordingRunIds(
  allRunIds: string[],
  baselineRunIds: string[],
  expectedRunIds: string[],
): boolean {
  const baseline = new Set(baselineRunIds);
  const expected = new Set(expectedRunIds);
  const freshRunIds = allRunIds.filter((runId) => !baseline.has(runId));
  return (
    expected.size === 3 &&
    freshRunIds.length === expected.size &&
    freshRunIds.every((runId) => expected.has(runId))
  );
}

export function parseRecordingReplayRunIds(
  search: string | URLSearchParams,
): RecordingReplaySelection {
  const parameters =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const safeValues = parameters.getAll(
    recordingReplayQueryParameters.safeRunId,
  );
  const unsafeValues = parameters.getAll(
    recordingReplayQueryParameters.unsafeRunId,
  );
  const repairValues = parameters.getAll(
    recordingReplayQueryParameters.repairedRunId,
  );
  const valueGroups = [safeValues, unsafeValues, repairValues];

  if (valueGroups.every((values) => values.length === 0)) {
    return { kind: "absent" };
  }
  if (valueGroups.some((values) => values.length !== 1)) {
    return { kind: "invalid" };
  }

  const runIds: RecordingReplayRunIds = {
    safeRunId: safeValues[0]!,
    unsafeRunId: unsafeValues[0]!,
    repairedRunId: repairValues[0]!,
  };
  const values = Object.values(runIds);
  if (
    !values.every(isSafeRecordingIdentifier) ||
    new Set(values).size !== values.length
  ) {
    return { kind: "invalid" };
  }

  return { kind: "valid", runIds };
}

export function deriveRecordingReplayHydration(
  runs: AgentRun[],
  selection: RecordingReplaySelection,
): RecordingReplayHydration | null {
  if (selection.kind !== "valid") return null;

  const { safeRunId, unsafeRunId, repairedRunId } = selection.runIds;
  const expectedRunIds = new Set([safeRunId, unsafeRunId, repairedRunId]);
  const selectedRuns = runs.filter((run) => expectedRunIds.has(run.id));
  const ordinaryRuns = runs.filter(
    (run) => run.candidateSetId === null && run.competitorId === null,
  );
  if (
    selectedRuns.length !== expectedRunIds.size ||
    ordinaryRuns.length !== expectedRunIds.size ||
    ordinaryRuns.some((run) => !expectedRunIds.has(run.id))
  ) {
    return null;
  }

  const safeCandidate = selectedRuns.find((run) => run.id === safeRunId);
  const unsafeCandidate = selectedRuns.find((run) => run.id === unsafeRunId);
  const repairedCandidate = selectedRuns.find(
    (run) => run.id === repairedRunId,
  );
  if (
    !safeCandidate?.transaction ||
    !unsafeCandidate?.transaction ||
    !repairedCandidate?.transaction
  ) {
    return null;
  }

  const safe = safeCandidate as TerminalRecordingRun;
  const unsafe = unsafeCandidate as TerminalRecordingRun;
  const repaired = repairedCandidate as TerminalRecordingRun;
  const safeCreatedAt = Date.parse(safe.createdAt);
  const unsafeCreatedAt = Date.parse(unsafe.createdAt);
  const repairedCreatedAt = Date.parse(repaired.createdAt);
  const coherent =
    hasValidTerminalRecordingRun(safe, "promoted") &&
    hasValidTerminalRecordingRun(unsafe, "quarantined") &&
    hasValidTerminalRecordingRun(repaired, "promoted") &&
    safe.agentId === unsafe.agentId &&
    safe.agentId === repaired.agentId &&
    hasRootRecordingLineage(safe) &&
    hasRootRecordingLineage(unsafe) &&
    hasRepairRecordingLineage(repaired, unsafe) &&
    advancesCanonicalState(safe.transaction) &&
    advancesCanonicalState(repaired.transaction) &&
    safe.transaction.canonicalStateIdAfter ===
      unsafe.transaction.canonicalStateIdBefore &&
    safe.transaction.canonicalContentHashAfter ===
      unsafe.transaction.canonicalContentHashBefore &&
    unsafe.transaction.canonicalStateIdAfter ===
      unsafe.transaction.canonicalStateIdBefore &&
    unsafe.transaction.canonicalContentHashAfter ===
      unsafe.transaction.canonicalContentHashBefore &&
    unsafe.transaction.canonicalStateIdAfter ===
      repaired.transaction.canonicalStateIdBefore &&
    unsafe.transaction.canonicalContentHashAfter ===
      repaired.transaction.canonicalContentHashBefore &&
    [safeCreatedAt, unsafeCreatedAt, repairedCreatedAt].every(
      Number.isFinite,
    ) &&
    safeCreatedAt < unsafeCreatedAt &&
    unsafeCreatedAt < repairedCreatedAt;
  if (!coherent) return null;

  return {
    agentId: safe.agentId,
    baselineRunIds: runs
      .filter((run) => !expectedRunIds.has(run.id))
      .map((run) => run.id),
    canonicalStateId: safe.transaction.canonicalStateIdBefore,
    repairedRun: repaired,
    runIds: selection.runIds,
  };
}
