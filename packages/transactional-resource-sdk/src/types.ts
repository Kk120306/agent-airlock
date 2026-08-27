export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type ResourceIsolation =
  | "candidate-copy"
  | "provider-branch"
  | "deferred-intent";

export type PromotionVisibility =
  | "canonical-manifest"
  | "post-promotion-reconciled"
  | "best-effort";

export type PromotionIdempotency = "run-keyed" | "none";
export type ReconciliationGuarantee = "forward" | "observe-only" | "none";
export type QuarantineGuarantee = "retained" | "evidence-only";
export type DiscardGuarantee = "idempotent" | "best-effort";
export type RepairGuarantee = "fork" | "unsupported";
export type RuntimeAccess = "none" | "read-only" | "read-write";

export interface ResourceCapabilityClaim {
  schemaVersion: 1;
  isolation: ResourceIsolation;
  promotionVisibility: PromotionVisibility;
  promotionIdempotency: PromotionIdempotency;
  reconciliation: ReconciliationGuarantee;
  quarantine: QuarantineGuarantee;
  discard: DiscardGuarantee;
  repair: RepairGuarantee;
  runtimeAccess: RuntimeAccess;
}

export type ResourceLifecycleStage =
  | "prepare"
  | "runtime"
  | "describe"
  | "validate"
  | "plan-promotion"
  | "promote"
  | "quarantine"
  | "discard"
  | "reconcile";

export type ResourceFailureResult =
  | "abort-before-runtime"
  | "quarantine-run"
  | "recovery-error"
  | "retain-evidence-error";

export interface ResourceFailureSemantics {
  schemaVersion: 1;
  prepare: "abort-before-runtime";
  describe: "quarantine-run";
  validate: "quarantine-run";
  planPromotion: "quarantine-run";
  promote: "recovery-error";
  quarantine: "recovery-error";
  discard: "retain-evidence-error";
  reconcile: "recovery-error";
}

export interface ResourceProviderManifest {
  sdkSchemaVersion: 1;
  providerId: string;
  resourceKind: string;
  label: string;
  capabilities: ResourceCapabilityClaim;
  failureSemantics: ResourceFailureSemantics;
  metadata: JsonObject;
}

export interface ResourceVersionReference {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  versionId: string;
  fingerprint: string;
  metadata: JsonObject;
}

export interface ResourceCandidateHandle {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  candidateId: string;
  sourceVersionId: string;
  sourceFingerprint: string;
  candidateFingerprint: string;
  metadata: JsonObject;
}

export interface ResourceRuntimeBinding {
  schemaVersion: 1;
  relativePath: string;
  access: Exclude<RuntimeAccess, "none">;
}

export interface PreparedResource {
  schemaVersion: 1;
  candidate: ResourceCandidateHandle;
  runtimeBinding: ResourceRuntimeBinding | null;
}

export interface ResourceChangeEvidence {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  changed: boolean;
  fingerprintBefore: string;
  fingerprintCandidate: string;
  summary: string;
  metadata: JsonObject;
}

export type ResourceValidationStatus = "passed" | "failed" | "error";

export interface ResourceValidationEvidence {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  name: string;
  status: ResourceValidationStatus;
  required: boolean;
  durationMs: number;
  summary: string;
  output: string | null;
}

export interface ResourcePromotionPlan {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  runId: string;
  idempotencyKey: string;
  sourceVersionId: string;
  sourceFingerprint: string;
  targetVersionId: string;
  targetFingerprint: string;
  metadata: JsonObject;
}

export interface ResourceQuarantineHandle {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  runId: string;
  quarantineId: string;
  candidateFingerprint: string;
  metadata: JsonObject;
}

export interface ResourceDiscardResult {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  discarded: boolean;
  alreadyDiscarded: boolean;
  evidenceRetained: boolean;
}

export type ResourceReconciliationStatus =
  | "not-installed"
  | "installed"
  | "canonical"
  | "contradiction";

export interface ResourceReconciliationResult {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  status: ResourceReconciliationStatus;
  version: ResourceVersionReference | null;
  summary: string;
}

export interface ResourceRunContext {
  schemaVersion: 1;
  agentId: string;
  runId: string;
  candidateStateId: string;
  candidateResourcePath: string;
}

export interface ResourcePrepareContext extends ResourceRunContext {
  source: ResourceVersionReference;
  repairSource: ResourceQuarantineHandle | null;
}

export interface ResourceCandidateContext extends ResourceRunContext {
  candidate: ResourceCandidateHandle;
}

export interface ResourcePromotionContext extends ResourceCandidateContext {
  plan: ResourcePromotionPlan;
}

export interface ResourceQuarantineContext extends ResourceCandidateContext {
  failureStage: ResourceLifecycleStage;
}

export interface ResourceDiscardContext extends ResourceRunContext {
  candidate: ResourceCandidateHandle | null;
  quarantine: ResourceQuarantineHandle | null;
}

export interface ResourceReconcileContext {
  schemaVersion: 1;
  agentId: string;
  runId: string;
  plan: ResourcePromotionPlan;
  expectedVersion: ResourceVersionReference | null;
}

export interface TransactionalResourceProvider {
  readonly manifest: ResourceProviderManifest;
  prepare(context: ResourcePrepareContext): Promise<PreparedResource>;
  describe(context: ResourceCandidateContext): Promise<ResourceChangeEvidence>;
  validate(context: ResourceCandidateContext): Promise<ResourceValidationEvidence[]>;
  planPromotion(context: ResourceCandidateContext): Promise<ResourcePromotionPlan>;
  promote(context: ResourcePromotionContext): Promise<ResourceVersionReference>;
  quarantine(context: ResourceQuarantineContext): Promise<ResourceQuarantineHandle>;
  discard(context: ResourceDiscardContext): Promise<ResourceDiscardResult>;
  reconcile(context: ResourceReconcileContext): Promise<ResourceReconciliationResult>;
}

export type ResourceLifecycleErrorCode =
  | "invalid-input"
  | "source-mismatch"
  | "candidate-missing"
  | "candidate-corrupt"
  | "validation-failed"
  | "provider-unavailable"
  | "timeout"
  | "response-too-large"
  | "capability-mismatch"
  | "recovery-contradiction"
  | "unsupported";

export interface ResourceLifecycleErrorOptions {
  stage: ResourceLifecycleStage;
  code: ResourceLifecycleErrorCode;
  retryable: boolean;
  safeSummary: string;
  cause?: unknown;
}

export class ResourceLifecycleError extends Error {
  readonly stage: ResourceLifecycleStage;
  readonly code: ResourceLifecycleErrorCode;
  readonly retryable: boolean;
  readonly safeSummary: string;

  constructor(options: ResourceLifecycleErrorOptions) {
    super(options.safeSummary, { cause: options.cause });
    this.name = "ResourceLifecycleError";
    this.stage = options.stage;
    this.code = options.code;
    this.retryable = options.retryable;
    this.safeSummary = options.safeSummary;
  }
}

export const AIRLOCK_RESOURCE_FAILURE_SEMANTICS: ResourceFailureSemantics = {
  schemaVersion: 1,
  prepare: "abort-before-runtime",
  describe: "quarantine-run",
  validate: "quarantine-run",
  planPromotion: "quarantine-run",
  promote: "recovery-error",
  quarantine: "recovery-error",
  discard: "retain-evidence-error",
  reconcile: "recovery-error",
};
