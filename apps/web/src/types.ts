export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunTransactionStatus =
  | "preparing"
  | "executing"
  | "validating"
  | "sealed"
  | "promoting"
  | "promoted"
  | "quarantined"
  | "discarded"
  | "recovery-error"
  | "cancelled";

export interface RunLineage {
  rootRunId: string;
  parentRunId: string | null;
  depth: number;
  maxDepth: number;
}

export type PromotionJournalPhase =
  | "validated"
  | "version-installed"
  | "canonical-advanced"
  | "effects-delivered"
  | "completed";

export interface PromotionRecoveryEvidence {
  journalPhase: PromotionJournalPhase | null;
  recoveredAfterRestart: boolean;
  recoveryError: string | null;
}

export interface OutcomeContract {
  schemaVersion: 1;
  version: number;
  requiredPaths: string[];
  protectedPaths: string[];
  maxChangedFiles: number;
  maxAddedBytes: number;
  secretPatterns: Array<{ name: string; pattern: string }>;
  validationCommands: Array<{
    name: string;
    command: string;
    required: boolean;
    timeoutMs: number;
  }>;
  createdAt: string;
}

export type AssuranceOperation =
  | { kind: "add-required-path"; path: string }
  | { kind: "add-protected-path"; path: string }
  | { kind: "lower-max-changed-files"; maximum: number }
  | { kind: "lower-max-added-bytes"; maximum: number }
  | {
      kind: "add-catalog-secret";
      catalogId: string;
      catalogVersion: number;
      name: string;
      pattern: string;
    }
  | {
      kind: "make-command-required";
      name: string;
      commandHash: string;
      timeoutMs: number;
    };

