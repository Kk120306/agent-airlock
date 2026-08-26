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
  | "sealed"
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
  candidateSetId: string | null;
  competitorId: string | null;
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

export type CandidateSetPhase =
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

export type CandidateCompetitorStatus =
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

export type SelectionCriterionKind =
  | "quality-assertion"
  | "changed-files"
  | "added-bytes"
  | "latency-ms"
  | "total-tokens";

export type SelectionCriterionSource =
  | "trusted-validation-evaluator"
  | "workspace-change-evidence"
  | "monotonic-execution-measurement"
  | "runtime-usage-response";

export interface SelectionCriterion {
  kind: SelectionCriterionKind;
  source: SelectionCriterionSource;
  direction: "maximize" | "minimize";
  maximum: number;
  evaluatorVersion: string;
}

export interface SelectionContract {
  schemaVersion: 1;
  criteria: SelectionCriterion[];
}

export interface CandidateSetBudget {
  maxDurationMsPerCompetitor: number;
  maxTotalTokens: number;
  maxTotalChangedBytes: number;
}

export interface CandidateSetSource {
  stateId: string;
  contentHash: string;
  workspaceContentHash: string;
  sessionContentHash: string;
  sqliteContentHash: string;
  outboxContentHash: string;
  codexThreadId: string | null;
  providerVersions: ResourceVersionReference[];
}

export interface SealedCandidateReference {
  schemaVersion: 1;
  candidateSetId: string;
  competitorId: string;
  runId: string;
  candidateStateId: string;
  sourceStateId: string;
  sourceContentHash: string;
  outcomeContractVersion: number;
  transactionEvidenceHash: string;
  runtimeResultHash: string;
  sealDigest: string;
  sealedAt: string;
}

export interface CandidateScoreComponent {
  kind: SelectionCriterionKind;
  source: SelectionCriterionSource;
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

export interface CandidateSelectionDecision {
  schemaVersion: 1;
  candidateSetId: string;
  sourceStateId: string;
  orderedCompetitorIds: string[];
  winnerCompetitorId: string | null;
  scorecard: CandidateScorecardEntry[];
  tieBreak: "competitor-id-ascending-byte-order";
  decisionDigest: string;
}

export interface CandidateSetCompetitor {
  id: string;
  runId: string;
  executorProfileId: string;
  strategyInstruction: string;
  status: CandidateCompetitorStatus;
  criterionValues: Partial<Record<SelectionCriterionKind, number>>;
  exclusions: string[];
  evaluationDurationMs: number | null;
  resultThreadId: string | null;
  seal: SealedCandidateReference | null;
  loserDisposition: "pending" | "retained" | "discarded" | "winner";
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CandidateSet {
  schemaVersion: 1;
  id: string;
  agentId: string;
  objective: string;
  source: CandidateSetSource;
  outcomeContract: OutcomeContract;
  selectionContract: SelectionContract;
  competitors: CandidateSetCompetitor[];
  maxConcurrency: number;
  budget: CandidateSetBudget;
  loserPolicy: "retain" | "discard";
  phase: CandidateSetPhase;
  selectionDecision: CandidateSelectionDecision | null;
  selectedCompetitorId: string | null;
  winnerRunId: string | null;
  cancellationRequested: boolean;
  recoveryError: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  completedAt: string | null;
}

export interface CandidateSetCompetitorInput {
  id: string;
  executorProfileId: string;
  strategyInstruction: string;
}

export interface CreateCandidateSetInput {
  objective: string;
  competitors: CandidateSetCompetitorInput[];
  selectionContract: SelectionContract;
  maxConcurrency: number;
  budget: CandidateSetBudget;
  loserPolicy: "retain" | "discard";
}

export interface Database {
  version: 9;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  candidateSets: CandidateSet[];
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
  executionId?: string;
  workspacePath: string;
  codexHomePath: string;
  outboxPath: string;
  repairReferencePath?: string | null;
  resourceBindings?: RunnerResourceBinding[];
  tokenBudget?: RunnerTokenBudget;
  prompt: string;
  threadId: string | null;
}

export interface RunnerTokenBudget {
  schemaVersion: 1;
  /**
   * Hard upper bound owned by the trusted Runner.
   * The Runner must enforce this at its model-provider boundary rather than
   * relying only on Airlock's post-execution usage audit.
   */
  maximumTotalTokens: number;
}

export interface RunnerResourceBinding {
  providerId: string;
  hostPath: string;
  runtimePath: string;
  access: "read-only" | "read-write";
}

export interface AgentRunner {
  /**
   * Declares whether token allowances are rejected before or at the model
   * provider boundary. Omission means the Runner cannot safely execute a
   * Candidate Set with an aggregate token budget.
   */
  readonly tokenBudgetEnforcement?: "provider-boundary" | undefined;
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string, executionId?: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
