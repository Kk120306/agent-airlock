import { Buffer } from "node:buffer";
import {
  assertPortablePromotionReceipt,
  buildEvidenceCommitment,
  canonicalize,
  digestPortableReceipt,
  sha256Digest,
  type PortableEvidenceDisclosure,
  type PortableEvidenceLeaf,
  type PortablePromotionReceipt,
  type PortableStateCommitment,
  type ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import type {
  AgentRun,
  CandidateSet,
  OutcomeContractVersionRecord,
  RunTransaction,
  ValidationEvidence,
} from "./types.js";
import { replayCandidateSelection, stableJson } from "./candidate-selection.js";
import { promotionValidationEvidenceHash } from "./promotion-receipt-evidence.js";

export interface PortableReceiptDraft {
  receipt: PortablePromotionReceipt;
  receiptDigest: ReceiptDigest;
  disclosures: PortableEvidenceDisclosure[];
}

export function buildPortableReceiptDraft(input: {
  run: AgentRun;
  candidateSet: CandidateSet | null;
  candidateSetRuns: AgentRun[];
  contractVersion: OutcomeContractVersionRecord | null;
  previousReceiptDigest: ReceiptDigest | null;
}): PortableReceiptDraft {
  const transaction = input.run.transaction;
  if (
    !transaction ||
    transaction.assuranceEvidenceVersion !== 1 ||
    !transaction.disposition ||
    !transaction.canonicalStateIdAfter ||
    !transaction.canonicalContentHashAfter ||
    !transaction.promotionReceipt ||
    transaction.status === "recovery-error" ||
    transaction.recovery.recoveryError !== null
  ) {
    throw new Error(
      "Portable receipt export requires complete, versioned, contradiction-free Run Transaction evidence",
    );
  }
  if (transaction.promotionReceipt.runTransactionId !== transaction.id) {
    throw new Error("Portable receipt source contradicts its durable Promotion Receipt");
  }
  assertDurablePromotionReceiptAuthority(transaction);
  assertStrictPortableSourceProjection(transaction);
  assertTerminalPortableSourceMatrix(transaction);
  const before = stateCommitment(transaction, "before");
  const after =
    transaction.disposition === "promoted"
      ? stateCommitment(transaction, "after")
      : structuredClone(before);
  const evidence = buildEvidenceCommitment(validationLeaves(transaction));
  const selection = selectionCommitment(
    input.run,
    input.candidateSet,
    input.candidateSetRuns,
    transaction,
  );
  const assurance = assuranceCommitment(transaction, input.contractVersion);
  const receipt: PortablePromotionReceipt = {
    protocol: {
      schema: "agent-airlock/portable-promotion-receipt",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
    },
    decision: {
      runId: input.run.id,
      agentId: input.run.agentId,
      disposition: transaction.disposition,
      decidedAt: transaction.promotionReceipt.createdAt,
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: { before, after },
    outcomeContract: {
      schemaVersion: transaction.outcomeContract.schemaVersion,
      version: transaction.outcomeContractVersion,
      digest: digestValue(transaction.outcomeContract),
    },
    validationEvidence: {
      root: evidence.root,
      leafCount: evidence.leaves.length,
      ordering: "canonical-identity-ascending",
    },
    externalActions: {
      commitment: externalActionCommitment(transaction),
      deliveredCount: transaction.externalActions.deliveredCount,
    },
    selection,
    assurance,
    ancestry: {
      rootRunId: transaction.lineage.rootRunId,
      parentRunId: transaction.lineage.parentRunId,
      depth: transaction.lineage.depth,
      maxDepth: transaction.lineage.maxDepth,
      previousReceiptDigest: input.previousReceiptDigest,
    },
  };
  assertPortablePromotionReceipt(receipt);
  return {
    receipt,
    receiptDigest: digestPortableReceipt(receipt),
    disclosures: evidence.disclosures,
  };
}

function assertStrictPortableSourceProjection(transaction: RunTransaction): void {
  for (const resource of transaction.resources) {
    assertExactObjectKeys(
      resource as unknown as Record<string, unknown>,
      [
        "kind",
        "label",
        "disposition",
        "fingerprintBefore",
        "fingerprintAfter",
        "summary",
      ],
      "Portable built-in Resource evidence",
    );
  }
  for (const resource of transaction.providerResources) {
    assertExactObjectKeys(
      resource as unknown as Record<string, unknown>,
      [
        "schemaVersion",
        "providerId",
        "resourceKind",
        "label",
        "required",
        "capabilities",
        "source",
        "candidate",
        "runtimeBinding",
        "change",
        "validations",
        "promotionPlan",
        "installedVersion",
        "quarantine",
        "disposition",
        "summary",
      ],
      "Portable provider Resource evidence",
    );
    for (const validation of resource.validations) {
      assertExactObjectKeys(
        validation as unknown as Record<string, unknown>,
        [
          "schemaVersion",
          "providerId",
          "resourceKind",
          "name",
          "status",
          "required",
          "durationMs",
          "summary",
          "output",
        ],
        "Portable provider Validation evidence",
      );
    }
  }
  assertExactObjectKeys(
    transaction.externalActions as unknown as Record<string, unknown>,
    ["outboxPath", "intents", "deliveredCount", "bypassDisclosure"],
    "Portable external-action evidence",
  );
  for (const intent of transaction.externalActions.intents) {
    assertExactObjectKeys(
      intent as unknown as Record<string, unknown>,
      [
        "id",
        "type",
        "destination",
        "subject",
        "idempotencyKey",
        "status",
        "deliveredAt",
      ],
      "Portable external-action intent",
    );
  }
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function assertTerminalPortableSourceMatrix(transaction: RunTransaction): void {
  const resourceByKind = new Map(
    transaction.resources.map((resource) => [resource.kind, resource]),
  );
  const validationByName = new Map(
    transaction.validations.map((validation) => [validation.name, validation]),
  );
  const requiredCoreNames = [
    "path-safety",
    "protected-paths",
    "required-paths",
    "change-limits",
    "secret-patterns",
  ];
  const validationSetIsComplete =
    requiredCoreNames.every(
      (name) => validationByName.get(name)?.required === true,
    ) &&
    transaction.outcomeContract.validationCommands.every(
      (command) =>
        validationByName.get(`command:${command.name}`)?.required ===
        command.required,
    );
  const expectedStatus = {
    promoted: "promoted",
    quarantined: "quarantined",
    discarded: "discarded",
    cancelled: "cancelled",
  }[transaction.disposition!];
  if (
    transaction.status !== expectedStatus ||
    !validationSetIsComplete ||
    transaction.resources.length !== 4 ||
    resourceByKind.size !== 4 ||
    ["workspace", "codex-session", "sqlite", "external-actions"].some(
      (kind) => !resourceByKind.has(kind as RunTransaction["resources"][number]["kind"]),
    ) ||
    transaction.resources.some(
      (resource) =>
        resource.disposition !== transaction.disposition ||
        !resource.fingerprintBefore ||
        !resource.fingerprintAfter ||
        (transaction.disposition !== "promoted" &&
          resource.fingerprintAfter !== resource.fingerprintBefore),
    ) ||
    transaction.providerResources.some(
      (resource) =>
        resource.disposition !== transaction.disposition ||
        (transaction.disposition === "promoted" && !resource.installedVersion) ||
        resource.validations.some(
          (validation) =>
            transaction.disposition === "promoted" &&
            validation.required &&
            validation.status !== "passed",
        ),
    ) ||
    new Set(
      transaction.providerResources.map(
        (resource) => `${resource.providerId}\u0000${resource.resourceKind}`,
      ),
    ).size !== transaction.providerResources.length ||
    (transaction.disposition === "promoted" &&
      transaction.validations.some(
        (validation) => validation.required && validation.status !== "passed",
      ))
  ) {
    throw new Error("Portable receipt source has an invalid terminal evidence matrix");
  }
  const delivered = transaction.externalActions.intents.filter(
    (intent) => intent.status === "delivered",
  );
  const externalActions = resourceByKind.get("external-actions");
  if (
    delivered.length !== transaction.externalActions.deliveredCount ||
    externalActions?.fingerprintBefore !== externalActionEvidenceFingerprint([]) ||
    externalActions.fingerprintAfter !==
      (transaction.disposition === "promoted"
        ? externalActionEvidenceFingerprint(delivered)
        : externalActions.fingerprintBefore) ||
    new Set(
      transaction.externalActions.intents.map((intent) => intent.idempotencyKey),
    ).size !== transaction.externalActions.intents.length ||
    transaction.externalActions.intents.some(
      (intent) =>
        (intent.status === "delivered") !== (intent.deliveredAt !== null) ||
        (transaction.disposition === "promoted"
          ? intent.status !== "delivered"
          : intent.status === "delivered"),
    )
  ) {
    throw new Error("Portable receipt source has contradictory external-action evidence");
  }
}

function externalActionEvidenceFingerprint(
  intents: Array<{ idempotencyKey: string; deliveredAt: string | null }>,
): string {
  const normalized = intents
    .map((intent) => ({
      idempotencyKey: intent.idempotencyKey,
      deliveredAt: intent.deliveredAt,
    }))
    .sort((left, right) =>
      left.idempotencyKey.localeCompare(right.idempotencyKey),
    );
  return sha256Digest(Buffer.from(JSON.stringify(normalized), "utf8"));
}

function assertDurablePromotionReceiptAuthority(
  transaction: RunTransaction,
): void {
  const receipt = transaction.promotionReceipt;
  if (!receipt) {
    throw new Error("Portable receipt source has no durable Promotion Receipt");
  }
  const expectedValidationEvidenceHash = promotionValidationEvidenceHash(
    transaction,
  );
  const sameLineage = canonicalize(receipt.lineage) === canonicalize(transaction.lineage);
  const authoritativeFieldsAgree =
    receipt.runTransactionId === transaction.id &&
    receipt.disposition === transaction.disposition &&
    receipt.outcomeContractVersion === transaction.outcomeContractVersion &&
    receipt.canonicalStateIdBefore === transaction.canonicalStateIdBefore &&
    receipt.canonicalStateIdAfter === transaction.canonicalStateIdAfter &&
    receipt.canonicalContentHashBefore === transaction.canonicalContentHashBefore &&
    receipt.canonicalContentHashAfter === transaction.canonicalContentHashAfter &&
    normalizeDigest(receipt.validationEvidenceHash, "Validation evidence") ===
      expectedValidationEvidenceHash &&
    sameLineage;
  const nonPromotionPreservedState =
    transaction.disposition === "promoted" ||
    (transaction.canonicalStateIdAfter === transaction.canonicalStateIdBefore &&
      transaction.canonicalContentHashAfter ===
        transaction.canonicalContentHashBefore);
  if (!authoritativeFieldsAgree || !nonPromotionPreservedState) {
    throw new Error("Portable receipt source contradicts its durable Promotion Receipt");
  }
}

function selectionCommitment(
  run: AgentRun,
  candidateSet: CandidateSet | null,
  candidateSetRuns: AgentRun[],
  transaction: RunTransaction,
): PortablePromotionReceipt["selection"] {
  if (!run.candidateSetId) return null;
  if (!candidateSet || candidateSet.id !== run.candidateSetId) {
    throw new Error("Portable receipt export is missing its Candidate Set evidence");
  }
  if (candidateSet.winnerRunId !== run.id) {
    throw new Error("Portable receipt Candidate Run is not the persisted winner");
  }
  const winner = candidateSet.competitors.find(
    (competitor) => competitor.runId === run.id,
  );
  const replayed = replayCandidateSelection(
    candidateSet,
    new Map(candidateSetRuns.map((candidateRun) => [candidateRun.id, candidateRun])),
  );
  if (
    candidateSet.phase !== "completed" ||
    !candidateSet.selectionDecision ||
    stableJson(replayed) !== stableJson(candidateSet.selectionDecision) ||
    candidateSet.selectedCompetitorId !==
      candidateSet.selectionDecision.winnerCompetitorId ||
    !winner?.seal ||
    winner.id !== candidateSet.selectedCompetitorId ||
    winner.seal.schemaVersion !== 1 ||
    winner.seal.candidateSetId !== candidateSet.id ||
    winner.seal.competitorId !== winner.id ||
    winner.seal.runId !== run.id ||
    winner.seal.candidateStateId !== transaction.candidateStateId ||
    winner.seal.sourceStateId !== candidateSet.source.stateId ||
    winner.seal.sourceContentHash !== candidateSet.source.contentHash ||
    winner.seal.outcomeContractVersion !== transaction.outcomeContractVersion ||
    winner.seal.sealDigest !== sealDigest(winner.seal) ||
    run.output === null ||
    winner.seal.runtimeResultHash !==
      evidenceDigest({
        output: run.output,
        threadId: winner.resultThreadId,
        usage: run.usage,
      }) ||
    candidateSet.source.stateId !== transaction.canonicalStateIdBefore ||
    candidateSet.source.contentHash !== transaction.canonicalContentHashBefore ||
    candidateSet.outcomeContract.version !== transaction.outcomeContractVersion
  ) {
    throw new Error(
      "Portable receipt export found contradictory Candidate Selection evidence",
    );
  }
  return {
    candidateSetId: candidateSet.id,
    decisionDigest: normalizeDigest(
      candidateSet.selectionDecision.decisionDigest,
      "Selection Decision",
    ),
  };
}

function sealDigest(
  seal: NonNullable<CandidateSet["competitors"][number]["seal"]>,
): string {
  return evidenceDigest({
    schemaVersion: seal.schemaVersion,
    candidateSetId: seal.candidateSetId,
    competitorId: seal.competitorId,
    runId: seal.runId,
    candidateStateId: seal.candidateStateId,
    sourceStateId: seal.sourceStateId,
    sourceContentHash: seal.sourceContentHash,
    outcomeContractVersion: seal.outcomeContractVersion,
    transactionEvidenceHash: seal.transactionEvidenceHash,
    runtimeResultHash: seal.runtimeResultHash,
    sealedAt: seal.sealedAt,
  });
}

function evidenceDigest(value: unknown): string {
  return sha256Digest(Buffer.from(stableJson(value), "utf8"));
}

function assuranceCommitment(
  transaction: RunTransaction,
  contractVersion: OutcomeContractVersionRecord | null,
): PortablePromotionReceipt["assurance"] {
  if (!contractVersion?.sourceProposalId) return null;
  if (
    contractVersion.provenance !== "assurance-proposal" ||
    contractVersion.contract.version !== transaction.outcomeContractVersion ||
    canonicalize(contractVersion.contract) !==
      canonicalize(transaction.outcomeContract)
  ) {
    throw new Error(
      "Portable receipt export found contradictory Assurance provenance",
    );
  }
  return {
    proposalId: contractVersion.sourceProposalId,
    contractVersion: transaction.outcomeContractVersion,
  };
}

function stateCommitment(
  transaction: RunTransaction,
  side: "before" | "after",
): PortableStateCommitment {
  const promoted = side === "after";
  const builtinResources = transaction.resources
    .map((resource) => ({
      kind: resource.kind,
      fingerprint: normalizeDigest(
        promoted ? resource.fingerprintAfter : resource.fingerprintBefore,
        `${side} ${resource.kind} fingerprint`,
      ),
    }))
    .sort((left, right) => compareUtf8(left.kind, right.kind));
  const providerResources = transaction.providerResources
    .map((resource) => {
      const version = promoted ? resource.installedVersion : resource.source;
      if (!version) {
        throw new Error(
          `Portable receipt export is missing the ${side} version for provider ${resource.providerId}`,
        );
      }
      return {
        providerId: resource.providerId,
        resourceKind: resource.resourceKind,
        versionId: version.versionId,
        fingerprint: normalizeDigest(
          version.fingerprint,
          `${side} provider fingerprint`,
        ),
      };
    })
    .sort((left, right) =>
      compareUtf8(
        `${left.providerId}\u0000${left.resourceKind}`,
        `${right.providerId}\u0000${right.resourceKind}`,
      ),
    );
  return {
    stateId: promoted
      ? transaction.canonicalStateIdAfter!
      : transaction.canonicalStateIdBefore,
    compositeHash: normalizeDigest(
      promoted
        ? transaction.canonicalContentHashAfter
        : transaction.canonicalContentHashBefore,
      `${side} Canonical State`,
    ),
    builtinResources,
    providerResources,
  };
}

function validationLeaves(transaction: RunTransaction): PortableEvidenceLeaf[] {
  const core = transaction.validations.map((validation) =>
    validationLeaf("core", validation),
  );
  const providers = transaction.providerResources.flatMap((resource) =>
    resource.validations.map((validation) =>
      validationLeaf(`provider:${resource.providerId}`, validation),
    ),
  );
  return [...core, ...providers];
}

function validationLeaf(
  scope: string,
  validation: ValidationEvidence | RunTransaction["providerResources"][number]["validations"][number],
): PortableEvidenceLeaf {
  return {
    schemaVersion: 1,
    identity: `validation:${sha256Digest(Buffer.from(`${scope}\u0000${validation.name}`, "utf8")).slice("sha256:".length)}`,
    category: "validation",
    status: validation.status,
    required: validation.required,
    durationMs: validation.durationMs,
    summary: `Trusted Validation reported ${validation.status}.`,
    valueHash: digestValue(validation),
  };
}

function externalActionCommitment(transaction: RunTransaction): ReceiptDigest {
  const publicIntents = transaction.externalActions.intents
    .map((intent) => ({
      id: intent.id,
      type: intent.type,
      idempotencyKey: intent.idempotencyKey,
      status: intent.status,
      deliveredAt: intent.deliveredAt,
    }))
    .sort((left, right) => compareUtf8(left.idempotencyKey, right.idempotencyKey));
  return digestValue({
    intents: publicIntents,
    deliveredCount: transaction.externalActions.deliveredCount,
  });
}

function digestValue(value: unknown): ReceiptDigest {
  return sha256Digest(Buffer.from(canonicalize(value), "utf8"));
}

function normalizeDigest(value: string | null, name: string): ReceiptDigest {
  if (!value) throw new Error(`Portable receipt export is missing ${name}`);
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value as ReceiptDigest;
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  throw new Error(`Portable receipt export has an invalid ${name}`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
