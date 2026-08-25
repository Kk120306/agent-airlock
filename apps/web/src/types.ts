export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunTransactionStatus =
  | "preparing"
  | "executing"
  | "validating"
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

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
