import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  type ResourceCandidateContext,
  type ResourceDiscardContext,
  type ResourcePromotionContext,
  type ResourceQuarantineContext,
  type ResourceReconcileContext,
  type ResourcePrepareContext,
  type TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";

export const consumerProvider: TransactionalResourceProvider = {
  manifest: {
    sdkSchemaVersion: 1,
    providerId: "consumer.fixture",
    resourceKind: "consumer-object",
    label: "Consumer object",
    capabilities: {
      schemaVersion: 1,
      isolation: "provider-branch",
      promotionVisibility: "canonical-manifest",
      promotionIdempotency: "run-keyed",
      reconciliation: "forward",
      quarantine: "retained",
      discard: "idempotent",
      repair: "fork",
      runtimeAccess: "none",
    },
    failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
    metadata: { package: "external-consumer-fixture" },
  },
  async prepare(context: ResourcePrepareContext) {
    return {
      schemaVersion: 1,
      candidate: {
        schemaVersion: 1,
        providerId: "consumer.fixture",
        resourceKind: "consumer-object",
        candidateId: context.runId,
        sourceVersionId: context.source.versionId,
        sourceFingerprint: context.source.fingerprint,
        candidateFingerprint: context.source.fingerprint,
        metadata: {},
      },
      runtimeBinding: null,
    };
  },
  async describe(context: ResourceCandidateContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      changed: false,
      fingerprintBefore: context.candidate.sourceFingerprint,
      fingerprintCandidate: context.candidate.candidateFingerprint,
      summary: "No consumer fixture change",
      metadata: {},
    };
  },
  async validate() {
    return [];
  },
  async planPromotion(context: ResourceCandidateContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      runId: context.runId,
      idempotencyKey: context.runId + ":consumer.fixture",
      sourceVersionId: context.candidate.sourceVersionId,
      sourceFingerprint: context.candidate.sourceFingerprint,
      targetVersionId: context.candidate.candidateId,
      targetFingerprint: context.candidate.candidateFingerprint,
      metadata: {},
    };
  },
  async promote(context: ResourcePromotionContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      versionId: context.plan.targetVersionId,
      fingerprint: context.plan.targetFingerprint,
      metadata: {},
    };
  },
  async quarantine(context: ResourceQuarantineContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      runId: context.runId,
      quarantineId: context.runId,
      candidateFingerprint: context.candidate.candidateFingerprint,
      metadata: {},
    };
  },
  async discard(_context: ResourceDiscardContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      discarded: true,
      alreadyDiscarded: false,
      evidenceRetained: true,
    };
  },
  async reconcile(context: ResourceReconcileContext) {
    return {
      schemaVersion: 1,
      providerId: "consumer.fixture",
      resourceKind: "consumer-object",
      status: context.expectedVersion ? "installed" : "not-installed",
      version: context.expectedVersion,
      summary: "Consumer fixture reconciliation",
    };
  },
};
