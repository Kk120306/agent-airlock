import type {
  ResourceCandidateHandle,
  ResourceCapabilityClaim,
  ResourceChangeEvidence,
  ResourceLifecycleStage,
  ResourcePromotionPlan,
  ResourceQuarantineHandle,
  ResourceRuntimeBinding,
  ResourceValidationEvidence,
  ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
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
export type RunTransactionDisposition =
  | "promoted"
  | "quarantined"
  | "discarded"
  | "cancelled";
export type ValidationStatus = "passed" | "failed" | "error";
export type TransactionResourceKind =
  | "workspace"
  | "codex-session"
  | "sqlite"
  | "external-actions";

export interface CanonicalStateReference {
  stateId: string;
  workspacePath: string;
  codexHomePath: string;
  outboxPath: string;
  codexThreadId: string | null;
  workspaceContentHash: string;
  sessionContentHash: string;
  sqliteContentHash: string;
  outboxContentHash: string;
  providerVersions: ResourceVersionReference[];
  contentHash: string;
}

export interface SecretPattern {
  name: string;
  pattern: string;
}

export interface ValidationCommand {
  name: string;
  command: string;
  required: boolean;
  timeoutMs: number;
}

export interface OutcomeContract {
  schemaVersion: 1;
  version: number;
  requiredPaths: string[];
  protectedPaths: string[];
  maxChangedFiles: number;
  maxAddedBytes: number;
  secretPatterns: SecretPattern[];
  validationCommands: ValidationCommand[];
  createdAt: string;
}

export type OutcomeContractInput = Omit<
  OutcomeContract,
  "schemaVersion" | "version" | "createdAt"
>;

export interface RunTransactionEvent {
  status: RunTransactionStatus;
  at: string;
  summary: string;
}

export interface ValidationEvidence {
  name: string;
  status: ValidationStatus;
  required: boolean;
  summary: string;
  durationMs: number;
  output: string | null;
}

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

export interface PromotionReceipt {
  runTransactionId: string;
  disposition: RunTransactionDisposition;
  outcomeContractVersion: number;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string;
  validationEvidenceHash: string;
  lineage: RunLineage;
  createdAt: string;
}

export interface WorkspaceChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  addedBytes: number;
}

export interface WorkspaceChangeSummary {
  files: WorkspaceChange[];
  totalChangedFiles: number;
  totalAddedBytes: number;
  truncated: boolean;
}

export interface TransactionResourceEvidence {
  kind: TransactionResourceKind;
  label: string;
  disposition: RunTransactionDisposition | null;
  fingerprintBefore: string | null;
  fingerprintAfter: string | null;
  summary: string;
}

export interface ProviderResourceEvidence {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  label: string;
  required: boolean;
  capabilities: ResourceCapabilityClaim;
  source: ResourceVersionReference;
  candidate: ResourceCandidateHandle;
  runtimeBinding: ResourceRuntimeBinding | null;
  change: ResourceChangeEvidence | null;
  validations: ResourceValidationEvidence[];
  promotionPlan: ResourcePromotionPlan | null;
  installedVersion: ResourceVersionReference | null;
  quarantine: ResourceQuarantineHandle | null;
  disposition: RunTransactionDisposition | null;
  summary: string;
}

export interface ProviderResourceLifecycleEvent {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  stage: ResourceLifecycleStage;
  status: "passed" | "failed";
  summary: string;
  at: string;
}

export interface SqliteSnapshot {
  contentHash: string;
  rowCount: number;
  rows: Array<{
    id: string;
    value: string;
    updatedAt: string;
  }>;
}

export interface SqliteResourceEvidence {
  databasePath: ".airlock/demo.sqlite";
  integrity: "passed" | "failed" | "error";
  before: SqliteSnapshot | null;
  candidate: SqliteSnapshot | null;
  after: SqliteSnapshot | null;
}

export type ExternalActionIntentStatus =
  | "deferred"
  | "delivered"
  | "rejected"
  | "delivery-error";

export interface ExternalActionIntentEvidence {
  id: string;
  type: "demo.notification.requested";
  destination: string;
  subject: string;
  idempotencyKey: string;
  status: ExternalActionIntentStatus;
  deliveredAt: string | null;
}

export interface ExternalActionEvidence {
  outboxPath: string;
  intents: ExternalActionIntentEvidence[];
  deliveredCount: number;
  bypassDisclosure: string;
}

export interface RunTransaction {
  id: string;
  status: RunTransactionStatus;
  disposition: RunTransactionDisposition | null;
  candidateStateId: string | null;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string | null;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string | null;
  outcomeContractVersion: number;
  outcomeContract: OutcomeContract;
  resources: TransactionResourceEvidence[];
  providerResources: ProviderResourceEvidence[];
  providerResourceEvents: ProviderResourceLifecycleEvent[];
  sqlite: SqliteResourceEvidence | null;
  externalActions: ExternalActionEvidence;
  changes: WorkspaceChangeSummary | null;
  validations: ValidationEvidence[];
  events: RunTransactionEvent[];
  quarantinePath: string | null;
  quarantineAvailable: boolean;
  discardedAt: string | null;
  lineage: RunLineage;
  recovery: PromotionRecoveryEvidence;
  promotionReceipt: PromotionReceipt | null;
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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  transaction: RunTransaction | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 8;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  codexHomePath: string;
  outboxPath: string;
  repairReferencePath?: string | null;
  resourceBindings?: RunnerResourceBinding[];
  prompt: string;
  threadId: string | null;
}

export interface RunnerResourceBinding {
  providerId: string;
  hostPath: string;
  runtimePath: string;
  access: "read-only" | "read-write";
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
