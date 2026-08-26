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
  inferenceMode: "deterministic-local-fixture" | "modelark";
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  competingFutures: {
    available: boolean;
    tokenBudgetEnforcement: "provider-boundary" | "unsupported";
    reason: string | null;
  };
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
