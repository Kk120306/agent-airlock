import { createHash } from "node:crypto";
import path from "node:path";
import { ResourceLifecycleError } from "@agent-airlock/transactional-resource-sdk";
import type {
  ResourcePromotionPlan,
  ResourceQuarantineHandle,
  ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";
import {
  EXTERNAL_ACTION_BYPASS_DISCLOSURE,
  ExternalActionOutbox,
  intentEvidence,
  MockExternalActionDispatcher,
  type MockDeliveryReceipt,
  type ParsedExternalActionIntent,
} from "./external-actions.js";
import { RunCancelledError } from "./errors.js";
import { OutcomeValidator } from "./outcome-validator.js";
import {
  appendBoundedResourceEvent,
  ResourceCoordinator,
  ResourcePreparationError,
  ResourceQuarantineError,
  ResourceRuntimeBoundaryError,
  type CoordinatedPreparedResource,
  type CoordinatedResourceEvidence,
} from "./resource-coordinator.js";
import {
  PromotionJournal,
  type PromotionAuthority,
  type PromotionJournalRecord,
} from "./promotion-journal.js";
import { SQLITE_RELATIVE_PATH, SqliteResource } from "./sqlite-resource.js";
import type {
  AgentRunner,
  CanonicalStateReference,
  OutcomeContract,
  PromotionReceipt,
  RunLineage,
  RunTransaction,
  RunTransactionStatus,
  RunnerRequest,
  RunnerResult,
  SealedCandidateReference,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface AirlockRunRequest extends Omit<RunnerRequest, "outboxPath"> {
  runId: string;
  canonicalStateId: string;
  repairSourceRunId?: string | null;
  repairProviderQuarantines?: ResourceQuarantineHandle[];
}

export interface AirlockRunResult extends RunnerResult {
  transaction: RunTransaction;
  canonicalState: CanonicalStateReference | null;
  sealedCandidate?: SealedCandidateReference;
}

export interface DeferredSelectionIdentity {
  candidateSetId: string;
  competitorId: string;
}

export interface AirlockRunOptions {
  deferPromotionFor?: DeferredSelectionIdentity;
}

export interface PromotionRecoveryAuthorityContext {
  candidateSetRunIds: ReadonlySet<string>;
  expectedCandidateSetAuthorities: ReadonlyMap<string, PromotionAuthority>;
}

export class StaleCandidateSourceError extends Error {
  constructor(message = "Canonical State changed before selected Candidate Promotion") {
    super(message);
    this.name = "StaleCandidateSourceError";
  }
}

export type TransactionProgress = (transaction: RunTransaction) => Promise<void>;

export type PromotionFaultPoint =
  | "after-validated"
  | "after-version-install"
  | "after-version-installed"
  | "after-canonical-advance"
  | "after-canonical-advanced"
  | "after-effect-dispatch"
  | "after-effects-delivered"
  | "after-completed";

export type PromotionFaultInjector = (
  point: PromotionFaultPoint,
  runId: string,
) => void | Promise<void>;

export interface ReconciledPromotion {
  runId: string;
  agentId: string;
  result: RunnerResult;
  transaction: RunTransaction;
  canonicalState: CanonicalStateReference;
}

export interface PromotionRecoveryFailure {
  runId: string | null;
  agentId: string | null;
  message: string;
  transaction: RunTransaction | null;
}

export class AirlockRunError extends Error {
  constructor(
    message: string,
    readonly transaction: RunTransaction,
    readonly cancelled: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AirlockRunError";
  }
}

export function createRunTransaction(
  runId: string,
  canonicalState: CanonicalStateReference,
  outcomeContract: OutcomeContract,
  maxRepairDepth = 2,
  lineage?: RunLineage,
): RunTransaction {
  return {
    id: runId,
    status: "preparing",
    disposition: null,
    candidateStateId: null,
    canonicalStateIdBefore: canonicalState.stateId,
    canonicalStateIdAfter: null,
    canonicalContentHashBefore: canonicalState.contentHash,
    canonicalContentHashAfter: null,
    outcomeContractVersion: outcomeContract.version,
    outcomeContract: structuredClone(outcomeContract),
    resources: [
      {
        kind: "workspace",
        label: "Workspace",
        disposition: null,
        fingerprintBefore: canonicalState.workspaceContentHash,
        fingerprintAfter: null,
        summary: "Candidate workspace is isolated from Canonical State",
      },
      {
        kind: "codex-session",
        label: "Agent memory",
        disposition: null,
        fingerprintBefore: canonicalState.sessionContentHash,
        fingerprintAfter: null,
        summary: canonicalState.codexThreadId
          ? "Candidate session resumes the accepted thread"
          : "Candidate session will start the first accepted thread",
      },
      {
        kind: "sqlite",
        label: "SQLite data",
        disposition: null,
        fingerprintBefore: canonicalState.sqliteContentHash,
        fingerprintAfter: null,
        summary: "Candidate data is isolated from the Canonical database",
      },
      {
        kind: "external-actions",
        label: "External actions",
        disposition: null,
        fingerprintBefore: externalActionFingerprint([]),
        fingerprintAfter: null,
        summary: "Typed intents remain deferred until Promotion",
      },
    ],
    providerResources: [],
    providerResourceEvents: [],
    sqlite: null,
    externalActions: {
      outboxPath: "Candidate State/outbox/intents.jsonl",
      intents: [],
      deliveredCount: 0,
      bypassDisclosure: EXTERNAL_ACTION_BYPASS_DISCLOSURE,
    },
    changes: null,
    validations: [],
    events: [
      {
        status: "preparing",
        at: now(),
        summary: "Preparing isolated Candidate State",
      },
    ],
    quarantinePath: null,
    quarantineAvailable: false,
    discardedAt: null,
    lineage: lineage ?? {
      rootRunId: runId,
      parentRunId: null,
      depth: 0,
      maxDepth: maxRepairDepth,
    },
    recovery: {
      journalPhase: null,
      recoveredAfterRestart: false,
      recoveryError: null,
    },
    promotionReceipt: null,
  };
}

export class AirlockRunner {
  private readonly activeAgentCounts = new Map<string, number>();
  private readonly activeExecutionIds = new Set<string>();
  private readonly cancellationRequests = new Set<string>();
  private readonly executionCancellationRequests = new Set<string>();

  constructor(
    private readonly inner: AgentRunner,
    private readonly workspaces: WorkspaceManager,
    private readonly validator: OutcomeValidator,
    private readonly sqlite: SqliteResource,
    private readonly actionOutbox: ExternalActionOutbox,
    private readonly actionDispatcher: MockExternalActionDispatcher,
    private readonly promotionJournal: PromotionJournal,
    private readonly resources: ResourceCoordinator,
    private readonly injectPromotionFault?: PromotionFaultInjector,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async cancel(agentId: string, executionId?: string): Promise<boolean> {
    if (executionId) {
      if (!this.activeExecutionIds.has(executionId)) {
        return this.inner.cancel(agentId, executionId);
      }
      this.executionCancellationRequests.add(executionId);
      try {
        return await this.inner.cancel(agentId, executionId);
      } finally {
        if (!this.activeExecutionIds.has(executionId)) {
          this.executionCancellationRequests.delete(executionId);
        }
      }
    }
    if (!this.activeAgentCounts.has(agentId)) return this.inner.cancel(agentId);
    this.cancellationRequests.add(agentId);
    await this.inner.cancel(agentId);
    return true;
  }

  canRepairProviderQuarantine(transaction: RunTransaction): boolean {
    const manifests = this.resources.manifests();
    if (manifests.length === 0) return true;
    const quarantines = new Map(
      transaction.providerResources.flatMap((resource) =>
        resource.quarantine
          ? [[resource.providerId, resource.quarantine] as const]
          : [],
      ),
    );
    return manifests.every((manifest) => quarantines.has(manifest.providerId));
  }

  providerDiscardCompleted(transaction: RunTransaction): boolean {
    const hasProviderEvidence =
      transaction.providerResources.length > 0 ||
      transaction.providerResourceEvents.length > 0;
    if (!hasProviderEvidence) return true;
    const providerIds = new Set([
      ...transaction.providerResources.map((resource) => resource.providerId),
      ...transaction.providerResourceEvents.map((event) => event.providerId),
    ]);
    return [...providerIds].every((providerId) =>
      transaction.providerResourceEvents.some(
        (event) =>
          event.providerId === providerId &&
          event.stage === "discard" &&
          event.status === "passed",
      ),
    );
  }

  async discardProviderQuarantines(
    agentId: string,
    transaction: RunTransaction,
    onProgress?: TransactionProgress,
  ): Promise<RunTransaction> {
    if (
      transaction.providerResources.length === 0 &&
      !hasFailedProviderPrepare(transaction)
    ) {
      return structuredClone(transaction);
    }
    if (!transaction.quarantinePath || !transaction.candidateStateId) {
      throw new Error("Provider Quarantine has no retained Candidate State");
    }
    return this.discardRetainedProviderState(
      agentId,
      transaction,
      transaction.quarantinePath,
      onProgress,
    );
  }

  async discardRetainedProviderState(
    agentId: string,
    transaction: RunTransaction,
    retainedStateRoot: string,
    onProgress?: TransactionProgress,
  ): Promise<RunTransaction> {
    const prepareFailed = hasFailedProviderPrepare(transaction);
    if (transaction.providerResources.length === 0 && !prepareFailed) {
      return structuredClone(transaction);
    }
    if (!transaction.candidateStateId) {
      throw new Error("Provider Candidate has no retained Candidate State identifier");
    }
    const candidateResourcesRoot = path.join(retainedStateRoot, "resources");
    const providerIds = await this.workspaces.retainedProviderIds(
      transaction.id,
      retainedStateRoot,
    );
    const prepared = await this.resources.restorePrepared(
      candidateResourcesRoot,
      transaction.providerResources,
      {
        allowPartial: prepareFailed,
        providerIds,
      },
    );
    const next = structuredClone(transaction);
    await this.resources.discardAll({
      agentId,
      runId: transaction.id,
      candidateStateId: transaction.candidateStateId,
      candidateResourcesRoot,
      prepared,
      quarantines: transaction.providerResources.flatMap((resource) =>
        resource.quarantine ? [resource.quarantine] : [],
      ),
      allowPartialPrepared: prepareFailed,
      providerIds,
      onEvent: async (event) => {
        appendBoundedResourceEvent(next.providerResourceEvents, event);
        await onProgress?.(next);
      },
      onDiscard: async (results) => {
        next.providerResources = markProvidersDiscarded(
          next.providerResources,
          results.map((result) => result.providerId),
        );
        await onProgress?.(next);
      },
    });
    next.providerResources = markProviderDisposition(
      next.providerResources,
      "discarded",
    );
    return next;
  }

  async run(
    request: AirlockRunRequest,
    initialTransaction: RunTransaction,
    onProgress: TransactionProgress,
    options: AirlockRunOptions = {},
  ): Promise<AirlockRunResult> {
    let transaction = structuredClone(initialTransaction);
    let candidatePrepared = false;
    let parsedIntents: ParsedExternalActionIntent[] = [];
    let preparedResources: CoordinatedPreparedResource[] = [];
    let providerEvidence: CoordinatedResourceEvidence[] = [];
    let providerPlans: ResourcePromotionPlan[] = [];
    let providerQuarantines: ResourceQuarantineHandle[] = [];
    let candidateResourcesRoot = "";
    let candidateStateId = "";
    const recordResourceEvent = async (
      event: RunTransaction["providerResourceEvents"][number],
    ) => {
      appendBoundedResourceEvent(transaction.providerResourceEvents, event);
      await onProgress(transaction);
    };
    this.activeAgentCounts.set(
      request.agentId,
      (this.activeAgentCounts.get(request.agentId) ?? 0) + 1,
    );
    if (request.executionId) this.activeExecutionIds.add(request.executionId);
    try {
      const candidate = request.repairSourceRunId
        ? await this.workspaces.prepareRepairCandidate(
            request.agentId,
            request.repairSourceRunId,
            request.runId,
          )
        : await this.workspaces.prepareCandidate(request.agentId, request.runId);
      candidatePrepared = true;
      candidateStateId = candidate.candidateStateId;
      transaction.candidateStateId = candidate.candidateStateId;
      const candidateWorkspacePath =
        await this.workspaces.candidateWorkspacePath(request.runId);
      const candidateCodexHomePath =
        await this.workspaces.candidateCodexHomePath(request.runId);
      const candidateOutboxPath =
        await this.workspaces.candidateOutboxPath(request.runId);
      candidateResourcesRoot =
        await this.workspaces.candidateResourcesPath(request.runId);
      const canonicalBefore = await this.workspaces.readCanonical(request.agentId);
      const sqliteBefore = await this.sqlite.inspect(canonicalBefore.workspacePath);
      if (sqliteBefore.contentHash !== canonicalBefore.sqliteContentHash) {
        throw new Error("Canonical SQLite snapshot does not match its manifest");
      }
      transaction.sqlite = {
        databasePath: SQLITE_RELATIVE_PATH,
        integrity: "passed",
        before: sqliteBefore,
        candidate: null,
        after: null,
      };
      preparedResources = await this.resources.prepareAll({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId: candidate.candidateStateId,
        candidateResourcesRoot,
        sourceVersions: canonicalBefore.providerVersions,
        repairQuarantines: request.repairProviderQuarantines ?? [],
        repairSourceRunId: request.repairSourceRunId ?? null,
        onEvent: recordResourceEvent,
        onPrepared: async (resources) => {
          preparedResources = structuredClone([...resources]);
          transaction.providerResources = providerRecordsFromPrepared(resources);
          await onProgress(transaction);
        },
      });
      transaction.providerResources = providerRecordsFromPrepared(preparedResources);
      await onProgress(transaction);
      this.assertNotCancelled(request.agentId, request.executionId);
      if (
        candidate.canonicalStateIdBefore !== request.canonicalStateId ||
        candidate.canonicalThreadIdBefore !== request.threadId
      ) {
        throw new Error(
          "Agent metadata does not match the current Canonical State pair",
        );
      }
      transaction = await this.transition(
        transaction,
        "executing",
        "Agent Runtime is executing against Candidate State",
        onProgress,
      );

      const result = await this.inner.run({
        agentId: request.agentId,
        ...(request.executionId ? { executionId: request.executionId } : {}),
        workspacePath: candidateWorkspacePath,
        codexHomePath: candidateCodexHomePath,
        outboxPath: candidateOutboxPath,
        repairReferencePath: candidate.repairReferencePath,
        resourceBindings: preparedResources.flatMap((resource) =>
          resource.runtimeBinding
            ? [
                {
                  providerId: resource.providerId,
                  hostPath: resource.runtimeBinding.hostPath,
                  runtimePath: resource.runtimeBinding.runtimePath,
                  access: resource.runtimeBinding.access,
                },
              ]
            : [],
        ),
        ...(request.tokenBudget
          ? { tokenBudget: structuredClone(request.tokenBudget) }
          : {}),
        prompt: request.prompt,
        threadId: candidate.runtimeThreadId,
      });
      await this.workspaces.recordCandidateThread(request.runId, result.threadId);
      this.assertNotCancelled(request.agentId, request.executionId);
      await this.resources.assertRuntimeBindingsSafe(preparedResources);

      transaction = await this.transition(
        transaction,
        "validating",
        "Evaluating the Candidate State outcome",
        onProgress,
      );
      const canonical = await this.workspaces.readCanonical(request.agentId);
      const validationResult = await this.validator.validate(
        canonical.workspacePath,
        candidateWorkspacePath,
        transaction.outcomeContract,
        request.runId,
      );
      const [sqliteValidation, actionValidation, resourceValidation] = await Promise.all([
        this.sqlite.validate(
          candidateWorkspacePath,
          transaction.outcomeContract.secretPatterns,
        ),
        this.actionOutbox.validate(candidateOutboxPath, request.runId),
        this.resources.describeAndValidate({
          agentId: request.agentId,
          runId: request.runId,
          candidateStateId: candidate.candidateStateId,
          candidateResourcesRoot,
          prepared: preparedResources,
          onEvent: recordResourceEvent,
        }),
      ]);
      const repairReferenceValidation =
        await this.workspaces.repairReferenceEvidence(request.runId);
      parsedIntents = actionValidation.intents;
      providerEvidence = resourceValidation;
      transaction.providerResources = mergeProviderEvidence(
        transaction.providerResources,
        providerEvidence,
      );
      transaction.changes = validationResult.changes;
      transaction.validations = [
        ...validationResult.validations,
        sqliteValidation.evidence,
        actionValidation.evidence,
        ...providerEvidence.flatMap((resource) =>
          resource.validations.map((validation) => ({
            name: resource.providerId + ":" + validation.name,
            status: validation.status,
            required: resource.required && validation.required,
            summary: validation.summary,
            durationMs: validation.durationMs,
            output: validation.output,
          })),
        ),
        ...(repairReferenceValidation
          ? [
              {
                name: "repair-reference",
                status: repairReferenceValidation.status,
                required: true,
                summary: repairReferenceValidation.summary,
                durationMs: 0,
                output: null,
              } as const,
            ]
          : []),
      ];
      transaction.sqlite = {
        databasePath: SQLITE_RELATIVE_PATH,
        integrity:
          sqliteValidation.evidence.status === "passed" ? "passed" : "failed",
        before: sqliteBefore,
        candidate: sqliteValidation.snapshot,
        after: null,
      };
      transaction.externalActions.intents = intentEvidence(
        parsedIntents,
        "deferred",
      );
      const failedRequiredValidation = transaction.validations.find(
        (validation) => validation.required && validation.status !== "passed",
      );

      if (failedRequiredValidation) {
        providerQuarantines = await this.resources.quarantineAll({
          agentId: request.agentId,
          runId: request.runId,
          candidateStateId: candidate.candidateStateId,
          candidateResourcesRoot,
          prepared: preparedResources,
          evidence: providerEvidence,
          failureStage: "validate",
          onEvent: recordResourceEvent,
          onQuarantine: async (quarantines) => {
            providerQuarantines = structuredClone([...quarantines]);
            transaction.providerResources = markProviderQuarantined(
              transaction.providerResources,
              quarantines,
            );
            await onProgress(transaction);
          },
        });
        transaction.providerResources = markProviderQuarantined(
          transaction.providerResources,
          providerQuarantines,
        );
        transaction.quarantinePath = await this.workspaces.quarantineCandidate(
          request.runId,
        );
        transaction.quarantineAvailable = true;
        candidatePrepared = false;
        transaction.disposition = "quarantined";
        transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
        transaction.canonicalContentHashAfter =
          transaction.canonicalContentHashBefore;
        transaction.externalActions.intents = intentEvidence(
          parsedIntents,
          "rejected",
        );
        if (transaction.sqlite) transaction.sqlite.after = sqliteBefore;
        transaction = finalizeResources(transaction, "quarantined", undefined, {
          sqlite: sqliteBefore.contentHash,
          "external-actions": externalActionFingerprint([]),
        });
        transaction.promotionReceipt = createPromotionReceipt(transaction);
        transaction = await this.transition(
          transaction,
          "quarantined",
          "Candidate State failed " + failedRequiredValidation.name,
          onProgress,
        );
        return { ...result, transaction, canonicalState: null };
      }

      if (options.deferPromotionFor) {
        this.assertNotCancelled(request.agentId, request.executionId);
        transaction = await this.transition(
          transaction,
          "sealed",
          "Candidate passed required Validation and is sealed for deterministic Selection",
          onProgress,
        );
        const sealedCandidate = createSealedCandidateReference({
          identity: options.deferPromotionFor,
          transaction,
          result,
        });
        return {
          ...result,
          transaction,
          canonicalState: null,
          sealedCandidate,
        };
      }

      this.assertNotCancelled(request.agentId, request.executionId);
      transaction = await this.transition(
        transaction,
        "promoting",
        "All required Validations passed",
        onProgress,
      );
      providerPlans = await this.resources.planAll({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId: candidate.candidateStateId,
        candidateResourcesRoot,
        prepared: preparedResources,
        evidence: providerEvidence,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeProviderPlans(
        transaction.providerResources,
        providerPlans,
      );
      const targetProviderVersions = providerPlans.map(versionFromResourcePlan);
      const plan = await this.workspaces.planPromotion(
        request.agentId,
        request.runId,
        targetProviderVersions,
        providerPlans,
      );
      let journal = await this.promotionJournal.begin({
        plan,
        transaction,
        result,
      });
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-validated", request.runId);

      const installedBeforeCanonical = await this.resources.promoteBeforeCanonical({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId: candidate.candidateStateId,
        candidateResourcesRoot,
        prepared: preparedResources,
        plans: providerPlans,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedBeforeCanonical,
      );

      const installed = await this.workspaces.installPromotion(plan);
      candidatePrepared = false;
      await this.injectPromotionFault?.("after-version-install", request.runId);
      journal = await this.promotionJournal.advance(
        request.runId,
        "version-installed",
        { transaction, targetCanonical: installed },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-version-installed", request.runId);

      const canonicalState = await this.workspaces.advancePromotion(plan, installed);
      transaction = this.recordCanonicalAdvance(transaction, canonicalState);
      await this.injectPromotionFault?.("after-canonical-advance", request.runId);
      journal = await this.promotionJournal.advance(
        request.runId,
        "canonical-advanced",
        { transaction, targetCanonical: canonicalState },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-canonical-advanced", request.runId);

      const installedResourcesRoot = await this.workspaces.installedResourcesPath(
        request.agentId,
        plan.targetStateId,
      );
      const installedAfterCanonical = await this.resources.promoteAfterCanonical({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId: candidate.candidateStateId,
        candidateResourcesRoot: installedResourcesRoot,
        prepared: preparedResources,
        plans: providerPlans,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedAfterCanonical,
      );

      const receipts = await this.actionDispatcher.dispatch(
        request.runId,
        parsedIntents,
      );
      await this.injectPromotionFault?.("after-effect-dispatch", request.runId);
      transaction = this.finalizePromotedEffects(
        transaction,
        canonicalState,
        parsedIntents,
        receipts,
      );
      journal = await this.promotionJournal.advance(
        request.runId,
        "effects-delivered",
        { transaction, targetCanonical: canonicalState },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-effects-delivered", request.runId);

      transaction = this.recordTransition(
        transaction,
        "promoted",
        "Candidate State is now Canonical State",
      );
      journal = await this.promotionJournal.advance(request.runId, "completed", {
        transaction,
        targetCanonical: canonicalState,
      });
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-completed", request.runId);
      return { ...result, transaction, canonicalState };
    } catch (error) {
      const journal = await this.promotionJournal
        .read(request.runId)
        .catch(() => null);
      if (journal) {
        const evidencedTransaction = structuredClone(journal.transaction);
        evidencedTransaction.providerResources = structuredClone(
          transaction.providerResources,
        );
        evidencedTransaction.providerResourceEvents = structuredClone(
          transaction.providerResourceEvents,
        );
        const evidencedJournal = await this.promotionJournal
          .updateTransaction(request.runId, evidencedTransaction)
          .catch(() => journal);
        throw new AirlockRunError(
          "Promotion was interrupted at " +
            evidencedJournal.phase +
            " and requires durable reconciliation",
          evidencedJournal.transaction,
          false,
          error,
        );
      }
      if (error instanceof ResourcePreparationError) {
        preparedResources = error.prepared;
        transaction.providerResources = providerRecordsFromPrepared(preparedResources);
        transaction.providerResources = error.cleanupCompleted
          ? markProviderDisposition(transaction.providerResources, "discarded")
          : markProviderPrepareRetained(transaction.providerResources);
        await onProgress(transaction);
        if (candidatePrepared) {
          if (error.cleanupCompleted) {
            await this.workspaces.cancelCandidate(request.runId);
          } else {
            transaction.quarantinePath = await this.workspaces.quarantineCandidate(
              request.runId,
            );
            transaction.quarantineAvailable = true;
          }
          candidatePrepared = false;
        }
        transaction.disposition = error.cleanupCompleted
          ? "discarded"
          : "quarantined";
        transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
        transaction.canonicalContentHashAfter =
          transaction.canonicalContentHashBefore;
        transaction = finalizeResources(
          transaction,
          error.cleanupCompleted ? "discarded" : "quarantined",
        );
        transaction.promotionReceipt = createPromotionReceipt(transaction);
        transaction = await this.transition(
          transaction,
          error.cleanupCompleted ? "discarded" : "quarantined",
          error.cleanupCompleted
            ? "Resource preparation aborted before Runtime and cleanup completed"
            : "Resource preparation aborted before Runtime and cleanup requires retry",
          onProgress,
        );
        throw new AirlockRunError(
          error.message,
          transaction,
          false,
          error,
        );
      }
      const cancelled = error instanceof RunCancelledError;
      let providerCleanupError: unknown = null;
      if (preparedResources.length > 0) {
        try {
          if (cancelled || error instanceof ResourceRuntimeBoundaryError) {
            await this.resources.discardAll({
              agentId: request.agentId,
              runId: request.runId,
              candidateStateId,
              candidateResourcesRoot,
              prepared: preparedResources,
              quarantines: [],
              onEvent: recordResourceEvent,
              onDiscard: async (results) => {
                transaction.providerResources = markProvidersDiscarded(
                  transaction.providerResources,
                  results.map((result) => result.providerId),
                );
                await onProgress(transaction);
              },
            });
            transaction.providerResources = markProviderDisposition(
              transaction.providerResources,
              cancelled ? "cancelled" : "discarded",
            );
          } else {
            providerQuarantines = await this.resources.quarantineAll({
              agentId: request.agentId,
              runId: request.runId,
              candidateStateId,
              candidateResourcesRoot,
              prepared: preparedResources,
              ...(providerEvidence.length > 0 ? { evidence: providerEvidence } : {}),
              failureStage: lifecycleFailureStage(error),
              onEvent: recordResourceEvent,
              onQuarantine: async (quarantines) => {
                providerQuarantines = structuredClone([...quarantines]);
                transaction.providerResources = markProviderQuarantined(
                  transaction.providerResources,
                  quarantines,
                );
                await onProgress(transaction);
              },
            });
            transaction.providerResources = markProviderQuarantined(
              transaction.providerResources,
              providerQuarantines,
            );
          }
        } catch (cleanupError) {
          providerCleanupError = cleanupError;
          if (cleanupError instanceof ResourceQuarantineError) {
            providerQuarantines = cleanupError.quarantines;
            transaction.providerResources = markProviderQuarantined(
              transaction.providerResources,
              providerQuarantines,
            );
          }
        }
      }
      const cleanupComplete = !providerCleanupError;
      const cancelledAndClean = cancelled && cleanupComplete;
      if (candidatePrepared) {
        if (cancelledAndClean) {
          await this.workspaces.cancelCandidate(request.runId);
        } else {
          transaction.quarantinePath = await this.workspaces.quarantineCandidate(
            request.runId,
          );
          transaction.quarantineAvailable = true;
        }
      }
      transaction.disposition = cancelledAndClean ? "cancelled" : "quarantined";
      transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
      transaction.canonicalContentHashAfter =
        transaction.canonicalContentHashBefore;
      transaction = finalizeResources(
        transaction,
        cancelledAndClean ? "cancelled" : "quarantined",
      );
      transaction.promotionReceipt = createPromotionReceipt(transaction);
      transaction = await this.transition(
        transaction,
        cancelledAndClean ? "cancelled" : "quarantined",
        cancelledAndClean
          ? "Run Transaction was cancelled before Promotion"
          : cancelled
            ? "Cancellation retained cleanup-only Quarantine after provider cleanup failed"
          : "Runtime failed and Candidate State was quarantined",
        onProgress,
      );
      const message = error instanceof Error ? error.message : String(error);
      const boundedMessage = providerCleanupError
        ? message + "; Resource Provider cleanup also failed closed"
        : message;
      throw new AirlockRunError(
        boundedMessage,
        transaction,
        cancelledAndClean,
        error,
      );
    } finally {
      if (request.executionId) {
        this.activeExecutionIds.delete(request.executionId);
        this.executionCancellationRequests.delete(request.executionId);
      }
      const remaining = (this.activeAgentCounts.get(request.agentId) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeAgentCounts.delete(request.agentId);
        this.cancellationRequests.delete(request.agentId);
      } else {
        this.activeAgentCounts.set(request.agentId, remaining);
      }
    }
  }

  async promoteSealedCandidate(
    request: AirlockRunRequest,
    sealedCandidate: SealedCandidateReference,
    sealedTransaction: RunTransaction,
    result: RunnerResult,
    authority: PromotionAuthority,
    onProgress: TransactionProgress,
  ): Promise<AirlockRunResult> {
    let transaction = structuredClone(sealedTransaction);
    verifySealedCandidateReference(sealedCandidate, transaction, result);
    if (
      sealedCandidate.runId !== request.runId ||
      transaction.id !== request.runId ||
      transaction.status !== "sealed" ||
      transaction.disposition !== null ||
      !transaction.candidateStateId
    ) {
      throw new Error("Selected Candidate seal contradicts its Run Transaction");
    }
    const candidateStateId = transaction.candidateStateId;
    const canonical = await this.workspaces.readCanonicalForProviderTransition(
      request.agentId,
    );
    if (
      canonical.stateId !== transaction.canonicalStateIdBefore ||
      canonical.contentHash !== transaction.canonicalContentHashBefore ||
      canonical.stateId !== sealedCandidate.sourceStateId ||
      canonical.contentHash !== sealedCandidate.sourceContentHash ||
      canonical.stateId !== request.canonicalStateId
    ) {
      throw new StaleCandidateSourceError();
    }

    const candidateWorkspacePath = await this.workspaces.candidateWorkspacePath(
      request.runId,
      true,
    );
    const candidateOutboxPath = await this.workspaces.candidateOutboxPath(
      request.runId,
      true,
    );
    const candidateResourcesRoot = await this.workspaces.candidateResourcesPath(
      request.runId,
      true,
    );
    const providerIds = providerIdsFromTransaction(transaction);
    const preparedResources = await this.resources.restorePrepared(
      candidateResourcesRoot,
      transaction.providerResources,
      { providerIds },
    );
    const recordResourceEvent = async (
      event: RunTransaction["providerResourceEvents"][number],
    ) => {
      appendBoundedResourceEvent(transaction.providerResourceEvents, event);
      await onProgress(transaction);
    };

    await this.resources.assertRuntimeBindingsSafe(preparedResources, providerIds);
    const validationResult = await this.validator.validate(
      canonical.workspacePath,
      candidateWorkspacePath,
      transaction.outcomeContract,
      request.runId,
    );
    const [sqliteValidation, actionValidation, providerEvidence] = await Promise.all([
      this.sqlite.validate(
        candidateWorkspacePath,
        transaction.outcomeContract.secretPatterns,
      ),
      this.actionOutbox.validate(candidateOutboxPath, request.runId),
      this.resources.describeAndValidate({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId: transaction.candidateStateId,
        candidateResourcesRoot,
        prepared: preparedResources,
        providerIds,
        onEvent: recordResourceEvent,
      }),
    ]);
    if (!sqliteValidation.snapshot) {
      throw new Error("Selected Candidate SQLite state could not be reverified");
    }
    assertSealedCandidateUnchanged({
      transaction,
      changes: validationResult.changes,
      validations: [
        ...validationResult.validations,
        sqliteValidation.evidence,
        actionValidation.evidence,
        ...providerEvidence.flatMap((resource) =>
          resource.validations.map((validation) => ({
            name: resource.providerId + ":" + validation.name,
            status: validation.status,
            required: resource.required && validation.required,
            summary: validation.summary,
            durationMs: validation.durationMs,
            output: validation.output,
          })),
        ),
      ],
      sqliteContentHash: sqliteValidation.snapshot.contentHash,
      intents: intentEvidence(actionValidation.intents, "deferred"),
      providerEvidence,
    });

    transaction = await this.transition(
      transaction,
      "promoting",
      "Selected Candidate seal and every required Validation were reverified",
      onProgress,
    );
    const providerPlans = await this.resources.planAll({
      agentId: request.agentId,
      runId: request.runId,
      candidateStateId,
      candidateResourcesRoot,
      prepared: preparedResources,
      evidence: providerEvidence,
      providerIds,
      onEvent: recordResourceEvent,
    });
    transaction.providerResources = mergeProviderPlans(
      transaction.providerResources,
      providerPlans,
    );
    const targetProviderVersions = providerPlans.map(versionFromResourcePlan);
    const plan = await this.workspaces.planPromotion(
      request.agentId,
      request.runId,
      targetProviderVersions,
      providerPlans,
      true,
    );

    try {
      let journal = await this.promotionJournal.begin({
        plan,
        transaction,
        result,
        authority,
      });
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-validated", request.runId);

      const installedBeforeCanonical = await this.resources.promoteBeforeCanonical({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId,
        candidateResourcesRoot,
        prepared: preparedResources,
        plans: providerPlans,
        providerIds,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedBeforeCanonical,
      );

      const installed = await this.workspaces.installPromotion(plan);
      await this.injectPromotionFault?.("after-version-install", request.runId);
      journal = await this.promotionJournal.advance(
        request.runId,
        "version-installed",
        { transaction, targetCanonical: installed },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-version-installed", request.runId);

      const canonicalState = await this.workspaces.advancePromotion(plan, installed);
      transaction = this.recordCanonicalAdvance(transaction, canonicalState);
      await this.injectPromotionFault?.("after-canonical-advance", request.runId);
      journal = await this.promotionJournal.advance(
        request.runId,
        "canonical-advanced",
        { transaction, targetCanonical: canonicalState },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-canonical-advanced", request.runId);

      const installedResourcesRoot = await this.workspaces.installedResourcesPath(
        request.agentId,
        plan.targetStateId,
      );
      const installedAfterCanonical = await this.resources.promoteAfterCanonical({
        agentId: request.agentId,
        runId: request.runId,
        candidateStateId,
        candidateResourcesRoot: installedResourcesRoot,
        prepared: preparedResources,
        plans: providerPlans,
        providerIds,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedAfterCanonical,
      );

      const receipts = await this.actionDispatcher.dispatch(
        request.runId,
        actionValidation.intents,
      );
      await this.injectPromotionFault?.("after-effect-dispatch", request.runId);
      transaction = this.finalizePromotedEffects(
        transaction,
        canonicalState,
        actionValidation.intents,
        receipts,
      );
      journal = await this.promotionJournal.advance(
        request.runId,
        "effects-delivered",
        { transaction, targetCanonical: canonicalState },
      );
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-effects-delivered", request.runId);

      transaction = this.recordTransition(
        transaction,
        "promoted",
        "Selected Candidate State is now Canonical State",
      );
      journal = await this.promotionJournal.advance(request.runId, "completed", {
        transaction,
        targetCanonical: canonicalState,
      });
      transaction = journal.transaction;
      await onProgress(transaction);
      await this.injectPromotionFault?.("after-completed", request.runId);
      return { ...result, transaction, canonicalState };
    } catch (error) {
      const journal = await this.promotionJournal
        .read(request.runId)
        .catch(() => null);
      if (!journal) throw error;
      const evidencedTransaction = structuredClone(journal.transaction);
      evidencedTransaction.providerResources = structuredClone(
        transaction.providerResources,
      );
      evidencedTransaction.providerResourceEvents = structuredClone(
        transaction.providerResourceEvents,
      );
      const evidencedJournal = await this.promotionJournal
        .updateTransaction(request.runId, evidencedTransaction)
        .catch(() => journal);
      throw new AirlockRunError(
        "Selected Candidate Promotion was interrupted at " +
          evidencedJournal.phase +
          " and requires durable reconciliation",
        evidencedJournal.transaction,
        false,
        error,
      );
    }
  }

  async disposeSealedCandidate(
    agentId: string,
    sealedTransaction: RunTransaction,
    policy: "retain" | "discard",
    onProgress: TransactionProgress,
  ): Promise<RunTransaction> {
    let transaction = structuredClone(sealedTransaction);
    if (
      transaction.status !== "sealed" ||
      transaction.disposition !== null ||
      !transaction.candidateStateId
    ) {
      throw new Error("Only a sealed unselected Candidate can receive loser disposition");
    }
    const candidateExists = await this.workspaces.candidateExists(
      transaction.id,
      true,
    );
    const retainedQuarantinePath = await this.workspaces.retainedQuarantinePath(
      transaction.id,
    );
    if (!candidateExists) {
      if (policy === "retain" && retainedQuarantinePath) {
        return this.finalizeSealedLoserDisposition(
          transaction,
          policy,
          retainedQuarantinePath,
          onProgress,
        );
      }
      if (
        policy === "discard" &&
        !retainedQuarantinePath &&
        this.providerDiscardCompleted(transaction)
      ) {
        return this.finalizeSealedLoserDisposition(
          transaction,
          policy,
          null,
          onProgress,
        );
      }
      throw new Error(
        "Sealed loser physical state contradicts its durable cleanup evidence",
      );
    }
    if (retainedQuarantinePath) {
      throw new Error("Sealed loser has both Candidate State and Quarantine");
    }
    const candidateResourcesRoot = await this.workspaces.candidateResourcesPath(
      transaction.id,
      true,
    );
    const providerIds = providerIdsFromTransaction(transaction);
    const prepared = await this.resources.restorePrepared(
      candidateResourcesRoot,
      transaction.providerResources,
      { providerIds },
    );
    const evidence = providerEvidenceFromTransaction(transaction);
    const recordResourceEvent = async (
      event: RunTransaction["providerResourceEvents"][number],
    ) => {
      appendBoundedResourceEvent(transaction.providerResourceEvents, event);
      await onProgress(transaction);
    };

    let quarantinePath: string | null = null;
    if (policy === "retain") {
      let quarantines: ResourceQuarantineHandle[] = [];
      quarantines = await this.resources.quarantineAll({
        agentId,
        runId: transaction.id,
        candidateStateId: transaction.candidateStateId,
        candidateResourcesRoot,
        prepared,
        evidence,
        providerIds,
        failureStage: "validate",
        onEvent: recordResourceEvent,
        onQuarantine: async (progress) => {
          quarantines = structuredClone([...progress]);
          transaction.providerResources = markProviderQuarantined(
            transaction.providerResources,
            quarantines,
          );
          await onProgress(transaction);
        },
      });
      transaction.providerResources = markProviderQuarantined(
        transaction.providerResources,
        quarantines,
      );
      quarantinePath = await this.workspaces.quarantineCandidate(
        transaction.id,
        true,
      );
    } else {
      await this.resources.discardAll({
        agentId,
        runId: transaction.id,
        candidateStateId: transaction.candidateStateId,
        candidateResourcesRoot,
        prepared,
        quarantines: [],
        providerIds,
        onEvent: recordResourceEvent,
        onDiscard: async (results) => {
          transaction.providerResources = markProvidersDiscarded(
            transaction.providerResources,
            results.map((result) => result.providerId),
          );
          await onProgress(transaction);
        },
      });
      await this.workspaces.cancelCandidate(transaction.id, true);
    }
    return this.finalizeSealedLoserDisposition(
      transaction,
      policy,
      quarantinePath,
      onProgress,
    );
  }

  private finalizeSealedLoserDisposition(
    transactionAtStart: RunTransaction,
    policy: "retain" | "discard",
    quarantinePath: string | null,
    onProgress: TransactionProgress,
  ): Promise<RunTransaction> {
    let transaction = structuredClone(transactionAtStart);
    transaction.quarantinePath = quarantinePath;
    transaction.quarantineAvailable = policy === "retain";
    transaction.discardedAt = policy === "discard" ? now() : null;
    transaction.disposition = policy === "retain" ? "quarantined" : "discarded";
    if (policy === "discard") {
      transaction.providerResources = markProviderDisposition(
        transaction.providerResources,
        "discarded",
      );
    }
    transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
    transaction.canonicalContentHashAfter =
      transaction.canonicalContentHashBefore;
    transaction.externalActions.intents = transaction.externalActions.intents.map(
      (intent) => ({ ...intent, status: "rejected", deliveredAt: null }),
    );
    if (transaction.sqlite?.before) {
      transaction.sqlite.after = structuredClone(transaction.sqlite.before);
    }
    transaction = finalizeResources(
      transaction,
      policy === "retain" ? "quarantined" : "discarded",
    );
    transaction.promotionReceipt = createPromotionReceipt(transaction);
    return this.transition(
      transaction,
      policy === "retain" ? "quarantined" : "discarded",
      policy === "retain"
        ? "Unselected Candidate was retained as Quarantine"
        : "Unselected Candidate was discarded with bounded evidence retained",
      onProgress,
    );
  }

  async reconcilePromotions(
    recoverCompletedRunIds: Set<string>,
    authorityContext: PromotionRecoveryAuthorityContext = {
      candidateSetRunIds: new Set(),
      expectedCandidateSetAuthorities: new Map(),
    },
  ): Promise<{
    recovered: ReconciledPromotion[];
    failures: PromotionRecoveryFailure[];
    protectedRunIds: Set<string>;
  }> {
    const scan = await this.promotionJournal.scan();
    const recovered: ReconciledPromotion[] = [];
    const failures: PromotionRecoveryFailure[] = scan.errors.map((error) => ({
      runId: error.runId,
      agentId: null,
      message: error.message,
      transaction: null,
    }));
    const protectedRunIds = new Set<string>();
    for (const record of scan.records) {
      if (record.phase === "completed" && !recoverCompletedRunIds.has(record.runId)) {
        continue;
      }
      protectedRunIds.add(record.runId);
      try {
        assertRecoveryAuthority(record, authorityContext);
        recovered.push(await this.reconcilePromotion(record));
        protectedRunIds.delete(record.runId);
      } catch (error) {
        const message =
          "Promotion recovery failed: " +
          (error instanceof Error ? error.message : String(error));
        const latestRecord = await this.promotionJournal
          .read(record.runId)
          .catch(() => record);
        const failedRecord = await this.promotionJournal
          .recordRecoveryError(record.runId, latestRecord.transaction, message)
          .catch(() => record);
        failures.push({
          runId: record.runId,
          agentId: record.agentId,
          message,
          transaction: failedRecord.transaction,
        });
      }
    }
    return { recovered, failures, protectedRunIds };
  }

  private async reconcilePromotion(
    initial: PromotionJournalRecord,
  ): Promise<ReconciledPromotion> {
    let record = structuredClone(initial);
    let transaction = structuredClone(record.transaction);
    transaction.recovery = {
      ...transaction.recovery,
      recoveredAfterRestart: true,
      recoveryError: null,
    };
    const recordResourceEvent = async (
      event: RunTransaction["providerResourceEvents"][number],
    ) => {
      appendBoundedResourceEvent(transaction.providerResourceEvents, event);
      record = await this.promotionJournal.updateTransaction(
        record.runId,
        transaction,
      );
      transaction = record.transaction;
    };

    if (record.phase === "validated") {
      const providerIds = providerIdsFromPlan(record.plan);
      const candidateResourcesRoot = await this.workspaces.promotionResourcesPath(
        record.plan,
      );
      const prepared = await this.resources.restorePrepared(
        candidateResourcesRoot,
        transaction.providerResources,
        { providerIds },
      );
      const installedVersions = await this.resources.promoteBeforeCanonical({
        agentId: record.agentId,
        runId: record.runId,
        candidateStateId: transaction.candidateStateId ?? record.plan.targetStateId,
        candidateResourcesRoot,
        prepared,
        plans: record.plan.resourcePlans,
        providerIds,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedVersions,
      );
      const installed = await this.workspaces.installPromotion(record.plan);
      record = await this.promotionJournal.advance(
        record.runId,
        "version-installed",
        { transaction, targetCanonical: installed },
      );
      transaction = record.transaction;
    }

    if (record.phase === "version-installed") {
      if (!record.targetCanonical) {
        throw new Error("Installed journal phase has no target fingerprints");
      }
      const installed = await this.workspaces.verifyInstalledPromotion(
        record.plan,
        record.targetCanonical,
      );
      await this.resources.reconcile({
        agentId: record.agentId,
        runId: record.runId,
        plans: record.plan.resourcePlans,
        expectedVersions: record.targetCanonical.providerVersions,
        visibility: "canonical-manifest",
        providerIds: providerIdsFromPlan(record.plan),
        onEvent: recordResourceEvent,
      });
      const canonical = await this.workspaces.advancePromotion(
        record.plan,
        installed,
      );
      transaction = this.recordCanonicalAdvance(transaction, canonical);
      record = await this.promotionJournal.advance(
        record.runId,
        "canonical-advanced",
        { transaction, targetCanonical: canonical },
      );
      transaction = record.transaction;
    }

    if (record.phase === "canonical-advanced") {
      const providerIds = providerIdsFromPlan(record.plan);
      const canonical = await this.verifyJournalCanonical(record);
      const installedResourcesRoot = await this.workspaces.installedResourcesPath(
        record.agentId,
        record.plan.targetStateId,
      );
      const prepared = await this.resources.restorePrepared(
        installedResourcesRoot,
        transaction.providerResources,
        { providerIds },
      );
      const installedVersions = await this.resources.promoteAfterCanonical({
        agentId: record.agentId,
        runId: record.runId,
        candidateStateId: transaction.candidateStateId ?? record.plan.targetStateId,
        candidateResourcesRoot: installedResourcesRoot,
        prepared,
        plans: record.plan.resourcePlans,
        providerIds,
        onEvent: recordResourceEvent,
      });
      transaction.providerResources = mergeInstalledProviderVersions(
        transaction.providerResources,
        installedVersions,
      );
      await this.resources.reconcile({
        agentId: record.agentId,
        runId: record.runId,
        plans: record.plan.resourcePlans,
        expectedVersions: canonical.providerVersions,
        visibility: "post-promotion-reconciled",
        providerIds,
        onEvent: recordResourceEvent,
      });
      const actionValidation = await this.actionOutbox.validate(
        path.join(canonical.outboxPath, "intents.jsonl"),
        record.runId,
      );
      if (actionValidation.evidence.status !== "passed") {
        throw new Error(actionValidation.evidence.summary);
      }
      const receipts = await this.actionDispatcher.dispatch(
        record.runId,
        actionValidation.intents,
      );
      transaction = this.finalizePromotedEffects(
        transaction,
        canonical,
        actionValidation.intents,
        receipts,
      );
      record = await this.promotionJournal.advance(
        record.runId,
        "effects-delivered",
        { transaction, targetCanonical: canonical },
      );
      transaction = record.transaction;
    }

    if (record.phase === "effects-delivered") {
      const canonical = await this.verifyJournalCanonical(record);
      await this.verifyProviderVersions(record, canonical, recordResourceEvent);
      await this.verifyDeliveredEffects(record, canonical);
      transaction = this.recordTransition(
        transaction,
        "promoted",
        "Promotion journal reconciled after server restart",
      );
      record = await this.promotionJournal.advance(record.runId, "completed", {
        transaction,
        targetCanonical: record.targetCanonical,
      });
      transaction = record.transaction;
    } else if (record.phase === "completed") {
      const canonical = await this.verifyJournalCanonical(record);
      await this.verifyProviderVersions(record, canonical, recordResourceEvent);
      await this.verifyDeliveredEffects(record, canonical);
      transaction.recovery.recoveredAfterRestart = true;
      record = await this.promotionJournal.updateTransaction(
        record.runId,
        transaction,
      );
      transaction = record.transaction;
    }

    if (!record.targetCanonical) {
      throw new Error("Completed Promotion journal has no target fingerprints");
    }
    const canonicalState = await this.verifyJournalCanonical(record);
    return {
      runId: record.runId,
      agentId: record.agentId,
      result: record.recoveryResult,
      transaction,
      canonicalState,
    };
  }

  private async verifyJournalCanonical(
    record: PromotionJournalRecord,
  ): Promise<CanonicalStateReference> {
    if (!record.targetCanonical) {
      throw new Error("Promotion journal has no target fingerprints");
    }
    const installed = await this.workspaces.verifyInstalledPromotion(
      record.plan,
      record.targetCanonical,
    );
    return this.workspaces.advancePromotion(record.plan, installed);
  }

  private async verifyDeliveredEffects(
    record: PromotionJournalRecord,
    canonical: CanonicalStateReference,
  ): Promise<void> {
    const actionValidation = await this.actionOutbox.validate(
      path.join(canonical.outboxPath, "intents.jsonl"),
      record.runId,
    );
    if (actionValidation.evidence.status !== "passed") {
      throw new Error(actionValidation.evidence.summary);
    }
    const receipts = await this.actionDispatcher.dispatch(
      record.runId,
      actionValidation.intents,
    );
    const expectedKeys = record.transaction.externalActions.intents
      .map((intent) => intent.idempotencyKey)
      .sort();
    const actualKeys = receipts.map((receipt) => receipt.idempotencyKey).sort();
    if (
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) => key !== actualKeys[index])
    ) {
      throw new Error("Delivered effects contradict the Promotion journal");
    }
  }

  private async verifyProviderVersions(
    record: PromotionJournalRecord,
    canonical: CanonicalStateReference,
    onEvent: (event: RunTransaction["providerResourceEvents"][number]) => void,
  ): Promise<void> {
    await this.resources.reconcile({
      agentId: record.agentId,
      runId: record.runId,
      plans: record.plan.resourcePlans,
      expectedVersions: canonical.providerVersions,
      visibility: "canonical-manifest",
      providerIds: providerIdsFromPlan(record.plan),
      onEvent,
    });
    await this.resources.reconcile({
      agentId: record.agentId,
      runId: record.runId,
      plans: record.plan.resourcePlans,
      expectedVersions: canonical.providerVersions,
      visibility: "post-promotion-reconciled",
      providerIds: providerIdsFromPlan(record.plan),
      onEvent,
    });
  }

  private recordCanonicalAdvance(
    transaction: RunTransaction,
    canonicalState: CanonicalStateReference,
  ): RunTransaction {
    const next = structuredClone(transaction);
    next.disposition = "promoted";
    next.quarantineAvailable = false;
    next.canonicalStateIdAfter = canonicalState.stateId;
    next.canonicalContentHashAfter = canonicalState.contentHash;
    if (next.sqlite) next.sqlite.after = next.sqlite.candidate;
    return next;
  }

  private finalizePromotedEffects(
    transaction: RunTransaction,
    canonicalState: CanonicalStateReference,
    parsedIntents: ParsedExternalActionIntent[],
    receipts: MockDeliveryReceipt[],
  ): RunTransaction {
    let next = structuredClone(transaction);
    next.externalActions.intents = intentEvidence(
      parsedIntents,
      "deferred",
      receipts,
    );
      next.externalActions.deliveredCount = receipts.length;
    next.providerResources = next.providerResources.map((resource) => ({
      ...resource,
      disposition: "promoted",
      summary: resource.label + " accepted in the new Canonical State",
    }));
    next = finalizeResources(next, "promoted", canonicalState, {
      sqlite: next.sqlite?.after?.contentHash ?? null,
      "external-actions": externalActionFingerprint(receipts),
    });
    next.promotionReceipt = createPromotionReceipt(next);
    return next;
  }

  private assertNotCancelled(agentId: string, executionId?: string): void {
    if (
      this.cancellationRequests.has(agentId) ||
      (executionId && this.executionCancellationRequests.has(executionId))
    ) {
      throw new RunCancelledError();
    }
  }

  private async transition(
    transaction: RunTransaction,
    status: RunTransactionStatus,
    summary: string,
    onProgress: TransactionProgress,
  ): Promise<RunTransaction> {
    const next = this.recordTransition(transaction, status, summary);
    await onProgress(next);
    return next;
  }

  private recordTransition(
    transaction: RunTransaction,
    status: RunTransactionStatus,
    summary: string,
  ): RunTransaction {
    const next = structuredClone(transaction);
    next.status = status;
    next.events.push({ status, at: now(), summary });
    return next;
  }
}

function assertRecoveryAuthority(
  record: PromotionJournalRecord,
  context: PromotionRecoveryAuthorityContext,
): void {
  const expected = context.expectedCandidateSetAuthorities.get(record.runId);
  if (record.authority.kind === "ordinary-run") {
    if (context.candidateSetRunIds.has(record.runId) || expected) {
      throw new Error(
        "Candidate Set Promotion journal is missing its persisted winner authority",
      );
    }
    return;
  }
  if (!expected) {
    throw new Error(
      "Candidate Set Promotion journal has no valid persisted winner authority",
    );
  }
  if (canonicalJson(record.authority) !== canonicalJson(expected)) {
    throw new Error(
      "Candidate Set Promotion journal contradicts its persisted winner authority",
    );
  }
}

export function finalizeResources(
  transaction: RunTransaction,
  disposition: "promoted" | "quarantined" | "discarded" | "cancelled",
  canonicalState?: CanonicalStateReference,
  fingerprints: Partial<
    Record<RunTransaction["resources"][number]["kind"], string | null>
  > = {},
): RunTransaction {
  const next = structuredClone(transaction);
  next.resources = next.resources.map((resource) => {
    const canonicalFingerprint =
      resource.kind === "workspace"
        ? canonicalState?.workspaceContentHash
        : resource.kind === "codex-session"
          ? canonicalState?.sessionContentHash
          : undefined;
    const fingerprintAfter =
      resource.kind in fingerprints
        ? fingerprints[resource.kind] ?? null
        : disposition === "promoted" && canonicalFingerprint
          ? canonicalFingerprint
          : resource.fingerprintBefore;
    return {
      ...resource,
      disposition,
      fingerprintAfter,
      summary:
        disposition === "promoted"
          ? resource.label + " accepted in the new Canonical State"
          : disposition === "discarded"
            ? resource.label + " Quarantine was discarded; Canonical State stayed unchanged"
          : resource.label + " remained on the prior Canonical State",
    };
  });
  return next;
}

function mergeProviderEvidence(
  existing: RunTransaction["providerResources"],
  evidence: readonly CoordinatedResourceEvidence[],
): RunTransaction["providerResources"] {
  const byProvider = new Map(evidence.map((resource) => [resource.providerId, resource]));
  return existing.map((resource) => {
    const accepted = byProvider.get(resource.providerId);
    if (!accepted) return resource;
    return {
      ...resource,
      change: structuredClone(accepted.change),
      validations: structuredClone(accepted.validations),
      summary: accepted.change.summary,
    };
  });
}

function providerRecordsFromPrepared(
  prepared: readonly CoordinatedPreparedResource[],
): RunTransaction["providerResources"] {
  return prepared.map((resource) => ({
    schemaVersion: 1,
    providerId: resource.providerId,
    resourceKind: resource.resourceKind,
    label: resource.label,
    required: resource.required,
    capabilities: structuredClone(resource.capabilities),
    source: structuredClone(resource.source),
    candidate: structuredClone(resource.candidate),
    runtimeBinding: resource.runtimeBinding
      ? {
          schemaVersion: 1,
          relativePath: resource.runtimeBinding.relativePath,
          access: resource.runtimeBinding.access,
        }
      : null,
    change: null,
    validations: [],
    promotionPlan: null,
    installedVersion: null,
    quarantine: null,
    disposition: null,
    summary: "Resource Provider Candidate is isolated from Canonical State",
  }));
}

function mergeProviderPlans(
  existing: RunTransaction["providerResources"],
  plans: readonly ResourcePromotionPlan[],
): RunTransaction["providerResources"] {
  const byProvider = new Map(plans.map((plan) => [plan.providerId, plan]));
  return existing.map((resource) => ({
    ...resource,
    promotionPlan: byProvider.get(resource.providerId) ?? resource.promotionPlan,
  }));
}

function mergeInstalledProviderVersions(
  existing: RunTransaction["providerResources"],
  versions: readonly ResourceVersionReference[],
): RunTransaction["providerResources"] {
  const byProvider = new Map(versions.map((version) => [version.providerId, version]));
  return existing.map((resource) => ({
    ...resource,
    installedVersion: byProvider.get(resource.providerId) ?? resource.installedVersion,
  }));
}

function providerEvidenceFromTransaction(
  transaction: RunTransaction,
): CoordinatedResourceEvidence[] {
  return transaction.providerResources.map((resource) => {
    if (!resource.change) {
      throw new Error(
        "Sealed Candidate is missing Resource Provider change evidence",
      );
    }
    return {
      schemaVersion: 1,
      providerId: resource.providerId,
      resourceKind: resource.resourceKind,
      label: resource.label,
      required: resource.required,
      capabilities: structuredClone(resource.capabilities),
      source: structuredClone(resource.source),
      candidate: structuredClone(resource.candidate),
      change: structuredClone(resource.change),
      validations: structuredClone(resource.validations),
      promotionPlan: null,
      installedVersion: null,
      quarantine: null,
    };
  });
}

function markProviderQuarantined(
  existing: RunTransaction["providerResources"],
  quarantines: readonly ResourceQuarantineHandle[],
): RunTransaction["providerResources"] {
  const byProvider = new Map(
    quarantines.map((quarantine) => [quarantine.providerId, quarantine]),
  );
  return existing.map((resource) => ({
    ...resource,
    quarantine: byProvider.get(resource.providerId) ?? resource.quarantine,
    disposition: byProvider.has(resource.providerId)
      ? "quarantined"
      : resource.disposition,
    summary: byProvider.has(resource.providerId)
      ? resource.label + " retained its rejected Candidate as Quarantine"
      : resource.label + " cleanup remains pending in composite Quarantine",
  }));
}

function markProvidersDiscarded(
  existing: RunTransaction["providerResources"],
  providerIds: readonly string[],
): RunTransaction["providerResources"] {
  const discarded = new Set(providerIds);
  return existing.map((resource) =>
    discarded.has(resource.providerId)
      ? {
          ...resource,
          disposition: "discarded" as const,
          summary: resource.label + " Candidate was discarded with retained evidence",
        }
      : resource,
  );
}

function markProviderDisposition(
  existing: RunTransaction["providerResources"],
  disposition: "cancelled" | "discarded",
): RunTransaction["providerResources"] {
  return existing.map((resource) => ({
    ...resource,
    disposition,
    summary:
      resource.label +
      (disposition === "cancelled"
        ? " Candidate was cancelled before Promotion"
        : " Quarantine was discarded"),
  }));
}

function markProviderPrepareRetained(
  existing: RunTransaction["providerResources"],
): RunTransaction["providerResources"] {
  return existing.map((resource) => ({
    ...resource,
    disposition: "quarantined",
    summary:
      resource.label +
      " Candidate was retained for idempotent cleanup after preparation failed",
  }));
}

function hasFailedProviderPrepare(transaction: RunTransaction): boolean {
  return transaction.providerResourceEvents.some(
    (event) => event.stage === "prepare" && event.status === "failed",
  );
}

function versionFromResourcePlan(
  plan: ResourcePromotionPlan,
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId: plan.providerId,
    resourceKind: plan.resourceKind,
    versionId: plan.targetVersionId,
    fingerprint: plan.targetFingerprint,
    metadata: structuredClone(plan.metadata),
  };
}

function providerIdsFromPlan(plan: {
  sourceProviderVersions: readonly ResourceVersionReference[];
}): string[] {
  return plan.sourceProviderVersions.map((version) => version.providerId);
}

function providerIdsFromTransaction(transaction: RunTransaction): string[] {
  return transaction.providerResources.map((resource) => resource.providerId);
}

function lifecycleFailureStage(error: unknown) {
  return error instanceof ResourceLifecycleError ? error.stage : ("runtime" as const);
}

function externalActionFingerprint(
  receipts: Array<{ idempotencyKey: string; deliveredAt: string }>,
): string {
  const normalized = receipts
    .map((receipt) => ({
      idempotencyKey: receipt.idempotencyKey,
      deliveredAt: receipt.deliveredAt,
    }))
    .sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
  return (
    "sha256:" +
    createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
  );
}

function createSealedCandidateReference(input: {
  identity: DeferredSelectionIdentity;
  transaction: RunTransaction;
  result: RunnerResult;
}): SealedCandidateReference {
  if (!input.transaction.candidateStateId) {
    throw new Error("Eligible Candidate has no Candidate State identifier");
  }
  const unsigned = {
    schemaVersion: 1 as const,
    candidateSetId: input.identity.candidateSetId,
    competitorId: input.identity.competitorId,
    runId: input.transaction.id,
    candidateStateId: input.transaction.candidateStateId,
    sourceStateId: input.transaction.canonicalStateIdBefore,
    sourceContentHash: input.transaction.canonicalContentHashBefore,
    outcomeContractVersion: input.transaction.outcomeContractVersion,
    transactionEvidenceHash: evidenceHash(input.transaction),
    runtimeResultHash: evidenceHash(input.result),
    sealedAt: now(),
  };
  return {
    ...unsigned,
    sealDigest: evidenceHash(unsigned),
  };
}

function verifySealedCandidateReference(
  seal: SealedCandidateReference,
  transaction: RunTransaction,
  result: RunnerResult,
): void {
  const unsigned = {
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
  };
  if (
    seal.schemaVersion !== 1 ||
    seal.transactionEvidenceHash !== evidenceHash(transaction) ||
    seal.runtimeResultHash !== evidenceHash(result) ||
    seal.sealDigest !== evidenceHash(unsigned) ||
    seal.candidateStateId !== transaction.candidateStateId ||
    seal.sourceStateId !== transaction.canonicalStateIdBefore ||
    seal.sourceContentHash !== transaction.canonicalContentHashBefore ||
    seal.outcomeContractVersion !== transaction.outcomeContractVersion
  ) {
    throw new Error("Selected Candidate seal failed deterministic verification");
  }
}

function assertSealedCandidateUnchanged(input: {
  transaction: RunTransaction;
  changes: RunTransaction["changes"];
  validations: RunTransaction["validations"];
  sqliteContentHash: string;
  intents: RunTransaction["externalActions"]["intents"];
  providerEvidence: readonly CoordinatedResourceEvidence[];
}): void {
  const failedRequired = input.validations.find(
    (validation) => validation.required && validation.status !== "passed",
  );
  if (failedRequired) {
    throw new Error(
      "Selected Candidate failed Promotion-time Validation: " +
        failedRequired.name,
    );
  }
  if (evidenceHash(input.changes) !== evidenceHash(input.transaction.changes)) {
    throw new Error("Selected Candidate workspace changed after it was sealed");
  }
  if (
    !input.transaction.sqlite?.candidate ||
    input.transaction.sqlite.candidate.contentHash !== input.sqliteContentHash
  ) {
    throw new Error("Selected Candidate SQLite state changed after it was sealed");
  }
  if (
    evidenceHash(input.intents) !==
    evidenceHash(input.transaction.externalActions.intents)
  ) {
    throw new Error("Selected Candidate outbox changed after it was sealed");
  }
  const storedProviders = new Map(
    input.transaction.providerResources.map((resource) => [
      resource.providerId,
      resource,
    ]),
  );
  if (storedProviders.size !== input.providerEvidence.length) {
    throw new Error("Selected Candidate Resource Provider set changed after sealing");
  }
  for (const evidence of input.providerEvidence) {
    const stored = storedProviders.get(evidence.providerId);
    if (
      !stored ||
      evidenceHash(evidence.candidate) !== evidenceHash(stored.candidate) ||
      evidence.change.fingerprintCandidate !== stored.change?.fingerprintCandidate ||
      evidence.change.fingerprintBefore !== stored.change?.fingerprintBefore
    ) {
      throw new Error(
        "Selected Candidate Resource Provider state changed after sealing",
      );
    }
  }
}

function evidenceHash(value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256").update(canonicalJson(value)).digest("hex")
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        )
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export function createPromotionReceipt(
  transaction: RunTransaction,
): PromotionReceipt {
  if (
    !transaction.disposition ||
    !transaction.canonicalStateIdAfter ||
    !transaction.canonicalContentHashAfter
  ) {
    throw new Error("Cannot create a receipt for an incomplete Run Transaction");
  }
  const validationEvidenceHash =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(transaction.validations))
      .digest("hex");
  return {
    runTransactionId: transaction.id,
    disposition: transaction.disposition,
    outcomeContractVersion: transaction.outcomeContractVersion,
    canonicalStateIdBefore: transaction.canonicalStateIdBefore,
    canonicalStateIdAfter: transaction.canonicalStateIdAfter,
    canonicalContentHashBefore: transaction.canonicalContentHashBefore,
    canonicalContentHashAfter: transaction.canonicalContentHashAfter,
    validationEvidenceHash,
    lineage: structuredClone(transaction.lineage),
    createdAt: now(),
  };
}