export interface AssuranceProposal {
  schemaVersion: 1;
  id: string;
  agentId: string;
  state: "draft" | "ready" | "accepted" | "rejected" | "superseded" | "stale";
  baseContractVersion: number;
  baseContractHash: string;
  operations: AssuranceOperation[];
  citations: Array<{
    operationKey: string;
    runId: string;
    rootRunId: string;
    evidenceSelector: string;
    evidenceHash: string;
    derivationRule: string;
  }>;
  simulation: {
    engineId: string;
    engineVersion: number;
    results: Array<{
      operationKey: string;
      runId: string;
      classification: "exact" | "conservative" | "unknown";
      priorDisposition: "promoted" | "quarantined" | "discarded" | "cancelled" | null;
      counterfactualDisposition:
        | "promoted"
        | "quarantined"
        | "discarded"
        | "cancelled"
        | null;
      missingInputs: string[];
      resultHash: string;
    }>;
    digest: string;
  };
  proposalDigest: string;
  decision: {
    action: "accepted" | "rejected";
    reason: string;
    decidedAt: string;
    resultingContractVersion: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutcomeContractVersionRecord {
  schemaVersion: 1;
  agentId: string;
  contract: OutcomeContract;
  provenance: "created" | "manual" | "assurance-proposal" | "rollback" | "migration";
  sourceProposalId: string | null;
  rollbackFromVersion: number | null;
}

export interface RunTransaction {
  id: string;
  status: RunTransactionStatus;
  disposition: "promoted" | "quarantined" | "discarded" | "cancelled" | null;
  candidateStateId: string | null;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string | null;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string | null;
  outcomeContractVersion: number;
  outcomeContract: OutcomeContract;
  resources: Array<{
    kind: "workspace" | "codex-session" | "sqlite" | "external-actions";
    label: string;
    disposition: "promoted" | "quarantined" | "discarded" | "cancelled" | null;
    fingerprintBefore: string | null;
    fingerprintAfter: string | null;
    summary: string;
  }>;
  providerResources: Array<{
    schemaVersion: 1;
    providerId: string;
    resourceKind: string;
    label: string;
    required: boolean;
    capabilities: {
      schemaVersion: 1;
      isolation: "candidate-copy" | "provider-branch" | "deferred-intent";
      promotionVisibility:
        | "canonical-manifest"
        | "post-promotion-reconciled"
        | "best-effort";
      promotionIdempotency: "run-keyed" | "none";
      reconciliation: "forward" | "observe-only" | "none";
      quarantine: "retained" | "evidence-only";
      discard: "idempotent" | "best-effort";
      repair: "fork" | "unsupported";
      runtimeAccess: "none" | "read-only" | "read-write";
    };
    source: ProviderVersionReference;
    candidate: {
      candidateId: string;
      candidateFingerprint: string;
    };
    runtimeBinding: {
      relativePath: string;
      access: "read-only" | "read-write";
    } | null;
    change: {
      changed: boolean;
      fingerprintBefore: string;
      fingerprintCandidate: string;
      summary: string;
    } | null;
    validations: Array<{
      name: string;
      status: "passed" | "failed" | "error";
      required: boolean;
      summary: string;
      durationMs: number;
      output: string | null;
    }>;
    promotionPlan: {
      idempotencyKey: string;
      targetVersionId: string;
      targetFingerprint: string;
    } | null;
    installedVersion: ProviderVersionReference | null;
    quarantine: {
      quarantineId: string;
      candidateFingerprint: string;
    } | null;
    disposition: "promoted" | "quarantined" | "discarded" | "cancelled" | null;
    summary: string;
  }>;
  providerResourceEvents: Array<{
    schemaVersion: 1;
    providerId: string;
    resourceKind: string;
    stage:
      | "prepare"
      | "runtime"
      | "describe"
      | "validate"
      | "plan-promotion"
      | "promote"
      | "quarantine"
      | "discard"
      | "reconcile";
    status: "passed" | "failed";
    summary: string;
    at: string;
  }>;
  sqlite: {
    databasePath: ".airlock/demo.sqlite";
    integrity: "passed" | "failed" | "error";
    before: SqliteSnapshot | null;
    candidate: SqliteSnapshot | null;
    after: SqliteSnapshot | null;
  } | null;
  externalActions: {
    outboxPath: string;
    intents: Array<{
      id: string;
      type: "demo.notification.requested";
      destination: string;
      subject: string;
      idempotencyKey: string;
      status: "deferred" | "delivered" | "rejected" | "delivery-error";
      deliveredAt: string | null;
    }>;
    deliveredCount: number;
    bypassDisclosure: string;
  };
  changes: {
    files: Array<{
      path: string;
      kind: "added" | "modified" | "deleted";
      addedBytes: number;
    }>;
    totalChangedFiles: number;
    totalAddedBytes: number;
    truncated: boolean;
  } | null;
  validations: Array<{
    name: string;
    status: "passed" | "failed" | "error";
    required: boolean;
    summary: string;
    durationMs: number;
    output: string | null;
  }>;
  events: Array<{
    status: RunTransactionStatus;
    at: string;
    summary: string;
  }>;
  quarantinePath: string | null;
  quarantineAvailable: boolean;
  discardedAt: string | null;
  lineage: RunLineage;
  recovery: PromotionRecoveryEvidence;
  promotionReceipt: {
    runTransactionId: string;
    disposition: "promoted" | "quarantined" | "discarded" | "cancelled";
    outcomeContractVersion: number;
    canonicalStateIdBefore: string;
    canonicalStateIdAfter: string;
    canonicalContentHashBefore: string;
    canonicalContentHashAfter: string;
    validationEvidenceHash: string;
    lineage: RunLineage;
    createdAt: string;
  } | null;
}

interface ProviderVersionReference {
  versionId: string;
  fingerprint: string;
}

interface SqliteSnapshot {
  contentHash: string;
  rowCount: number;
  rows: Array<{ id: string; value: string; updatedAt: string }>;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  canonicalStateId: string;
  outcomeContract: OutcomeContract;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  candidateSetId: string | null;
  competitorId: string | null;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  transaction: RunTransaction | null;
  createdAt: string;
}

export type SelectionCriterionKind =
  | "quality-assertion"
  | "changed-files"
  | "added-bytes"
  | "latency-ms"
  | "total-tokens";

export interface CandidateScoreComponent {
  kind: SelectionCriterionKind;
  source:
    | "trusted-validation-evaluator"
    | "workspace-change-evidence"
    | "monotonic-execution-measurement"
    | "runtime-usage-response";
  evaluatorVersion: string;
  direction: "maximize" | "minimize";
  maximum: number;
  rawValue: number;
  normalizedValue: number;
}

export interface CandidateScorecardEntry {
  competitorId: string;
  eligible: boolean;
  exclusions: string[];
  components: CandidateScoreComponent[];
  rank: number | null;
}

export interface CandidateSet {
  schemaVersion: 1;
  id: string;
  agentId: string;
  objective: string;
  source: {
    stateId: string;
    contentHash: string;
    codexThreadId: string | null;
  };
  outcomeContract: OutcomeContract;
  competitors: Array<{
    id: string;
    runId: string;
    executorProfileId: string;
    strategyInstruction: string;
    status:
      | "pending"
      | "running"
      | "eligible"
      | "ineligible"
      | "failed"
      | "selected"
      | "promoted"
      | "retained"
      | "discarded"
      | "cancelled";
    criterionValues: Partial<Record<SelectionCriterionKind, number>>;
    exclusions: string[];
    evaluationDurationMs: number | null;
    loserDisposition: "pending" | "retained" | "discarded" | "winner";
    error: string | null;
  }>;
  maxConcurrency: number;
  loserPolicy: "retain" | "discard";
  phase:
    | "admitted"
    | "evaluating"
    | "evaluated"
    | "selected"
    | "promoting"
    | "promoted"
    | "cleaning-losers"
    | "completed"
    | "no-winner"
    | "stale"
    | "recovery-error";
  selectionDecision: {
    winnerCompetitorId: string | null;
    orderedCompetitorIds: string[];
    scorecard: CandidateScorecardEntry[];
    tieBreak: "competitor-id-ascending-byte-order";
    decisionDigest: string;
  } | null;
  selectedCompetitorId: string | null;
  winnerRunId: string | null;
  cancellationRequested: boolean;
  recoveryError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SystemInfo {
  demoMode: boolean;
  protocolFixtureMode: boolean;
  modelArkDemoMode: boolean;
  modelArkPreflight: {
    checkedAt: string;
    generatedAssistantOutput: true;
    attemptCount: number;
    requestCount: number;
    retryDelayMs: number;
  } | null;
  inferenceMode:
    | "deterministic-local-fixture"
    | "local-responses-protocol-fixture"
    | "modelark";
  arkConfigured: boolean;
  modelProfileDisclosure: "configured-status-only";
  codexAvailable: boolean;
  codexSandboxMode: string;
  competingFutures: {
    available: boolean;
    tokenBudgetEnforcement: "provider-boundary" | "unsupported";
    reason: string | null;
  };
  portableTrust: {
    available: boolean;
    receiptSchema: string;
    signatureAlgorithm: "Ed25519";
    verification: "offline-self-contained";
    evidenceDisclosure: "selective-merkle-proof";
    localTransparency: "optional";
    evmPayload: "offline-digest-only";
    networkRequired: false;
  };
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export interface PortablePromotionEnvelope {
  schema: "agent-airlock/portable-promotion-envelope";
  schemaVersion: 1;
  receiptDigest: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
  keyId: string;
  publicJwk: { crv: "Ed25519"; kty: "OKP"; x: string };
  disclosures: Array<{
    leaf: {
      identity: string;
      category: string;
      status: string;
      required: boolean;
      summary: string | null;
    };
  }>;
  receipt: {
    decision: {
      runId: string;
      agentId: string;
      disposition: "promoted" | "quarantined" | "discarded" | "cancelled";
      decidedAt: string;
    };
    validationEvidence: { root: string; leafCount: number };
    selection: { candidateSetId: string; decisionDigest: string } | null;
    assurance: { proposalId: string; contractVersion: number } | null;
    ancestry: {
      rootRunId: string;
      parentRunId: string | null;
      depth: number;
      previousReceiptDigest: string | null;
    };
  };
}

export interface PortableReceiptExport {
  envelope: PortablePromotionEnvelope;
  verification: {
    valid: boolean;
    checks: Array<{ name: string; valid: boolean; detail: string }>;
    commitments: {
      resources: number;
      outcomeContract: boolean;
      validationEvidence: boolean;
      externalActions: boolean;
      selection: boolean;
      assurance: boolean;
      ancestry: boolean;
    };
    provenClaims: string[];
    unsupportedClaims: string[];
  };
  availableDisclosureIdentities: string[];
  availableDisclosures: Array<{
    identity: string;
    category: string;
    status: string;
    required: boolean;
    summary: string | null;
  }>;
  anchor: {
    checkpoint: {
      checkpoint: { treeSize: number; root: string; keyId: string };
      checkpointDigest: string;
    };
    inclusionProof: { leafIndex: number; treeSize: number };
  } | null;
  evmPayload: {
    methodSignature: "anchor(bytes32)";
    functionSelector: string;
    receiptDigest: string;
    calldata: string;
    privacyClaim: "receipt-digest-only";
    networkCalls: 0;
    fundsSpent: 0;
  } | null;
  packet: PortableEvidencePacket;
  decisionChain: PortableDecisionChain | null;
}

export type FederatedAdmissionDecision = "admit" | "reject" | "pending";

export interface FederatedAdmissionPolicySummary {
  policy: {
    schema: "agent-airlock/federated-admission-policy";
    schemaVersion: 1;
    policyId: string;
    generation: number;
    activatedAt: string;
    receiverOrganizationId: string;
    producers: Array<{
      producerId: string;
      disabled: boolean;
      requireLocalApproval: boolean;
    }>;
  };
  policyDigest: string;
}

export interface FederatedAdmissionRecord {
  schema: "agent-airlock/federated-admission-record";
  schemaVersion: 1;
  admissionId: string;
  importIdentifier: string;
  transferId: string;
  producerId: string;
  localAgentId: string;
  candidateRunId: string | null;
  decision: {
    decision: FederatedAdmissionDecision;
    reason: string;
    policyId: string;
    policyGeneration: number;
    policyDigest: string;
    producerId: string;
    receiptDigest: string;
    artifactDigest: string;
    evaluatedAt: string;
    detail: string;
  };
  recordedAt: string;
  recordDigest: string;
}

export interface FederatedImportResult {
  admission: FederatedAdmissionRecord;
  run: AgentRun | null;
}
import type {
  PortableDecisionChain,
  PortableEvidencePacket,
} from "@agent-airlock/portable-promotion-receipt";
