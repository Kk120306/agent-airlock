import type {
  PortableDecisionChain,
  ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import type { AgentRun, RunTransaction } from "./types";

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const recordingOutcomeContractKeys = [
  "createdAt",
  "maxAddedBytes",
  "maxChangedFiles",
  "protectedPaths",
  "requiredPaths",
  "schemaVersion",
  "secretPatterns",
  "validationCommands",
  "version",
] as const;
const recordingValidationCommandKeys = [
  "command",
  "name",
  "required",
  "timeoutMs",
] as const;
const recordingProtocolValidationCommand = [
  'test "$(cat protocol-proof.txt)" = candidate-only',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
].join(" && ");
const canonicalAdvanceEventSummary =
  "Canonical State advanced before external action delivery";

type TerminalRecordingRun = AgentRun & { transaction: RunTransaction };

export type ExactRecordingRunSet = {
  safe: TerminalRecordingRun;
  unsafe: TerminalRecordingRun;
  repaired: TerminalRecordingRun;
  safeRequired: { passed: number; total: number };
  unsafeRequired: { passed: number; total: number };
  repairedRequired: { passed: number; total: number };
};

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
    Array.isArray(transaction.resources) &&
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

function hasExactRecordingReceipt(
  run: TerminalRecordingRun,
  disposition: "promoted" | "quarantined",
): boolean {
  const transaction = run.transaction;
  const receipt = transaction.promotionReceipt;
  if (!receipt || !receipt.lineage || !transaction.lineage) return false;
  return (
    transaction.id === run.id &&
    Number.isSafeInteger(transaction.outcomeContractVersion) &&
    transaction.outcomeContractVersion > 0 &&
    receipt.runTransactionId === transaction.id &&
    receipt.disposition === disposition &&
    receipt.outcomeContractVersion === transaction.outcomeContractVersion &&
    receipt.canonicalStateIdBefore === transaction.canonicalStateIdBefore &&
    receipt.canonicalStateIdAfter === transaction.canonicalStateIdAfter &&
    receipt.canonicalContentHashBefore ===
      transaction.canonicalContentHashBefore &&
    receipt.canonicalContentHashAfter === transaction.canonicalContentHashAfter &&
    sha256Pattern.test(receipt.validationEvidenceHash) &&
    receipt.lineage.rootRunId === transaction.lineage.rootRunId &&
    receipt.lineage.parentRunId === transaction.lineage.parentRunId &&
    receipt.lineage.depth === transaction.lineage.depth &&
    receipt.lineage.maxDepth === transaction.lineage.maxDepth &&
    Number.isFinite(Date.parse(receipt.createdAt))
  );
}

export function hasRootRecordingLineage(run: TerminalRecordingRun): boolean {
  const lineage = run.transaction.lineage;
  return (
    lineage?.rootRunId === run.id &&
    lineage.parentRunId === null &&
    lineage.depth === 0
  );
}

export function hasRepairRecordingLineage(
  repair: TerminalRecordingRun,
  rejectedParent: TerminalRecordingRun,
): boolean {
  const lineage = repair.transaction.lineage;
  return (
    lineage?.rootRunId === rejectedParent.id &&
    lineage.parentRunId === rejectedParent.id &&
    lineage.depth === 1
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
  const intents = transaction.externalActions?.intents;
  if (!Array.isArray(intents) || !Array.isArray(transaction.events)) {
    return false;
  }
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
  const canonicalAdvance = promoting.filter(
    (event) => event.summary === canonicalAdvanceEventSummary,
  );
  const promotionStarted = promoting.filter(
    (event) => event.summary !== canonicalAdvanceEventSummary,
  );
  const promoted = transaction.events.filter(
    (event) => event.status === "promoted",
  );
  if (
    promoting.length !== 2 ||
    promotionStarted.length !== 1 ||
    canonicalAdvance.length !== 1 ||
    promoted.length !== 1
  ) {
    return false;
  }

  const promotingAt = Date.parse(promotionStarted[0]!.at);
  const canonicalAdvanceAt = Date.parse(canonicalAdvance[0]!.at);
  const deliveredAt = Date.parse(intent.deliveredAt ?? "");
  const promotedAt = Date.parse(promoted[0]!.at);
  return (
    [promotingAt, canonicalAdvanceAt, deliveredAt, promotedAt].every(
      Number.isFinite,
    ) &&
    promotingAt <= canonicalAdvanceAt &&
    canonicalAdvanceAt <= deliveredAt &&
    deliveredAt <= promotedAt
  );
}

export function hasDistinctRepairEffectKey(
  promotion: RunTransaction,
  rejected: RunTransaction,
  repair: RunTransaction,
): boolean {
  const promotionKey =
    promotion.externalActions?.intents?.[0]?.idempotencyKey;
  const rejectedKey = rejected.externalActions?.intents?.[0]?.idempotencyKey;
  const repairKey = repair.externalActions?.intents?.[0]?.idempotencyKey;
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

function requiredValidationResult(
  transaction: RunTransaction,
): { passed: number; total: number } | null {
  if (!Array.isArray(transaction.validations)) return null;
  const required = transaction.validations.filter(
    (validation) => validation?.required === true,
  );
  return {
    passed: required.filter((validation) => validation.status === "passed")
      .length,
    total: required.length,
  };
}

function hasExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function hasExactRecordingOutcomeContract(
  transaction: RunTransaction,
): boolean {
  const contract: unknown = transaction.outcomeContract;
  if (
    !hasExactObjectKeys(contract, recordingOutcomeContractKeys) ||
    contract.schemaVersion !== 1 ||
    !Number.isSafeInteger(contract.version) ||
    contract.version !== transaction.outcomeContractVersion ||
    typeof contract.createdAt !== "string" ||
    contract.createdAt.length !== 24 ||
    !Number.isFinite(Date.parse(contract.createdAt)) ||
    new Date(contract.createdAt).toISOString() !== contract.createdAt ||
    !Array.isArray(contract.requiredPaths) ||
    contract.requiredPaths.length !== 2 ||
    contract.requiredPaths[0] !== "AGENTS.md" ||
    contract.requiredPaths[1] !== "protocol-proof.txt" ||
    !Array.isArray(contract.protectedPaths) ||
    contract.protectedPaths.length !== 1 ||
    contract.protectedPaths[0] !== "AGENTS.md" ||
    contract.maxChangedFiles !== 4 ||
    contract.maxAddedBytes !== 65_536 ||
    !Array.isArray(contract.secretPatterns) ||
    contract.secretPatterns.length !== 0 ||
    !Array.isArray(contract.validationCommands) ||
    contract.validationCommands.length !== 1
  ) {
    return false;
  }

  const command = contract.validationCommands[0];
  return (
    hasExactObjectKeys(command, recordingValidationCommandKeys) &&
    command.name === "protocol-content" &&
    command.command === recordingProtocolValidationCommand &&
    command.required === true &&
    command.timeoutMs === 10_000
  );
}

function hasExactProtocolProofChange(transaction: RunTransaction): boolean {
  const files = transaction.changes?.files;
  return (
    Array.isArray(files) &&
    files.filter((change) => change?.path === "protocol-proof.txt").length === 1
  );
}

function hasExactRequiredProtocolValidation(
  transaction: RunTransaction,
  status: "passed" | "failed",
): boolean {
  if (!Array.isArray(transaction.validations)) return false;
  const matching = transaction.validations.filter(
    (validation) => validation?.name === "command:protocol-content",
  );
  return (
    matching.length === 1 &&
    matching[0]?.required === true &&
    matching[0]?.status === status
  );
}

export function deriveExactRecordingRunSet({
  runs,
  runIds,
  expectedAgentId,
  expectedCanonicalStateId,
}: {
  runs: AgentRun[];
  runIds: RecordingReplayRunIds;
  expectedAgentId?: string;
  expectedCanonicalStateId?: string;
}): ExactRecordingRunSet | null {
  const expectedRunIds = new Set([
    runIds.safeRunId,
    runIds.unsafeRunId,
    runIds.repairedRunId,
  ]);
  if (expectedRunIds.size !== 3) return null;

  const selectedRuns = runs.filter((run) => expectedRunIds.has(run.id));
  if (selectedRuns.length !== expectedRunIds.size) return null;
  const safeCandidate = selectedRuns.find((run) => run.id === runIds.safeRunId);
  const unsafeCandidate = selectedRuns.find(
    (run) => run.id === runIds.unsafeRunId,
  );
  const repairedCandidate = selectedRuns.find(
    (run) => run.id === runIds.repairedRunId,
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
  const safeRequired = requiredValidationResult(safe.transaction);
  const unsafeRequired = requiredValidationResult(unsafe.transaction);
  const repairedRequired = requiredValidationResult(repaired.transaction);
  if (!safeRequired || !unsafeRequired || !repairedRequired) return null;

  const contractIdentity = JSON.stringify(safe.transaction.outcomeContract);

  const safeSqliteCandidate = safe.transaction.sqlite?.candidate?.rows?.find(
    (row) => row?.id === "demo",
  );
  const safeSqliteAfter = safe.transaction.sqlite?.after?.rows?.find(
    (row) => row?.id === "demo",
  );
  const unsafeSqliteCandidate = unsafe.transaction.sqlite?.candidate?.rows?.find(
    (row) => row?.id === "demo",
  );
  const unsafeSqliteAfter = unsafe.transaction.sqlite?.after?.rows?.find(
    (row) => row?.id === "demo",
  );
  const repairedSqliteCandidate =
    repaired.transaction.sqlite?.candidate?.rows?.find(
      (row) => row?.id === "demo",
    );
  const repairedSqliteAfter = repaired.transaction.sqlite?.after?.rows?.find(
    (row) => row?.id === "demo",
  );
  const safeCreatedAt = Date.parse(safe.createdAt);
  const unsafeCreatedAt = Date.parse(unsafe.createdAt);
  const repairedCreatedAt = Date.parse(repaired.createdAt);

  const exact =
    [safe, unsafe, repaired].every(
      (run) =>
        run.status === "completed" &&
        run.candidateSetId === null &&
        run.competitorId === null,
    ) &&
    (expectedAgentId === undefined || safe.agentId === expectedAgentId) &&
    safe.agentId === unsafe.agentId &&
    safe.agentId === repaired.agentId &&
    (expectedCanonicalStateId === undefined ||
      safe.transaction.canonicalStateIdBefore === expectedCanonicalStateId) &&
    hasValidTerminalRecordingRun(safe, "promoted") &&
    hasValidTerminalRecordingRun(unsafe, "quarantined") &&
    hasValidTerminalRecordingRun(repaired, "promoted") &&
    hasExactRecordingReceipt(safe, "promoted") &&
    hasExactRecordingReceipt(unsafe, "quarantined") &&
    hasExactRecordingReceipt(repaired, "promoted") &&
    hasExactRecordingOutcomeContract(safe.transaction) &&
    hasExactRecordingOutcomeContract(unsafe.transaction) &&
    hasExactRecordingOutcomeContract(repaired.transaction) &&
    [safeCreatedAt, unsafeCreatedAt, repairedCreatedAt].every(
      Number.isFinite,
    ) &&
    safeCreatedAt < unsafeCreatedAt &&
    unsafeCreatedAt < repairedCreatedAt &&
    hasRootRecordingLineage(safe) &&
    advancesCanonicalState(safe.transaction) &&
    safeRequired.total > 0 &&
    safeRequired.passed === safeRequired.total &&
    hasExactRequiredProtocolValidation(safe.transaction, "passed") &&
    hasRootRecordingLineage(unsafe) &&
    hasExactRequiredProtocolValidation(unsafe.transaction, "failed") &&
    hasRepairRecordingLineage(repaired, unsafe) &&
    advancesCanonicalState(repaired.transaction) &&
    repairedRequired.total > 0 &&
    repairedRequired.passed === repairedRequired.total &&
    hasExactRequiredProtocolValidation(repaired.transaction, "passed") &&
    safe.transaction.outcomeContractVersion ===
      unsafe.transaction.outcomeContractVersion &&
    safe.transaction.outcomeContractVersion ===
      repaired.transaction.outcomeContractVersion &&
    JSON.stringify(unsafe.transaction.outcomeContract) === contractIdentity &&
    JSON.stringify(repaired.transaction.outcomeContract) === contractIdentity &&
    hasExactRecordingResources(safe.transaction, "promoted") &&
    hasExactRecordingResources(unsafe.transaction, "quarantined") &&
    hasExactRecordingResources(repaired.transaction, "promoted") &&
    hasExactProtocolProofChange(safe.transaction) &&
    hasExactProtocolProofChange(unsafe.transaction) &&
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
    hasExactRecordingEffect(safe.transaction, {
      id: "protocol-release-ready",
      type: "demo.notification.requested",
      status: "delivered",
      deliveredCount: 1,
    }) &&
    safe.transaction.recovery?.journalPhase === "completed" &&
    safeSqliteCandidate?.value === "candidate-only" &&
    safeSqliteAfter?.value === "candidate-only" &&
    hasExactRecordingEffect(unsafe.transaction, {
      id: "protocol-unsafe",
      type: "demo.notification.requested",
      status: "rejected",
      deliveredCount: 0,
    }) &&
    unsafeSqliteCandidate?.value === "unsafe-candidate" &&
    unsafeSqliteAfter?.value === "candidate-only" &&
    hasExactRecordingEffect(repaired.transaction, {
      id: "protocol-repair-ready",
      type: "demo.notification.requested",
      status: "delivered",
      deliveredCount: 1,
    }) &&
    repaired.transaction.recovery?.journalPhase === "completed" &&
    repairedSqliteCandidate?.value === "candidate-only" &&
    repairedSqliteAfter?.value === "candidate-only" &&
    hasDistinctRepairEffectKey(
      safe.transaction,
      unsafe.transaction,
      repaired.transaction,
    );

  return exact
    ? { safe, unsafe, repaired, safeRequired, unsafeRequired, repairedRequired }
    : null;
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

  const exactRunSet = deriveExactRecordingRunSet({
    runs: selectedRuns,
    runIds: selection.runIds,
  });
  if (!exactRunSet) return null;

  return {
    agentId: exactRunSet.safe.agentId,
    baselineRunIds: runs
      .filter((run) => !expectedRunIds.has(run.id))
      .map((run) => run.id),
    canonicalStateId: exactRunSet.safe.transaction.canonicalStateIdBefore,
    repairedRun: exactRunSet.repaired,
    runIds: selection.runIds,
  };
}
