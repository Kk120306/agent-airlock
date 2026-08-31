import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  LocalTransparencyLog,
  buildReceiverCustodyPacket,
  buildReceiverCustodyRecord,
  buildFederatedWorkBundle,
  buildPortableDecisionChain,
  buildPortableEvidencePacket,
  evaluateSigningKeyTrust,
  encodeOfflineEvmAnchorPayload,
  loadOrCreatePortableSigningKey,
  signPortableReceipt,
  verifyFederatedWorkBundle,
  verifyPortablePromotionEnvelope,
  verifyReceiverCustodyPacket,
  verifySignedSigningKeyTrustPolicyEnvelope,
  type FederatedWorkBundle,
  type ReceiptDigest,
  type ReceiverCustodyManifest,
  type SignedSigningKeyTrustPolicyEnvelope,
} from "@agent-airlock/portable-promotion-receipt";
import { redactSensitiveText } from "@agent-airlock/transactional-resource-sdk";
import {
  AirlockRunError,
  AirlockRunner,
  StaleCandidateSourceError,
  createPromotionReceipt,
  createRunTransaction,
  finalizeResources,
  type PromotionFaultInjector,
} from "./airlock-runner.js";
import {
  SELECTION_CRITERIA,
  createQualityAssertion,
  replayCandidateSelection,
  selectCandidates,
  stableJson,
} from "./candidate-selection.js";
import {
  applyAssuranceOperations,
  deriveAssuranceProposal,
  outcomeContractHash,
  verifyAssuranceProposalIntegrity,
} from "./assurance.js";
import { validateCandidateSetInput } from "./candidate-set.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  AgentDeletionJournal,
  MAXIMUM_ARCHIVED_CANDIDATE_SET_SUMMARIES,
  MAXIMUM_ARCHIVED_CONTRACT_VERSION_SUMMARIES,
  MAXIMUM_ARCHIVED_PROPOSAL_SUMMARIES,
  MAXIMUM_ARCHIVED_RUN_SUMMARIES,
  type AgentArchiveAudit,
} from "./agent-deletion-journal.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { buildExecutionProfileEvidence } from "./execution-profile.js";
import {
  type ExternalActionDeliveryReceipt,
  type ExternalActionDispatcher,
  ExternalActionOutbox,
  HttpExternalActionDispatcher,
  MockExternalActionDispatcher,
} from "./external-actions.js";
import {
  FederatedAdmissionCoordinator,
  FederatedAdmissionJournal,
  type FederatedAdmissionRecord,
} from "./federated-admission-journal.js";
import {
  FederatedAdmissionPolicyStore,
  type FederatedAdmissionPolicy,
} from "./federated-admission-policy.js";
import {
  FederatedApprovalCoordinator,
  FederatedApprovalJournal,
  type FederatedApprovalChoice,
  type FederatedApprovalDecisionRecord,
} from "./federated-approval-journal.js";
import {
  createDefaultOutcomeContract,
  createNextOutcomeContract,
} from "./outcome-contract.js";
import {
  OutcomeValidator,
  matchesOutcomePathPattern,
} from "./outcome-validator.js";
import {
  buildPortableReceiptDraft,
  type PortableReceiptDraft,
} from "./portable-receipt.js";
import {
  PortableDecisionJournal,
  assertPromotionRecoveryProgress,
  assertQuarantineCleanupProgress,
  hasCompleteProviderDiscardEvidence,
  portableCandidateSetAuthorityHash,
  portableDecisionTransactionHash,
  type CandidateSetDecisionAuthorityRecord,
  type PortableDecisionAuthorityRecord,
} from "./portable-decision-journal.js";
import {
  PromotionJournal,
  type PromotionAuthority,
} from "./promotion-journal.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import { JsonStore } from "./store.js";
import { SqliteResource } from "./sqlite-resource.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AssuranceProposal,
  CandidateSet,
  CandidateSetCompetitor,
  CanonicalStateReference,
  CreateAgentInput,
  CreateCandidateSetInput,
  Database,
  Message,
  OutcomeContract,
  OutcomeContractInput,
  OutcomeContractVersionRecord,
  RunTransaction,
  UpdateAgentInput,
} from "./types.js";
import {
  createStructuralValidators,
  createValidationCommandExecutor,
  type ValidationCommandExecutor,
} from "./validation-command-runner.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceFederatedCandidateAdapter } from "./workspace-federated-candidate-adapter.js";

const now = () => new Date().toISOString();

export interface FederatedImportInput {
  transferId: string;
  producerId: string;
  bundle: FederatedWorkBundle;
  trustPolicy: SignedSigningKeyTrustPolicyEnvelope;
}

export interface FederatedImportResult {
  admission: FederatedAdmissionRecord;
  run: AgentRun | null;
}

export interface FederatedApprovalDecisionResult {
  admission: FederatedAdmissionRecord;
  approval: FederatedApprovalDecisionRecord;
  run: AgentRun | null;
}

export type FederatedAdmissionInboxState =
  | "pending"
  | "approved"
  | "denied"
  | "promoted"
  | "quarantined"
  | "failed"
  | "rejected";

export interface FederatedAdmissionInboxItem {
  admission: FederatedAdmissionRecord;
  approval: FederatedApprovalDecisionRecord | null;
  review: FederatedAdmissionReview | null;
  run: Pick<AgentRun, "id" | "status"> & {
    disposition: RunTransaction["disposition"];
  } | null;
  state: FederatedAdmissionInboxState;
}

export interface FederatedAdmissionReview {
  schemaVersion: 1;
  authority: "producer-claim-non-authoritative";
  decisionContextDigest: ReceiptDigest;
  producerClaim: {
    runId: string;
    agentId: string;
    disposition: "promoted" | "quarantined" | "discarded" | "cancelled";
    decidedAt: string;
    outcomeContractVersion: number;
  };
  artifact: {
    operationCount: number;
    displayedOperationCount: number;
    truncated: boolean;
    totalPayloadBytes: number;
    operations: Array<{
      operation: "add" | "modify" | "delete" | "rename";
      path: string;
      toPath: string | null;
      byteLength: number | null;
    }>;
  };
  resources: {
    builtinBefore: number;
    builtinAfter: number;
    providerBefore: number;
    providerAfter: number;
  };
  preflight: {
    authority: "metadata-only-not-validation";
    contractVersion: number;
    status: "no-metadata-blocker" | "predicted-blocker";
    affectedPathCount: number;
    blockers: Array<{
      code:
        | "protected-path-change"
        | "changed-files-limit"
        | "added-bytes-limit"
        | "required-literal-removed";
      summary: string;
      paths: string[];
    }>;
    deferredChecks: Array<
      | "required-glob-presence"
      | "rename-payload-size"
      | "secret-content-scan"
      | "validation-commands"
      | "candidate-resource-validation"
    >;
  };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly configuringAgents = new Set<string>();
  private readonly deletingAgents = new Set<string>();
  private readonly quarantineOperations = new Set<string>();
  private readonly federatedDecisionOperations = new Map<
    string,
    Promise<void>
  >();
  private readonly runner: AirlockRunner;
  private readonly actionDispatcher: ExternalActionDispatcher;
  private readonly promotionJournal: PromotionJournal;
  private readonly portableDecisionJournal: PortableDecisionJournal;
  private readonly agentDeletionJournal: AgentDeletionJournal;
  private readonly federatedAdmissionPolicies: FederatedAdmissionPolicyStore;
  private readonly federatedAdmissionJournal: FederatedAdmissionJournal;
  private readonly federatedAdmissionCoordinator: FederatedAdmissionCoordinator;
  private readonly federatedApprovalJournal: FederatedApprovalJournal;
  private readonly federatedApprovalCoordinator: FederatedApprovalCoordinator;
  private readonly runnerEnforcesTokenBudgets: boolean;
  private transparencyOperation: Promise<void> = Promise.resolve();
  private providerRegistryReady = false;
  private actionDispatcherReadinessError: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    runner: AgentRunner,
    validationCommandExecutor: ValidationCommandExecutor =
      createValidationCommandExecutor(config),
    promotionFaultInjector?: PromotionFaultInjector,
    private readonly resourceCoordinator: ResourceCoordinator = new ResourceCoordinator(
      new ResourceRegistry(),
    ),
    externalActionDispatcher?: ExternalActionDispatcher,
  ) {
    this.runnerEnforcesTokenBudgets =
      runner.tokenBudgetEnforcement === "provider-boundary";
    this.actionDispatcher =
      externalActionDispatcher ??
      (config.externalActionWebhookUrl
        ? new HttpExternalActionDispatcher(
            config.externalActionWebhookUrl,
            path.join(config.dataDirectory, "http-delivery-receipts.json"),
          )
        : new MockExternalActionDispatcher(
            path.join(config.dataDirectory, "mock-deliveries.json"),
          ));
    this.promotionJournal = new PromotionJournal(
      path.join(config.dataDirectory, "promotion-journal"),
    );
    this.portableDecisionJournal = new PortableDecisionJournal(
      path.join(config.dataDirectory, "portable-decision-journal"),
    );
    this.agentDeletionJournal = new AgentDeletionJournal(
      path.join(config.dataDirectory, "agent-deletion-journal"),
    );
    this.federatedAdmissionPolicies = new FederatedAdmissionPolicyStore(
      path.join(config.dataDirectory, "federated-admission-policies"),
    );
    this.federatedAdmissionJournal = new FederatedAdmissionJournal(
      path.join(config.dataDirectory, "federated-admission-journal"),
    );
    this.federatedAdmissionCoordinator = new FederatedAdmissionCoordinator(
      this.federatedAdmissionPolicies,
      this.federatedAdmissionJournal,
      new WorkspaceFederatedCandidateAdapter(workspaces),
    );
    this.federatedApprovalJournal = new FederatedApprovalJournal(
      path.join(config.dataDirectory, "federated-approval-journal"),
    );
    this.federatedApprovalCoordinator = new FederatedApprovalCoordinator(
      this.federatedAdmissionJournal,
      this.federatedApprovalJournal,
      new WorkspaceFederatedCandidateAdapter(workspaces),
    );
    const controlPlaneSensitiveValues = [config.arkApiKey, config.authToken];
    this.runner = new AirlockRunner(
      runner,
      workspaces,
      new OutcomeValidator(
        validationCommandExecutor,
        controlPlaneSensitiveValues,
        createStructuralValidators(config),
      ),
      new SqliteResource(controlPlaneSensitiveValues),
      new ExternalActionOutbox(controlPlaneSensitiveValues),
      this.actionDispatcher,
      this.promotionJournal,
      this.resourceCoordinator,
      promotionFaultInjector,
      buildExecutionProfileEvidence(config),
      (error, fallback) => boundedPersistedError(error, fallback, config),
    );
  }

  async initialize(): Promise<void> {
    this.providerRegistryReady = false;
    this.actionDispatcherReadinessError = null;
    await this.store.initialize();
    await this.sanitizePersistedErrors();
    await this.workspaces.initialize({
      recoverProviderRegistryTransitions: false,
    });
    await this.actionDispatcher.initialize();
    await this.promotionJournal.initialize();
    await this.portableDecisionJournal.initialize();
    await this.agentDeletionJournal.initialize();
    await this.federatedAdmissionPolicies.initialize();
    await this.federatedAdmissionJournal.initialize();
    await this.federatedApprovalJournal.initialize();
    await this.reconcileAgentDeletions();
    await this.workspaces.recoverProviderRegistryTransitions();
    const registryDescriptors = this.resourceCoordinator.registryDescriptors();
    const registryGeneration =
      await this.workspaces.nextProviderRegistryGeneration(registryDescriptors);
    const snapshot = this.store.snapshot();
    const promotionAuthority =
      await this.buildPromotionRecoveryAuthorityContext(
        snapshot.candidateSets,
        snapshot.runs,
      );
    const unresolvedCandidateSetRunIds = new Set(
      snapshot.candidateSets
        .filter(
          (candidateSet) =>
            candidateSet.phase !== "completed" &&
            candidateSet.phase !== "stale" &&
            candidateSet.phase !== "recovery-error",
        )
        .flatMap((candidateSet) =>
          candidateSet.competitors.map((competitor) => competitor.runId),
        ),
    );
    const recoverCompletedRunIds = new Set(
      snapshot.runs
        .filter(
          (run) =>
            run.status !== "completed" ||
            unresolvedCandidateSetRunIds.has(run.id),
        )
        .map((run) => run.id),
    );
    const recovery = await this.runner.reconcilePromotions(
      recoverCompletedRunIds,
      {
        candidateSetRunIds: promotionAuthority.candidateSetRunIds,
        expectedCandidateSetAuthorities:
          promotionAuthority.expectedCandidateSetAuthorities,
        expectedFederatedAuthorities:
          promotionAuthority.expectedFederatedAuthorities,
        terminalPromotionTransactions:
          promotionAuthority.terminalPromotionTransactions,
      },
    );
    const recoveredRunIds = new Set(
      recovery.recovered.map((item) => item.runId),
    );
    const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
    const enrichPromotionRecoveryFailure = async (
      run: AgentRun,
      sourceTransaction: RunTransaction | null,
      sourceMessage: string,
      markRecoveredAfterRestart: boolean,
    ) => {
      if (!sourceTransaction) {
        return { message: sourceMessage, transaction: null };
      }
      const failedTransaction = structuredClone(sourceTransaction);
      let message = sourceMessage;
      try {
        const canonical =
          await this.workspaces.readCanonicalForProviderTransition(run.agentId);
        if (
          failedTransaction.candidateStateId !== null &&
          canonical.stateId === failedTransaction.candidateStateId
        ) {
          failedTransaction.disposition = "promoted";
          failedTransaction.quarantineAvailable = false;
          failedTransaction.canonicalStateIdAfter = canonical.stateId;
          failedTransaction.canonicalContentHashAfter = canonical.contentHash;
          if (failedTransaction.sqlite) {
            failedTransaction.sqlite.after = failedTransaction.sqlite.candidate;
          }
          message += " after Canonical State advanced";
        } else if (
          canonical.stateId !== failedTransaction.canonicalStateIdBefore ||
          canonical.contentHash !== failedTransaction.canonicalContentHashBefore
        ) {
          message +=
            "; current Canonical State contradicts the interrupted Promotion";
        }
      } catch (error) {
        message +=
          "; Canonical State inspection failed closed: " +
          boundedPersistedError(
            error,
            "Canonical State inspection failed closed",
            this.config,
          );
      }
      failedTransaction.status = "recovery-error";
      failedTransaction.recovery = {
        ...failedTransaction.recovery,
        recoveredAfterRestart: markRecoveredAfterRestart
          ? true
          : failedTransaction.recovery.recoveredAfterRestart,
        recoveryError: message.slice(0, 500),
      };
      return { message, transaction: failedTransaction };
    };
    const recoveryFailures = new Map(
      recovery.failures
        .filter((failure) => failure.runId)
        .map((failure) => [failure.runId as string, failure]),
    );
    for (const [runId, failure] of recoveryFailures) {
      const run = runsById.get(runId);
      if (!run) continue;
      const enriched = await enrichPromotionRecoveryFailure(
        run,
        failure.transaction ?? run.transaction,
        failure.message,
        failure.transaction === null,
      );
      recoveryFailures.set(runId, {
        ...failure,
        agentId: run.agentId,
        ...enriched,
      });
    }
    for (const run of snapshot.runs) {
      const transaction = run.transaction;
      if (
        (run.status !== "queued" &&
          run.status !== "running" &&
          transaction?.status !== "promoting") ||
        transaction?.status === "recovery-error" ||
        transaction?.recovery.journalPhase == null ||
        recoveredRunIds.has(run.id) ||
        recovery.protectedRunIds.has(run.id) ||
        recoveryFailures.has(run.id)
      ) {
        continue;
      }
      const failure = await enrichPromotionRecoveryFailure(
        run,
        transaction,
        "Promotion journal is missing after durable Promotion began",
        true,
      );
      recoveryFailures.set(run.id, {
        runId: run.id,
        agentId: run.agentId,
        message: failure.message,
        transaction: failure.transaction,
      });
    }
    const interrupted = new Map<
      string,
      Awaited<ReturnType<WorkspaceManager["quarantineInterruptedCandidate"]>>
    >();
    const activeRunIds = snapshot.runs
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => run.id);
    const terminalAuthorityRecoveries = new Map<
      string,
      PortableDecisionAuthorityRecord
    >();
    const terminalAuthorities = new Map<
      string,
      PortableDecisionAuthorityRecord
    >();
    const terminalAuthorityFailures = new Map<string, string>();
    const quarantineCleanupProgressRunIds = new Set<string>();
    const authoritativeDiscardQuarantineRoots = new Set<string>();
    const authoritativeDiscardCandidateRoots = new Set<string>();
    const authoritativeDiscardMissingRoots = new Set<string>();
    const missingQuarantineRunIds = new Set<string>();
    for (const run of snapshot.runs) {
      try {
        const authority =
          await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
            run.id,
            run.agentId,
          );
        if (!authority) continue;
        this.assertTerminalAuthorityExtendsRun(run, authority.transaction);
        if (authority.candidateSetAuthorityDigest) {
          if (!run.candidateSetId) {
            throw new Error(
              "Candidate-bound terminal authority has no Candidate Set Run link",
            );
          }
          const candidateAuthority =
            await this.portableDecisionJournal.readCandidateSetDecisionById(
              run.candidateSetId,
            );
          if (
            !candidateAuthority ||
            candidateAuthority.agentId !== run.agentId ||
            candidateAuthority.candidateSetAuthorityDigest !==
              authority.candidateSetAuthorityDigest
          ) {
            throw new Error(
              "Candidate-bound terminal authority has no matching Selection authority",
            );
          }
        }
        const currentTransactionHash = run.transaction
          ? portableDecisionTransactionHash(run.transaction)
          : null;
        let quarantineCleanupProgress = false;
        let promotionRecoveryProgress = false;
        if (
          currentTransactionHash !== authority.transactionEvidenceHash &&
          run.transaction?.disposition === "quarantined" &&
          authority.disposition === "quarantined"
        ) {
          assertQuarantineCleanupProgress(
            authority.transaction,
            run.transaction,
          );
          quarantineCleanupProgress = true;
          quarantineCleanupProgressRunIds.add(run.id);
        }
        if (
          currentTransactionHash !== authority.transactionEvidenceHash &&
          run.transaction?.disposition === "promoted" &&
          authority.disposition === "promoted" &&
          authority.transaction.recovery.recoveredAfterRestart &&
          !run.transaction.recovery.recoveredAfterRestart
        ) {
          assertPromotionRecoveryProgress(
            authority.transaction,
            run.transaction,
          );
          promotionRecoveryProgress = true;
        }
        if (
          currentTransactionHash !== authority.transactionEvidenceHash &&
          run.transaction?.disposition &&
          !quarantineCleanupProgress &&
          !promotionRecoveryProgress &&
          !(
            run.transaction.disposition === "quarantined" &&
            authority.disposition === "discarded"
          )
        ) {
          throw new Error(
            "Immutable terminal decision contradicts the persisted terminal Run",
          );
        }
        const candidateLifecycleIsCurrent =
          this.candidateLifecycleMatchesAuthority(snapshot, run, authority);
        const requiresRecovery =
          currentTransactionHash !== authority.transactionEvidenceHash ||
          !terminalRunStatusMatches(authority.disposition, run.status) ||
          !candidateLifecycleIsCurrent;
        if (
          authority.disposition === "quarantined" &&
          !(await this.workspaces.quarantineExists(run.id))
        ) {
          missingQuarantineRunIds.add(run.id);
          throw new Error(
            "Authoritative Quarantine is missing from physical Candidate State",
          );
        }
        if (authority.disposition === "discarded") {
          const quarantineExists = await this.workspaces.quarantineExists(
            run.id,
          );
          const candidateExists = await this.workspaces.candidateExists(
            run.id,
            true,
          );
          if (quarantineExists && candidateExists) {
            throw new Error(
              "Authoritative Discard has both Candidate and Quarantine remnants",
            );
          }
          if (quarantineExists) {
            authoritativeDiscardQuarantineRoots.add(run.id);
          }
          if (candidateExists) {
            authoritativeDiscardCandidateRoots.add(run.id);
          }
          if (!quarantineExists && !candidateExists) {
            authoritativeDiscardMissingRoots.add(run.id);
          }
        }
        terminalAuthorities.set(run.id, authority);
        if (requiresRecovery) {
          terminalAuthorityRecoveries.set(run.id, authority);
        }
      } catch (error) {
        terminalAuthorityFailures.set(
          run.id,
          boundedCandidateSetError(error, this.config),
        );
      }
    }
    for (const runId of authoritativeDiscardQuarantineRoots) {
      try {
        const authority = terminalAuthorities.get(runId);
        if (!authority) {
          throw new Error("Authoritative Discard evidence disappeared");
        }
        await this.completeAuthorizedDiscard(authority, "quarantine");
      } catch (error) {
        terminalAuthorityRecoveries.delete(runId);
        terminalAuthorityFailures.set(
          runId,
          "Authoritative Discard cleanup failed: " +
            boundedCandidateSetError(error, this.config),
        );
      }
    }
    for (const runId of authoritativeDiscardCandidateRoots) {
      try {
        const authority = terminalAuthorities.get(runId);
        if (!authority) {
          throw new Error("Authoritative Discard evidence disappeared");
        }
        await this.completeAuthorizedDiscard(authority, "candidate");
      } catch (error) {
        terminalAuthorityRecoveries.delete(runId);
        terminalAuthorityFailures.set(
          runId,
          "Authoritative Discard cleanup failed: " +
            boundedCandidateSetError(error, this.config),
        );
      }
    }
    for (const runId of authoritativeDiscardMissingRoots) {
      try {
        const authority = terminalAuthorities.get(runId);
        if (!authority) {
          throw new Error("Authoritative Discard evidence disappeared");
        }
        await this.completeAuthorizedDiscard(authority, null);
      } catch (error) {
        terminalAuthorityRecoveries.delete(runId);
        terminalAuthorityFailures.set(
          runId,
          "Authoritative Discard cleanup failed: " +
            boundedCandidateSetError(error, this.config),
        );
      }
    }
    for (const runId of activeRunIds) {
      if (
        recoveredRunIds.has(runId) ||
        recovery.protectedRunIds.has(runId) ||
        recoveryFailures.has(runId)
      ) {
        continue;
      }
      if (
        terminalAuthorityRecoveries.has(runId) ||
        terminalAuthorityFailures.has(runId)
      ) {
        continue;
      }
      interrupted.set(
        runId,
        await this.workspaces.quarantineInterruptedCandidate(runId),
      );
    }

    const protectedRunIds = new Set([
      ...recovery.protectedRunIds,
      ...recoveryFailures.keys(),
      ...activeRunIds,
      ...snapshot.runs
        .filter(
          (run) =>
            run.transaction?.status === "recovery-error" ||
            Boolean(run.transaction?.recovery.recoveryError),
        )
        .map((run) => run.id),
      ...unresolvedCandidateSetRunIds,
      ...terminalAuthorityFailures.keys(),
      ...[...terminalAuthorityRecoveries.keys()].filter(
        (runId) => !quarantineCleanupProgressRunIds.has(runId),
      ),
    ]);
    const cleanupTransactions = new Map<string, RunTransaction>();
    const cleanupAuthorities = new Map<
      string,
      PortableDecisionAuthorityRecord
    >();
    const startupTime = Date.now();
    const cleanup = await this.workspaces.cleanupExpiredState({
      candidateOlderThan: new Date(
        startupTime - this.config.candidateRetentionMs,
      ).toISOString(),
      quarantineOlderThan: new Date(
        startupTime - this.config.quarantineRetentionMs,
      ).toISOString(),
      protectedRunIds,
      beforeRemove: async ({ kind, runId, root }) => {
        const run = runsById.get(runId);
        if (!run?.transaction) return;
        const hasProviderCleanup =
          run.transaction.providerResources.length > 0 ||
          run.transaction.providerResourceEvents.some(
            (event) => event.stage === "prepare" && event.status === "failed",
          );
        if (kind === "candidate" && !hasProviderCleanup) return;
        const terminalAuthority = terminalAuthorities.get(runId);
        const cleanupSource =
          kind === "quarantine" &&
          terminalAuthority?.disposition === "quarantined"
            ? terminalAuthority.transaction
            : (cleanupTransactions.get(runId) ?? run.transaction);
        if (kind === "quarantine") {
          const finalTransaction = markTransactionDiscarded(
            cleanupSource,
            now(),
            true,
          );
          const authority = await this.recordPortableDecisionAuthority(
            runId,
            finalTransaction,
          );
          if (!authority) {
            throw new Error(
              "Quarantine cleanup did not publish terminal Discard authority",
            );
          }
          cleanupAuthorities.set(runId, authority);
          cleanupTransactions.set(runId, finalTransaction);
          const cleaned = await this.runner.discardRetainedProviderState(
            run.agentId,
            finalTransaction,
            root,
          );
          if (requiresProviderDiscardCleanupFact(finalTransaction)) {
            await this.portableDecisionJournal.recordDiscardCleanup(
              authority,
              cleaned,
            );
          }
          return;
        }
        const cleaned = await this.runner.discardRetainedProviderState(
          run.agentId,
          cleanupSource,
          root,
          async (progress) => {
            cleanupTransactions.set(runId, structuredClone(progress));
            await this.store.mutate((database) => {
              const storedRun = database.runs.find((item) => item.id === runId);
              if (storedRun?.transaction) {
                storedRun.transaction = structuredClone(progress);
              }
            });
          },
        );
        cleanupTransactions.set(runId, cleaned);
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === runId);
          if (storedRun?.transaction) {
            storedRun.transaction = structuredClone(cleaned);
          }
        });
      },
    });

    for (const [runId, authority] of cleanupAuthorities) {
      terminalAuthorities.set(runId, authority);
      try {
        if (await this.workspaces.quarantineExists(runId)) {
          throw new Error(
            "Authoritative Discard left a retained Quarantine remnant",
          );
        }
        terminalAuthorityRecoveries.set(runId, authority);
        terminalAuthorityFailures.delete(runId);
      } catch (error) {
        terminalAuthorityRecoveries.delete(runId);
        terminalAuthorityFailures.set(
          runId,
          "Authoritative Discard cleanup failed: " +
            boundedCandidateSetError(error, this.config),
        );
      }
    }
    const startupAuthorityRunIds = new Set<string>();
    for (const run of snapshot.runs) {
      if (
        run.transaction?.disposition !== "quarantined" ||
        !run.transaction.quarantineAvailable ||
        cleanup.quarantineRunIds.includes(run.id) ||
        terminalAuthorityRecoveries.has(run.id) ||
        terminalAuthorityFailures.has(run.id)
      ) {
        continue;
      }
      try {
        if (await this.workspaces.quarantineExists(run.id)) continue;
        missingQuarantineRunIds.add(run.id);
        terminalAuthorityFailures.set(
          run.id,
          "Mutable Quarantine is missing without immutable Discard authority",
        );
      } catch (error) {
        terminalAuthorityFailures.set(
          run.id,
          "Quarantine inspection failed: " +
            boundedCandidateSetError(error, this.config),
        );
      }
    }

    await this.store.mutate(async (database) => {
      for (const recovered of recovery.recovered) {
        const run = database.runs.find((item) => item.id === recovered.runId);
        const agent = database.agents.find(
          (item) => item.id === recovered.agentId,
        );
        if (
          !run ||
          !agent ||
          (run.status === "completed" && !run.candidateSetId)
        ) {
          continue;
        }
        const completedAt = now();
        run.status = "completed";
        run.output = recovered.result.output;
        run.error = null;
        run.usage = recovered.result.usage;
        const existingAuthority = terminalAuthorities.get(run.id);
        const recoveryTransactionHash = portableDecisionTransactionHash(
          recovered.transaction,
        );
        const authorityAlreadyRecovered = Boolean(
          existingAuthority &&
          (existingAuthority.transactionEvidenceHash ===
            recoveryTransactionHash ||
            isEquivalentRecoveredPromotionReplay(
              existingAuthority.transaction,
              recovered.transaction,
            )),
        );
        run.transaction = structuredClone(
          authorityAlreadyRecovered && existingAuthority
            ? existingAuthority.transaction
            : recovered.transaction,
        );
        if (existingAuthority) {
          this.applyCandidateLifecycleAuthority(
            database,
            run,
            existingAuthority,
          );
        }
        if (!authorityAlreadyRecovered) {
          startupAuthorityRunIds.add(run.id);
        }
        run.completedAt = completedAt;
        if (
          !run.candidateSetId &&
          !database.messages.some(
            (message) =>
              message.runId === run.id && message.role === "assistant",
          )
        ) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: recovered.result.output,
            createdAt: completedAt,
          });
        }
        agent.workspacePath = recovered.canonicalState.workspacePath;
        agent.canonicalStateId = recovered.canonicalState.stateId;
        agent.codexThreadId = recovered.canonicalState.codexThreadId;
        agent.status = "ready";
        agent.lastError = null;
        agent.updatedAt = completedAt;
      }

      for (const [runId, failure] of recoveryFailures) {
        const run = database.runs.find((item) => item.id === runId);
        if (!run) continue;
        const safeFailureMessage = boundedPersistedError(
          failure.message,
          "Promotion recovery failed closed",
          this.config,
        );
        const safeFailureTransaction = failure.transaction
          ? sanitizeTransactionRecoveryError(failure.transaction, this.config)
          : null;
        run.status = "failed";
        run.error = safeFailureMessage;
        run.completedAt = now();
        const existingAuthority = terminalAuthorities.get(runId);
        if (
          existingAuthority?.disposition === "promoted" &&
          safeFailureTransaction?.disposition === "promoted"
        ) {
          run.transaction = sanitizeTransactionRecoveryError(
            existingAuthority.transaction,
            this.config,
          );
        } else if (safeFailureTransaction) {
          run.transaction = safeFailureTransaction;
        } else if (run.transaction) {
          run.transaction.status = "recovery-error";
          run.transaction.recovery = {
            ...run.transaction.recovery,
            recoveredAfterRestart: true,
            recoveryError: safeFailureMessage,
          };
        }
      }

      for (const run of database.runs) {
        if (recoveredRunIds.has(run.id) || recoveryFailures.has(run.id)) {
          continue;
        }
        const terminalAuthority = terminalAuthorityRecoveries.get(run.id);
        const terminalAuthorityFailure = terminalAuthorityFailures.get(run.id);
        if (terminalAuthorityFailure) {
          const safeTerminalAuthorityFailure = boundedPersistedError(
            terminalAuthorityFailure,
            "Immutable terminal decision recovery failed closed",
            this.config,
          );
          run.status = "failed";
          run.error = (
            "Immutable terminal decision recovery failed: " +
            safeTerminalAuthorityFailure
          ).slice(0, 500);
          run.completedAt = now();
          if (run.transaction) {
            run.transaction.status = "recovery-error";
            if (missingQuarantineRunIds.has(run.id)) {
              run.transaction.quarantineAvailable = false;
            }
            run.transaction.recovery = {
              ...run.transaction.recovery,
              recoveredAfterRestart: true,
              recoveryError: safeTerminalAuthorityFailure,
            };
          }
          continue;
        }
        if (terminalAuthority) {
          const wasActive = run.status === "queued" || run.status === "running";
          const transaction = structuredClone(terminalAuthority.transaction);
          run.transaction = transaction;
          run.status = terminalRunStatus(terminalAuthority.disposition);
          if (wasActive) {
            run.error =
              transaction.disposition === "quarantined"
                ? "Server restarted after the authoritative Quarantine decision"
                : transaction.disposition === "cancelled"
                  ? "Server restarted after the authoritative cancellation decision"
                  : null;
            run.completedAt = transaction.promotionReceipt!.createdAt;
          } else if (!run.completedAt) {
            run.completedAt = transaction.promotionReceipt!.createdAt;
          }
          this.applyCandidateLifecycleAuthority(
            database,
            run,
            terminalAuthority,
          );
          continue;
        }
        if (run.status !== "queued" && run.status !== "running") {
          continue;
        }
        const retained = interrupted.get(run.id);
        const completedAt = now();
        run.completedAt = completedAt;
        if (retained?.quarantinePath && run.transaction) {
          run.status = "failed";
          run.error =
            "Server restarted; the interrupted Candidate was retained in Quarantine";
          run.transaction.status = "quarantined";
          run.transaction.disposition = "quarantined";
          run.transaction.quarantinePath = retained.quarantinePath;
          run.transaction.quarantineAvailable = true;
          run.transaction.canonicalStateIdAfter =
            run.transaction.canonicalStateIdBefore;
          run.transaction.canonicalContentHashAfter =
            run.transaction.canonicalContentHashBefore;
          run.transaction = completeInterruptedValidationEvidence(
            run.transaction,
            "Validation was skipped because the server restarted during execution",
          );
          run.transaction = finalizeResources(run.transaction, "quarantined");
          run.transaction.events.push({
            status: "quarantined",
            at: completedAt,
            summary:
              "Server restart retained the interrupted Candidate in Quarantine",
          });
          run.transaction.promotionReceipt = createPromotionReceipt(
            run.transaction,
          );
          startupAuthorityRunIds.add(run.id);
        } else if (retained?.error && run.transaction) {
          const safeRetainedError = boundedPersistedError(
            retained.error,
            "Interrupted Candidate recovery failed closed",
            this.config,
          );
          run.status = "failed";
          run.error = (
            "Interrupted Candidate recovery failed: " + safeRetainedError
          ).slice(0, 500);
          run.transaction.status = "recovery-error";
          run.transaction.recovery = {
            ...run.transaction.recovery,
            recoveredAfterRestart: true,
            recoveryError: safeRetainedError,
          };
        } else {
          run.status = "cancelled";
          run.error = "Server restarted before Candidate State was available";
          if (run.transaction) {
            run.transaction.status = "cancelled";
            run.transaction.disposition = "cancelled";
            run.transaction.canonicalStateIdAfter =
              run.transaction.canonicalStateIdBefore;
            run.transaction.canonicalContentHashAfter =
              run.transaction.canonicalContentHashBefore;
            run.transaction = completeInterruptedValidationEvidence(
              run.transaction,
              "Validation was skipped because the server restarted before Candidate State was available",
            );
            run.transaction = finalizeResources(run.transaction, "cancelled");
            run.transaction.events.push({
              status: "cancelled",
              at: completedAt,
              summary: "Server restarted before Candidate State was available",
            });
            run.transaction.promotionReceipt = createPromotionReceipt(
              run.transaction,
            );
            startupAuthorityRunIds.add(run.id);
          }
        }
      }

      for (const runId of cleanup.candidateRunIds) {
        const run = database.runs.find((item) => item.id === runId);
        const cleaned = cleanupTransactions.get(runId);
        if (run?.transaction && cleaned) {
          run.transaction = structuredClone(cleaned);
        }
      }

      for (const agent of database.agents) {
        const recoveryFailure = recovery.failures.find(
          (failure) => failure.agentId === agent.id,
        );
        const corruptJournalFailure = database.runs
          .filter((run) => run.agentId === agent.id)
          .map(
            (run) =>
              recoveryFailures.get(run.id)?.message ??
              terminalAuthorityFailures.get(run.id),
          )
          .find((failure) => failure !== undefined);
        if (recoveryFailure || corruptJournalFailure) {
          agent.status = "error";
          agent.lastError = boundedPersistedError(
            recoveryFailure?.message ?? corruptJournalFailure,
            "Agent recovery failed closed",
            this.config,
          );
          agent.updatedAt = now();
        } else if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
      await this.recordPortableDecisionAuthoritiesFromDatabase(
        database,
        startupAuthorityRunIds,
      );
    });
    const candidateSetRecoveryFailureCount =
      await this.reconcileCandidateSetsAfterStartup(
        promotionAuthority.invalidCandidateSets,
      );
    const runRecoveryFailureCount = this.store
      .snapshot()
      .runs.filter(
        (run) =>
          run.transaction?.status === "recovery-error" ||
          Boolean(run.transaction?.recovery.recoveryError) ||
          isImmutableTerminalRecoveryFailure(run),
      ).length;
    await this.transitionProviderRegistryAfterRecovery(
      registryDescriptors,
      registryGeneration,
      recovery.failures.length,
      candidateSetRecoveryFailureCount,
      runRecoveryFailureCount,
    );
    try {
      this.actionDispatcher.assertOperational();
    } catch (error) {
      this.providerRegistryReady = false;
      this.actionDispatcherReadinessError = boundedPersistedError(
        error,
        "External action dispatcher is not operational",
        this.config,
      );
      throw new Error(this.actionDispatcherReadinessError);
    }
  }

  private async transitionProviderRegistryAfterRecovery(
    registryDescriptors: ReturnType<ResourceCoordinator["registryDescriptors"]>,
    registryGeneration: number,
    promotionRecoveryFailureCount: number,
    candidateSetRecoveryFailureCount: number,
    runRecoveryFailureCount: number,
  ): Promise<void> {
    const canonicalStates = new Map<string, CanonicalStateReference>();
    const canonicalErrors = new Map<string, string>();
    const agents = this.store.snapshot().agents;
    if (
      promotionRecoveryFailureCount === 0 &&
      candidateSetRecoveryFailureCount === 0 &&
      runRecoveryFailureCount === 0
    ) {
      for (const agent of agents) {
        try {
          const current =
            await this.workspaces.ensureCanonicalForProviderTransition(agent);
          const additions = this.workspaces.providerVersionsToOnboard(
            current.providerVersions,
          );
          const verifications =
            await this.resourceCoordinator.verifyProviderOnboarding(
              agent.id,
              additions,
            );
          const transitioned = await this.workspaces.transitionProviderRegistry(
            agent,
            current,
            verifications,
            registryGeneration,
          );
          canonicalStates.set(agent.id, transitioned);
        } catch (error) {
          const safeError = boundedPersistedError(
            error,
            "Canonical State reconciliation failed closed",
            this.config,
          );
          canonicalErrors.set(
            agent.id,
            ("Canonical State reconciliation failed: " + safeError).slice(
              0,
              500,
            ),
          );
        }
      }
    } else {
      for (const agent of agents) {
        canonicalErrors.set(
          agent.id,
          runRecoveryFailureCount > 0
            ? "Resource Registry transition deferred until every terminal Run authority recovers"
            : candidateSetRecoveryFailureCount > 0
              ? "Resource Registry transition deferred until every prior-generation Candidate Set recovers"
              : "Resource Registry transition deferred until every prior-generation Promotion recovers",
        );
      }
    }
    if (
      canonicalErrors.size === 0 &&
      promotionRecoveryFailureCount === 0 &&
      candidateSetRecoveryFailureCount === 0 &&
      runRecoveryFailureCount === 0
    ) {
      await this.workspaces.commitProviderRegistryGeneration(
        registryDescriptors,
        registryGeneration,
      );
      this.providerRegistryReady = true;
    }
    await this.store.mutate((database) => {
      for (const agent of database.agents) {
        const canonical = canonicalStates.get(agent.id);
        const canonicalError = canonicalErrors.get(agent.id);
        if (canonical) {
          agent.canonicalStateId = canonical.stateId;
          agent.workspacePath = canonical.workspacePath;
          agent.codexThreadId = canonical.codexThreadId;
        }
        if (canonicalError) {
          agent.status = "error";
          agent.lastError = canonicalError;
          agent.updatedAt = now();
        } else if (
          agent.status === "error" &&
          (agent.lastError?.startsWith(
            "Canonical State reconciliation failed:",
          ) ||
            agent.lastError?.startsWith(
              "Resource Registry transition deferred",
            ))
        ) {
          agent.status = "ready";
          agent.lastError = null;
          agent.updatedAt = now();
        }
      }
    });
  }

  private async sanitizePersistedErrors(): Promise<void> {
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.error) {
          run.error = boundedPersistedError(
            run.error,
            "Run failed closed",
            this.config,
          );
        }
        if (run.transaction?.recovery.recoveryError) {
          run.transaction.recovery.recoveryError = boundedPersistedError(
            run.transaction.recovery.recoveryError,
            "Run recovery failed closed",
            this.config,
          );
        }
      }
      for (const agent of database.agents) {
        if (agent.lastError) {
          agent.lastError = boundedPersistedError(
            agent.lastError,
            "Agent operation failed closed",
            this.config,
          );
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    this.assertProviderRegistryReady();
    const timestamp = now();
    const id = randomUUID();
    await this.resourceCoordinator.verifyProviderOnboarding(
      id,
      this.resourceCoordinator.initialVersions(),
    );
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: "",
      canonicalStateId: "",
      outcomeContract: createDefaultOutcomeContract(),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const canonical = await this.workspaces.create(agent);
    agent.workspacePath = canonical.workspacePath;
    agent.canonicalStateId = canonical.stateId;
    await this.store.mutate((database) => {
      database.agents.push(agent);
      database.outcomeContractVersions.push({
        schemaVersion: 1,
        agentId: agent.id,
        contract: structuredClone(agent.outcomeContract),
        provenance: "created",
        sourceProposalId: null,
        rollbackFromVersion: null,
      });
    });
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    if (this.isAgentLocked(id)) {
      throw new HttpError(409, "This Agent is already being updated");
    }
    this.configuringAgents.add(id);
    try {
      const proposed = structuredClone(current);
      if (input.name !== undefined) proposed.name = input.name.trim();
      if (input.description !== undefined) {
        proposed.description = input.description.trim();
      }
      if (input.instructions !== undefined) {
        proposed.instructions = input.instructions.trim();
      }
      const canonical = await this.workspaces.updateInstructions(proposed);
      return await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === id);
        if (!agent) throw new HttpError(404, "Agent not found");
        if (agent.status === "busy") {
          throw new HttpError(
            409,
            "Stop the active run before editing this Agent",
          );
        }
        agent.name = proposed.name;
        agent.description = proposed.description;
        agent.instructions = proposed.instructions;
        agent.workspacePath = canonical.workspacePath;
        agent.canonicalStateId = canonical.stateId;
        agent.codexThreadId = canonical.codexThreadId;
        agent.lastError = null;
        agent.updatedAt = now();
        return structuredClone(agent);
      });
    } finally {
      this.configuringAgents.delete(id);
    }
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    this.getAgent(id);
    if (this.configuringAgents.has(id) || this.deletingAgents.has(id)) {
      throw new HttpError(
        409,
        "Wait for the Agent configuration update to finish",
      );
    }
    this.configuringAgents.add(id);
    try {
      await this.cancelExecution(id);
      const persisted = this.store.snapshot();
      const agentRuns = persisted.runs.filter((run) => run.agentId === id);
      const agentCandidateSets = persisted.candidateSets.filter(
        (candidateSet) => candidateSet.agentId === id,
      );
      if (
        agentRuns.some((run) => {
          const transaction = run.transaction;
          return Boolean(
            transaction &&
            (transaction.quarantineAvailable ||
              transaction.disposition === "quarantined" ||
              transaction.status === "recovery-error" ||
              transaction.providerResources.some(
                (resource) =>
                  resource.disposition === null ||
                  resource.disposition === "quarantined",
              )),
          );
        }) ||
        agentCandidateSets.some((candidateSet) =>
          candidateSet.competitors.some(
            (competitor) => competitor.loserDisposition === "retained",
          ),
        )
      ) {
        throw new HttpError(
          409,
          "Agent deletion is blocked until retained Quarantine is discarded",
        );
      }
      const journalScan = await this.promotionJournal.scan();
      if (
        journalScan.errors.length > 0 ||
        journalScan.records.some(
          (record) => record.agentId === id && record.phase !== "completed",
        )
      ) {
        throw new HttpError(
          409,
          "Agent deletion is blocked until its Promotion recovery completes",
        );
      }
      if (this.hasUnresolvedCandidateDisposition(id)) {
        throw new HttpError(
          409,
          "Agent deletion is blocked until Candidate cleanup resolves every disposition",
        );
      }
      const deletionScan = await this.agentDeletionJournal.scan();
      if (deletionScan.errors.length > 0) {
        throw new Error("Agent deletion journal recovery is required");
      }
      const pendingDeletion = deletionScan.records.find(
        (record) => record.agentId === id,
      );
      const archivedAt = pendingDeletion?.audit.archivedAt ?? now();
      const audit = this.buildAgentArchiveAudit(
        id,
        archivedAt,
        agentRuns,
        agentCandidateSets,
        persisted.assuranceProposals.filter(
          (proposal) => proposal.agentId === id,
        ),
        persisted.outcomeContractVersions.filter(
          (record) => record.agentId === id,
        ),
        pendingDeletion?.audit.schemaVersion ?? 2,
      );
      await this.agentDeletionJournal.begin(id, audit);
      this.deletingAgents.add(id);
      const archivedWorkspace = await this.workspaces.archiveAgent(id, audit);
      await this.agentDeletionJournal.markWorkspaceArchived(id);
      await this.removeAgentRecords(id);
      await this.agentDeletionJournal.complete(id);
      this.deletingAgents.delete(id);
      return { archivedWorkspace };
    } finally {
      this.configuringAgents.delete(id);
    }
  }

  private async reconcileAgentDeletions(): Promise<void> {
    const scan = await this.agentDeletionJournal.scan();
    if (scan.errors.length > 0) {
      throw new Error(
        "Agent deletion recovery failed closed: " +
          scan.errors.map((error) => error.message).join("; "),
      );
    }
    for (const record of scan.records) {
      this.deletingAgents.add(record.agentId);
      const snapshot = this.store.snapshot();
      const agent = snapshot.agents.find((item) => item.id === record.agentId);
      if (agent) {
        const expectedAudit = this.buildAgentArchiveAudit(
          record.agentId,
          record.audit.archivedAt,
          snapshot.runs.filter((run) => run.agentId === record.agentId),
          snapshot.candidateSets.filter(
            (candidateSet) => candidateSet.agentId === record.agentId,
          ),
          snapshot.assuranceProposals.filter(
            (proposal) => proposal.agentId === record.agentId,
          ),
          snapshot.outcomeContractVersions.filter(
            (history) => history.agentId === record.agentId,
          ),
          record.audit.schemaVersion,
        );
        if (stableJson(expectedAudit) !== stableJson(record.audit)) {
          throw new Error(
            "Agent deletion recovery failed closed because its evidence changed",
          );
        }
      }
      await this.workspaces.archiveAgent(record.agentId, record.audit);
      await this.agentDeletionJournal.markWorkspaceArchived(record.agentId);
      await this.removeAgentRecords(record.agentId);
      await this.agentDeletionJournal.complete(record.agentId);
      this.deletingAgents.delete(record.agentId);
    }
  }

  private buildAgentArchiveAudit(
    agentId: string,
    archivedAt: string,
    runs: AgentRun[],
    candidateSets: CandidateSet[],
    proposals: AssuranceProposal[] = [],
    contractVersions: OutcomeContractVersionRecord[] = [],
    schemaVersion: 1 | 2 = 2,
  ): AgentArchiveAudit {
    const runSummaries = [...runs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((run) => ({
        runId: run.id,
        status: run.status,
        candidateSetId: run.candidateSetId,
        disposition: run.transaction?.disposition ?? null,
        promotionReceiptDigest: run.transaction?.promotionReceipt
          ? createHash("sha256")
              .update(stableJson(run.transaction.promotionReceipt))
              .digest("hex")
          : null,
      }));
    const candidateSetSummaries = [...candidateSets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((candidateSet) => {
        const winner = candidateSet.competitors.find(
          (competitor) => competitor.runId === candidateSet.winnerRunId,
        );
        return {
          candidateSetId: candidateSet.id,
          phase: candidateSet.phase,
          winnerRunId: candidateSet.winnerRunId,
          selectionDecisionDigest:
            candidateSet.selectionDecision?.decisionDigest ?? null,
          winnerSealDigest: winner?.seal?.sealDigest ?? null,
        };
      });
    const common = {
      agentId,
      archivedAt,
      runs: runSummaries,
      candidateSets: candidateSetSummaries,
    };
    if (schemaVersion === 1) {
      return { schemaVersion: 1, ...common };
    }
    const proposalSummaries = [...proposals]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((proposal) => ({
        proposalId: proposal.id,
        state: proposal.state,
        baseContractVersion: proposal.baseContractVersion,
        proposalDigest: proposal.proposalDigest,
        decisionAction: proposal.decision?.action ?? null,
        decisionDigest: proposal.decision
          ? airlockEvidenceHash(proposal.decision)
          : null,
        resultingContractVersion:
          proposal.decision?.resultingContractVersion ?? null,
      }));
    const contractVersionSummaries = [...contractVersions]
      .sort((left, right) => left.contract.version - right.contract.version)
      .map((record) => ({
        version: record.contract.version,
        contractHash: outcomeContractHash(record.contract),
        provenance: record.provenance,
        sourceProposalId: record.sourceProposalId,
        rollbackFromVersion: record.rollbackFromVersion,
      }));
    return {
      schemaVersion: 2,
      agentId,
      archivedAt,
      runs: runSummaries.slice(0, MAXIMUM_ARCHIVED_RUN_SUMMARIES),
      candidateSets: candidateSetSummaries.slice(
        0,
        MAXIMUM_ARCHIVED_CANDIDATE_SET_SUMMARIES,
      ),
      assuranceProposals: proposalSummaries.slice(
        0,
        MAXIMUM_ARCHIVED_PROPOSAL_SUMMARIES,
      ),
      outcomeContractVersions: contractVersionSummaries.slice(
        0,
        MAXIMUM_ARCHIVED_CONTRACT_VERSION_SUMMARIES,
      ),
      aggregate: {
        runCount: runSummaries.length,
        candidateSetCount: candidateSetSummaries.length,
        assuranceProposalCount: proposalSummaries.length,
        outcomeContractVersionCount: contractVersionSummaries.length,
        evidenceDigest: airlockEvidenceHash({
          runs: runSummaries,
          candidateSets: candidateSetSummaries,
          assuranceProposals: proposalSummaries,
          outcomeContractVersions: contractVersionSummaries,
        }),
      },
    };
  }

  private async removeAgentRecords(agentId: string): Promise<void> {
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== agentId);
      database.messages = database.messages.filter(
        (item) => item.agentId !== agentId,
      );
      database.runs = database.runs.filter((item) => item.agentId !== agentId);
      database.candidateSets = database.candidateSets.filter(
        (item) => item.agentId !== agentId,
      );
      database.assuranceProposals = database.assuranceProposals.filter(
        (item) => item.agentId !== agentId,
      );
      database.outcomeContractVersions =
        database.outcomeContractVersions.filter(
          (item) => item.agentId !== agentId,
        );
    });
  }

  async updateOutcomeContract(
    id: string,
    input: OutcomeContractInput,
  ): Promise<OutcomeContract> {
    const current = this.getAgent(id);
    if (current.status === "busy" || this.isAgentLocked(id)) {
      throw new HttpError(
        409,
        "Stop the active run before updating the Outcome Contract",
      );
    }
    this.configuringAgents.add(id);
    try {
      return await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === id);
        if (!agent) throw new HttpError(404, "Agent not found");
        if (agent.status === "busy") {
          throw new HttpError(
            409,
            "Stop the active run before updating the Outcome Contract",
          );
        }
        const next = createNextOutcomeContract(agent.outcomeContract, input);
        agent.outcomeContract = next;
        agent.updatedAt = now();
        database.outcomeContractVersions.push({
          schemaVersion: 1,
          agentId: id,
          contract: structuredClone(next),
          provenance: "manual",
          sourceProposalId: null,
          rollbackFromVersion: null,
        });
        for (const proposal of database.assuranceProposals) {
          if (proposal.agentId === id && proposal.state === "ready") {
            proposal.state = "stale";
            proposal.updatedAt = agent.updatedAt;
          }
        }
        return structuredClone(next);
      });
    } finally {
      this.configuringAgents.delete(id);
    }
  }

  listAssuranceProposals(agentId: string): AssuranceProposal[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .assuranceProposals.filter((proposal) => proposal.agentId === agentId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  listOutcomeContractVersions(agentId: string): OutcomeContractVersionRecord[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .outcomeContractVersions.filter((record) => record.agentId === agentId)
      .sort((left, right) => right.contract.version - left.contract.version);
  }

  async deriveAssuranceProposal(
    agentId: string,
  ): Promise<AssuranceProposal | null> {
    this.assertAgentConfigurationAvailable(agentId);
    this.configuringAgents.add(agentId);
    try {
      const snapshot = this.store.snapshot();
      const agent = snapshot.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      const proposal = deriveAssuranceProposal(
        agentId,
        agent.outcomeContract,
        snapshot.runs,
      );
      if (!proposal) return null;
      return await this.store.mutate((database) => {
        const currentAgent = database.agents.find(
          (candidate) => candidate.id === agentId,
        );
        if (!currentAgent) throw new HttpError(404, "Agent not found");
        if (
          currentAgent.outcomeContract.version !==
            proposal.baseContractVersion ||
          outcomeContractHash(currentAgent.outcomeContract) !==
            proposal.baseContractHash
        ) {
          throw new HttpError(
            409,
            "Outcome Contract changed while Assurance evidence was derived",
          );
        }
        const existing = database.assuranceProposals.find(
          (candidate) => candidate.id === proposal.id,
        );
        if (existing) return structuredClone(existing);
        if (
          database.assuranceProposals.filter(
            (candidate) => candidate.agentId === agentId,
          ).length >= 100
        ) {
          throw new HttpError(
            409,
            "Assurance Proposal retention reached its per-Agent bound",
          );
        }
        const updatedAt = now();
        for (const candidate of database.assuranceProposals) {
          if (candidate.agentId !== agentId || candidate.state !== "ready")
            continue;
          candidate.state =
            candidate.baseContractVersion === proposal.baseContractVersion &&
            candidate.baseContractHash === proposal.baseContractHash
              ? "superseded"
              : "stale";
          candidate.updatedAt = updatedAt;
        }
        database.assuranceProposals.push(structuredClone(proposal));
        return structuredClone(proposal);
      });
    } finally {
      this.configuringAgents.delete(agentId);
    }
  }

  async acceptAssuranceProposal(
    proposalId: string,
    reason: string,
  ): Promise<{
    proposal: AssuranceProposal;
    outcomeContract: OutcomeContract;
  }> {
    const decisionReason = normalizeAssuranceDecisionReason(reason);
    const snapshot = this.store.snapshot();
    const pending = snapshot.assuranceProposals.find(
      (proposal) => proposal.id === proposalId,
    );
    if (!pending) throw new HttpError(404, "Assurance Proposal not found");
    this.assertAgentConfigurationAvailable(pending.agentId);
    this.configuringAgents.add(pending.agentId);
    try {
      const result = await this.store.mutate((database) => {
        const proposal = database.assuranceProposals.find(
          (candidate) => candidate.id === proposalId,
        );
        const agent = proposal
          ? database.agents.find(
              (candidate) => candidate.id === proposal.agentId,
            )
          : null;
        if (!proposal || !agent) {
          return { kind: "missing" as const };
        }
        if (proposal.state !== "ready") {
          return { kind: "not-ready" as const, state: proposal.state };
        }
        verifyAssuranceProposalIntegrity(proposal);
        if (
          agent.outcomeContract.version !== proposal.baseContractVersion ||
          outcomeContractHash(agent.outcomeContract) !==
            proposal.baseContractHash
        ) {
          proposal.state = "stale";
          proposal.updatedAt = now();
          return { kind: "stale" as const };
        }
        const reproduced = deriveAssuranceProposal(
          agent.id,
          agent.outcomeContract,
          database.runs,
          proposal.createdAt,
        );
        if (
          !reproduced ||
          reproduced.proposalDigest !== proposal.proposalDigest
        ) {
          throw new HttpError(
            409,
            "Assurance Proposal no longer reproduces from retained evidence",
          );
        }
        const baseRecord = database.outcomeContractVersions.find(
          (record) =>
            record.agentId === agent.id &&
            record.contract.version === proposal.baseContractVersion,
        );
        if (
          !baseRecord ||
          outcomeContractHash(baseRecord.contract) !== proposal.baseContractHash
        ) {
          throw new HttpError(
            409,
            "Assurance Proposal base contract history is unavailable",
          );
        }
        const next = applyAssuranceOperations(
          agent.outcomeContract,
          proposal.operations,
        );
        const decidedAt = now();
        agent.outcomeContract = next;
        agent.updatedAt = decidedAt;
        proposal.state = "accepted";
        proposal.decision = {
          action: "accepted",
          reason: decisionReason,
          decidedAt,
          resultingContractVersion: next.version,
        };
        proposal.updatedAt = decidedAt;
        database.outcomeContractVersions.push({
          schemaVersion: 1,
          agentId: agent.id,
          contract: structuredClone(next),
          provenance: "assurance-proposal",
          sourceProposalId: proposal.id,
          rollbackFromVersion: null,
        });
        for (const other of database.assuranceProposals) {
          if (
            other.agentId === agent.id &&
            other.id !== proposal.id &&
            other.state === "ready"
          ) {
            other.state = "stale";
            other.updatedAt = decidedAt;
          }
        }
        return {
          kind: "accepted" as const,
          proposal: structuredClone(proposal),
          outcomeContract: structuredClone(next),
        };
      });
      if (result.kind === "missing") {
        throw new HttpError(404, "Assurance Proposal not found");
      }
      if (result.kind === "not-ready") {
        throw new HttpError(
          409,
          "Assurance Proposal is not ready: " + result.state,
        );
      }
      if (result.kind === "stale") {
        throw new HttpError(
          409,
          "Assurance Proposal is stale and must be derived again",
        );
      }
      return result;
    } finally {
      this.configuringAgents.delete(pending.agentId);
    }
  }

  async rejectAssuranceProposal(
    proposalId: string,
    reason: string,
  ): Promise<AssuranceProposal> {
    const decisionReason = normalizeAssuranceDecisionReason(reason);
    const snapshot = this.store.snapshot();
    const pending = snapshot.assuranceProposals.find(
      (proposal) => proposal.id === proposalId,
    );
    if (!pending) throw new HttpError(404, "Assurance Proposal not found");
    this.assertAgentConfigurationAvailable(pending.agentId);
    this.configuringAgents.add(pending.agentId);
    try {
      return await this.store.mutate((database) => {
        const proposal = database.assuranceProposals.find(
          (candidate) => candidate.id === proposalId,
        );
        if (!proposal) throw new HttpError(404, "Assurance Proposal not found");
        if (proposal.state !== "ready") {
          throw new HttpError(
            409,
            "Only a ready Assurance Proposal may be rejected",
          );
        }
        const decidedAt = now();
        proposal.state = "rejected";
        proposal.decision = {
          action: "rejected",
          reason: decisionReason,
          decidedAt,
          resultingContractVersion: null,
        };
        proposal.updatedAt = decidedAt;
        return structuredClone(proposal);
      });
    } finally {
      this.configuringAgents.delete(pending.agentId);
    }
  }

  async rollbackOutcomeContract(
    agentId: string,
    targetVersion: number,
    expectedCurrentVersion: number,
  ): Promise<OutcomeContract> {
    this.assertAgentConfigurationAvailable(agentId);
    this.configuringAgents.add(agentId);
    try {
      return await this.store.mutate((database) => {
        const agent = database.agents.find(
          (candidate) => candidate.id === agentId,
        );
        if (!agent) throw new HttpError(404, "Agent not found");
        if (agent.outcomeContract.version !== expectedCurrentVersion) {
          throw new HttpError(
            409,
            "Outcome Contract changed before rollback confirmation",
          );
        }
        const target = database.outcomeContractVersions.find(
          (record) =>
            record.agentId === agentId &&
            record.contract.version === targetVersion,
        );
        if (!target) {
          throw new HttpError(404, "Outcome Contract version not found");
        }
        if (targetVersion === agent.outcomeContract.version) {
          throw new HttpError(409, "Rollback target is already current");
        }
        const next = createNextOutcomeContract(agent.outcomeContract, {
          requiredPaths: target.contract.requiredPaths,
          protectedPaths: target.contract.protectedPaths,
          maxChangedFiles: target.contract.maxChangedFiles,
          maxAddedBytes: target.contract.maxAddedBytes,
          secretPatterns: target.contract.secretPatterns,
          validationCommands: target.contract.validationCommands,
        });
        agent.outcomeContract = next;
        agent.updatedAt = now();
        database.outcomeContractVersions.push({
          schemaVersion: 1,
          agentId,
          contract: structuredClone(next),
          provenance: "rollback",
          sourceProposalId: null,
          rollbackFromVersion: targetVersion,
        });
        for (const proposal of database.assuranceProposals) {
          if (proposal.agentId === agentId && proposal.state === "ready") {
            proposal.state = "stale";
            proposal.updatedAt = now();
          }
        }
        return structuredClone(next);
      });
    } finally {
      this.configuringAgents.delete(agentId);
    }
  }

  private assertAgentConfigurationAvailable(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (agent.status === "busy" || this.isAgentLocked(agentId)) {
      throw new HttpError(
        409,
        "Stop the active run before changing the Outcome Contract",
      );
    }
  }

  private isAgentLocked(agentId: string): boolean {
    return (
      this.configuringAgents.has(agentId) ||
      this.deletingAgents.has(agentId) ||
      this.federatedDecisionOperations.has(agentId) ||
      this.hasUnresolvedRunRecovery(agentId) ||
      this.hasUnresolvedCandidateDisposition(agentId)
    );
  }

  private hasUnresolvedRunRecovery(agentId: string): boolean {
    return this.store
      .snapshot()
      .runs.some(
        (run) =>
          run.agentId === agentId &&
          (run.transaction?.status === "recovery-error" ||
            Boolean(run.transaction?.recovery.recoveryError) ||
            isImmutableTerminalRecoveryFailure(run)),
      );
  }

  private hasUnresolvedCandidateDisposition(agentId: string): boolean {
    const snapshot = this.store.snapshot();
    const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
    return snapshot.candidateSets.some(
      (candidateSet) =>
        candidateSet.agentId === agentId &&
        candidateSet.competitors.some((competitor) => {
          const run = runsById.get(competitor.runId);
          return (
            competitor.loserDisposition === "pending" ||
            run?.transaction?.disposition === null
          );
        }),
    );
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async exportPortableReceipt(
    runId: string,
    options: {
      disclosureIdentities: string[];
      includeAncestry: boolean;
      localAnchor: boolean;
      evmPayload: boolean;
    },
  ) {
    const initial = this.getRun(runId);
    this.getAgent(initial.agentId);
    if (
      this.configuringAgents.has(initial.agentId) ||
      this.deletingAgents.has(initial.agentId)
    ) {
      throw new HttpError(409, "Wait for the active Agent operation to finish");
    }
    this.configuringAgents.add(initial.agentId);
    try {
      const snapshot = this.store.snapshot();
      const run = snapshot.runs.find((item) => item.id === runId);
      if (!run || run.agentId !== initial.agentId) {
        throw new HttpError(404, "Run not found");
      }
      const candidateSet = run.candidateSetId
        ? (snapshot.candidateSets.find(
            (item) => item.id === run.candidateSetId,
          ) ?? null)
        : null;
      if (
        candidateSet &&
        (candidateSet.phase === "recovery-error" ||
          candidateSet.competitors.some(
            (competitor) => competitor.loserDisposition === "pending",
          ))
      ) {
        throw new HttpError(
          409,
          "Portable receipt export is blocked by unresolved Candidate evidence",
        );
      }

      const ancestryDrafts: PortableReceiptDraft[] = [];
      const buildDraft = async (
        sourceRun: AgentRun,
        seen: Set<string>,
        recordedAuthority?: PortableDecisionAuthorityRecord,
      ): Promise<PortableReceiptDraft> => {
        if (seen.has(sourceRun.id)) {
          throw new Error("Portable receipt ancestry contains a cycle");
        }
        const nextSeen = new Set(seen).add(sourceRun.id);
        if (!sourceRun.transaction) {
          throw new Error("Portable receipt decision evidence is incomplete");
        }
        if (
          !sourceRun.transaction.disposition ||
          !sourceRun.transaction.canonicalStateIdAfter ||
          !sourceRun.transaction.canonicalContentHashAfter ||
          !sourceRun.transaction.promotionReceipt
        ) {
          throw new Error(
            "Portable receipt export requires complete, versioned, contradiction-free Run Transaction evidence",
          );
        }
        const sourceCandidateSet = sourceRun.candidateSetId
          ? (snapshot.candidateSets.find(
              (item) => item.id === sourceRun.candidateSetId,
            ) ?? null)
          : null;
        const authority =
          recordedAuthority ??
          (await this.portableDecisionJournal.readForTransaction(
            sourceRun.id,
            sourceRun.agentId,
            sourceRun.transaction,
            sourceCandidateSet,
          ));
        if (
          sourceCandidateSet &&
          authority.candidateSetAuthorityDigest !==
            portableCandidateSetAuthorityHash(sourceCandidateSet)
        ) {
          throw new Error(
            "Portable receipt Candidate Set contradicts immutable decision authority",
          );
        }
        const candidateSetAtAuthority = sourceCandidateSet
          ? projectCandidateSetLifecycleAtAuthority(
              sourceCandidateSet,
              sourceRun,
              authority.disposition,
            )
          : null;
        let previousReceiptDigest: ReceiptDigest | null = null;
        const parentId = sourceRun.transaction?.lineage.parentRunId ?? null;
        if (options.includeAncestry && parentId) {
          const parent = snapshot.runs.find(
            (item) =>
              item.id === parentId && item.agentId === sourceRun.agentId,
          );
          if (
            !parent?.transaction ||
            !sourceRun.transaction ||
            parent.transaction.lineage.rootRunId !==
              sourceRun.transaction.lineage.rootRunId ||
            parent.transaction.lineage.depth + 1 !==
              sourceRun.transaction.lineage.depth
          ) {
            throw new Error(
              "Portable receipt ancestry is incomplete or contradictory",
            );
          }
          if (!authority.parentAuthorityDigest) {
            throw new Error(
              "Portable receipt ancestry authority is incomplete",
            );
          }
          const parentAuthority =
            await this.portableDecisionJournal.readByDigest(
              parent.id,
              authority.parentAuthorityDigest,
            );
          if (
            parentAuthority.runId !== parent.id ||
            parentAuthority.agentId !== parent.agentId ||
            parentAuthority.transaction.lineage.rootRunId !==
              sourceRun.transaction.lineage.rootRunId ||
            parentAuthority.transaction.lineage.depth + 1 !==
              sourceRun.transaction.lineage.depth
          ) {
            throw new Error(
              "Portable receipt ancestry authority is contradictory",
            );
          }
          previousReceiptDigest = (
            await buildDraft(
              { ...parent, transaction: parentAuthority.transaction },
              nextSeen,
              parentAuthority,
            )
          ).receiptDigest;
        }
        const contractVersion = sourceRun.transaction
          ? (snapshot.outcomeContractVersions.find(
              (record) =>
                record.agentId === sourceRun.agentId &&
                record.contract.version ===
                  sourceRun.transaction!.outcomeContractVersion,
            ) ?? null)
          : null;
        await this.verifyPortableRunState(sourceRun, sourceCandidateSet);
        const sourceDraft = buildPortableReceiptDraft({
          run: sourceRun,
          candidateSet: candidateSetAtAuthority,
          candidateSetRuns: candidateSetAtAuthority
            ? snapshot.runs
                .filter(
                  (candidateRun) =>
                    candidateRun.candidateSetId === candidateSetAtAuthority.id,
                )
                .map((candidateRun) =>
                  candidateRun.id === sourceRun.id
                    ? structuredClone(sourceRun)
                    : candidateRun,
                )
            : [],
          contractVersion,
          previousReceiptDigest,
        });
        ancestryDrafts.push(sourceDraft);
        return sourceDraft;
      };

      let draft: PortableReceiptDraft;
      try {
        draft = await buildDraft(run, new Set());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          409,
          error instanceof Error
            ? error.message
            : "Portable receipt evidence is unavailable",
        );
      }
      const requestedIdentities = new Set(options.disclosureIdentities);
      if (requestedIdentities.size !== options.disclosureIdentities.length) {
        throw new HttpError(400, "Portable evidence identities must be unique");
      }
      const disclosureByIdentity = new Map(
        draft.disclosures.map((disclosure) => [
          disclosure.leaf.identity,
          disclosure,
        ]),
      );
      const disclosures = options.disclosureIdentities.map((identity) => {
        const disclosure = disclosureByIdentity.get(identity);
        if (!disclosure) {
          throw new HttpError(
            400,
            "Requested portable evidence disclosure is unavailable",
          );
        }
        return disclosure;
      });
      let signingKey: Awaited<
        ReturnType<typeof loadOrCreatePortableSigningKey>
      >;
      try {
        signingKey = await loadOrCreatePortableSigningKey(
          this.config.portableSigningKeyPath,
        );
      } catch {
        throw new HttpError(503, "Portable receipt signing is unavailable");
      }
      const envelope = signPortableReceipt({
        receipt: draft.receipt,
        privateKey: signingKey.privateKeyPem,
        disclosures,
      });
      const verification = verifyPortablePromotionEnvelope(envelope);
      if (!verification.valid) {
        throw new Error("Portable receipt failed its own offline verification");
      }
      let anchor = null;
      if (options.localAnchor) {
        try {
          anchor = await this.appendPortableTransparencyAnchor(
            envelope.receiptDigest,
          );
        } catch {
          throw new HttpError(
            503,
            "Local transparency anchoring is unavailable",
          );
        }
      }
      const evmPayload = options.evmPayload
        ? encodeOfflineEvmAnchorPayload(envelope.receiptDigest)
        : null;
      const packet = buildPortableEvidencePacket({
        envelope,
        anchor,
        evmPayload,
      });
      const decisionChain = options.includeAncestry
        ? buildPortableDecisionChain(
            ancestryDrafts.map((ancestryDraft) => {
              if (ancestryDraft.receiptDigest === envelope.receiptDigest) {
                return packet;
              }
              const ancestryEnvelope = signPortableReceipt({
                receipt: ancestryDraft.receipt,
                privateKey: signingKey.privateKeyPem,
                disclosures: [],
              });
              return buildPortableEvidencePacket({
                envelope: ancestryEnvelope,
                anchor: null,
                evmPayload: null,
              });
            }),
          )
        : null;
      return {
        envelope,
        verification,
        availableDisclosureIdentities: draft.disclosures.map(
          (disclosure) => disclosure.leaf.identity,
        ),
        availableDisclosures: draft.disclosures.map((disclosure) => ({
          identity: disclosure.leaf.identity,
          category: disclosure.leaf.category,
          status: disclosure.leaf.status,
          required: disclosure.leaf.required,
          summary: disclosure.leaf.summary,
        })),
        anchor,
        evmPayload,
        packet,
        decisionChain,
      };
    } finally {
      this.configuringAgents.delete(initial.agentId);
    }
  }

  async exportFederatedWorkBundle(runId: string) {
    const run = this.getRun(runId);
    const transaction = run.transaction;
    if (
      run.status !== "completed" ||
      transaction?.disposition !== "promoted" ||
      !transaction.canonicalStateIdAfter ||
      !transaction.canonicalContentHashAfter
    ) {
      throw new HttpError(
        409,
        "Federated export requires a completed local Promotion",
      );
    }
    const receiptExport = await this.exportPortableReceipt(runId, {
      disclosureIdentities: [],
      includeAncestry: true,
      localAnchor: false,
      evmPayload: false,
    });
    let signingKey: Awaited<ReturnType<typeof loadOrCreatePortableSigningKey>>;
    try {
      signingKey = await loadOrCreatePortableSigningKey(
        this.config.portableSigningKeyPath,
      );
    } catch {
      throw new HttpError(503, "Federated export signing is unavailable");
    }
    try {
      const artifact = await this.workspaces.buildFederatedWorkspaceArtifact({
        agentId: run.agentId,
        beforeStateId: transaction.canonicalStateIdBefore,
        afterStateId: transaction.canonicalStateIdAfter,
        baseStateDigest: receiptExport.envelope.receipt.state.before.compositeHash,
        resultStateDigest: receiptExport.envelope.receipt.state.after.compositeHash,
      });
      const bundle = buildFederatedWorkBundle({
        receipt: receiptExport.envelope,
        artifact,
        privateKey: signingKey.privateKeyPem,
      });
      const verification = verifyFederatedWorkBundle(bundle);
      if (!verification.valid) {
        throw new Error("Federated Work Bundle failed its own verification");
      }
      return { bundle, verification };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        409,
        error instanceof Error
          ? error.message
          : "Federated workspace artifact is unavailable",
      );
    }
  }

  async exportReceiverCustody(runId: string) {
    const run = this.getRun(runId);
    const transaction = run.transaction;
    if (
      run.status !== "completed" ||
      !transaction ||
      (transaction.disposition !== "promoted" &&
        transaction.disposition !== "quarantined")
    ) {
      throw new HttpError(
        409,
        "Receiver custody export requires a terminal federated Promotion or Quarantine",
      );
    }

    let match:
      | {
          admission: FederatedAdmissionRecord;
          approval: FederatedApprovalDecisionRecord | null;
        }
      | null = null;
    for (const admission of await this.federatedAdmissionJournal.listRecords()) {
      const approvalResult =
        await this.federatedApprovalJournal.readResultByAdmissionId(
          admission.admissionId,
        );
      if (
        admission.candidateRunId !== runId &&
        approvalResult?.plan.candidateRunId !== runId
      ) {
        continue;
      }
      if (match) {
        throw new HttpError(
          409,
          "Receiver Run has ambiguous federated authority",
        );
      }
      match = {
        admission,
        approval: approvalResult?.approval ?? null,
      };
    }
    if (!match) {
      throw new HttpError(409, "Run is not authorized by a Federated Admission");
    }
    const { admission, approval } = match;
    const bundle =
      await this.federatedAdmissionJournal.readEvidenceBundle(admission);
    if (!bundle) {
      throw new HttpError(
        409,
        "Federated producer evidence is not durably available",
      );
    }
    const authority =
      await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
        run.id,
        run.agentId,
      );
    if (!authority || authority.disposition !== transaction.disposition) {
      throw new HttpError(
        409,
        "Receiver terminal Decision Authority is unavailable",
      );
    }
    const receiptExport = await this.exportPortableReceipt(runId, {
      disclosureIdentities: [],
      includeAncestry: false,
      localAnchor: false,
      evmPayload: false,
    });
    const receiverEnvelope = receiptExport.envelope;
    const entries = [
      buildReceiverCustodyRecord({
        recordId: "producer-work-bundle",
        role: "producer-work-bundle",
        trustDomain: "producer",
        schema: bundle.schema,
        schemaVersion: bundle.schemaVersion,
        signingRequirement: "nested-required",
        value: bundle,
      }),
      buildReceiverCustodyRecord({
        recordId: "receiver-admission",
        role: "receiver-admission",
        trustDomain: "receiver",
        schema: admission.schema,
        schemaVersion: admission.schemaVersion,
        signingRequirement: "manifest-covered",
        value: admission,
      }),
      ...(approval
        ? [
            buildReceiverCustodyRecord({
              recordId: "receiver-approval",
              role: "receiver-approval" as const,
              trustDomain: "receiver" as const,
              schema: approval.schema,
              schemaVersion: approval.schemaVersion,
              signingRequirement: "manifest-covered" as const,
              value: approval,
            }),
          ]
        : []),
      buildReceiverCustodyRecord({
        recordId: "receiver-terminal-authority",
        role: "receiver-terminal-authority",
        trustDomain: "receiver",
        schema: "agent-airlock/portable-decision-authority-commitment",
        schemaVersion: authority.schemaVersion,
        signingRequirement: "manifest-covered",
        value: {
          schemaVersion: authority.schemaVersion,
          transactionEvidenceHash: authority.transactionEvidenceHash,
          parentAuthorityDigest: authority.parentAuthorityDigest,
          candidateSetAuthorityDigest: authority.candidateSetAuthorityDigest,
          runId: authority.runId,
          agentId: authority.agentId,
          disposition: authority.disposition,
          decidedAt: authority.decidedAt,
          authorityDigest: authority.authorityDigest,
        },
      }),
      buildReceiverCustodyRecord({
        recordId: "receiver-promotion-envelope",
        role: "receiver-promotion-envelope",
        trustDomain: "receiver",
        schema: receiverEnvelope.schema,
        schemaVersion: receiverEnvelope.schemaVersion,
        signingRequirement: "nested-and-manifest",
        value: receiverEnvelope,
      }),
    ];
    const manifest: ReceiverCustodyManifest = {
      schema: "agent-airlock/receiver-custody-manifest",
      schemaVersion: 1,
      profile: "full-audit",
      records: entries.map((entry) => entry.descriptor),
      bindings: {
        admissionId: admission.admissionId,
        importIdentifier: admission.importIdentifier,
        producerId: admission.producerId,
        receiverAgentId: run.agentId,
        receiverRunId: run.id,
        producerReceiptDigest: bundle.receipt.receiptDigest,
        artifactDigest: bundle.artifact.artifactDigest,
        admissionRecordDigest: admission.recordDigest,
        approvalDecisionDigest: approval?.recordDigest ?? null,
        decisionContextDigest:
          approval?.schemaVersion === 2
            ? approval.decisionContextDigest
            : null,
        terminalAuthorityDigest: authority.authorityDigest as ReceiptDigest,
        receiverReceiptDigest: receiverEnvelope.receiptDigest,
        outcomeContractDigest: receiverEnvelope.receipt.outcomeContract.digest,
        validationEvidenceRoot:
          receiverEnvelope.receipt.validationEvidence.root,
        disposition: transaction.disposition,
      },
    };
    let signingKey: Awaited<ReturnType<typeof loadOrCreatePortableSigningKey>>;
    try {
      signingKey = await loadOrCreatePortableSigningKey(
        this.config.portableSigningKeyPath,
      );
    } catch {
      throw new HttpError(503, "Receiver custody signing is unavailable");
    }
    const packet = buildReceiverCustodyPacket({
      manifest,
      records: entries.map((entry) => entry.record),
      privateKey: signingKey.privateKeyPem,
    });
    const verification = verifyReceiverCustodyPacket(packet);
    if (!verification.valid) {
      throw new Error("Receiver custody packet failed offline verification");
    }
    return { packet, verification };
  }

  private async verifyPortableRunState(
    run: AgentRun,
    candidateSet: CandidateSet | null,
  ): Promise<void> {
    const transaction = run.transaction;
    if (!transaction?.canonicalStateIdAfter) {
      throw new Error(
        "Portable receipt export requires complete, versioned, contradiction-free Run Transaction evidence",
      );
    }
    const resources = new Map(
      transaction.resources.map((resource) => [resource.kind, resource]),
    );
    const expected = (side: "before" | "after") => {
      const field =
        side === "before" ? "fingerprintBefore" : "fingerprintAfter";
      const workspace = resources.get("workspace")?.[field];
      const session = resources.get("codex-session")?.[field];
      const sqlite = resources.get("sqlite")?.[field];
      if (!workspace || !session || !sqlite) {
        throw new Error(
          "Portable receipt state Resource evidence is incomplete",
        );
      }
      const providerVersions = transaction.providerResources.map((resource) => {
        const version =
          side === "after" && transaction.disposition === "promoted"
            ? resource.installedVersion
            : resource.source;
        if (!version) {
          throw new Error(
            "Portable receipt provider Resource version evidence is incomplete",
          );
        }
        return structuredClone(version);
      });
      return {
        workspaceContentHash: workspace,
        sessionContentHash: session,
        sqliteContentHash: sqlite,
        providerVersions,
        contentHash:
          side === "before"
            ? transaction.canonicalContentHashBefore
            : transaction.canonicalContentHashAfter!,
      };
    };
    const before = await this.workspaces.verifyPortableStateProjection(
      run.agentId,
      transaction.canonicalStateIdBefore,
      expected("before"),
    );
    if (
      candidateSet &&
      (candidateSet.source.stateId !== before.stateId ||
        candidateSet.source.contentHash !== before.contentHash ||
        candidateSet.source.workspaceContentHash !==
          before.workspaceContentHash ||
        candidateSet.source.sessionContentHash !== before.sessionContentHash ||
        candidateSet.source.sqliteContentHash !== before.sqliteContentHash ||
        candidateSet.source.outboxContentHash !== before.outboxContentHash ||
        candidateSet.source.codexThreadId !== before.codexThreadId ||
        stableJson(candidateSet.source.providerVersions) !==
          stableJson(before.providerVersions))
    ) {
      throw new Error(
        "Portable receipt Candidate Set source contradicts immutable historical state",
      );
    }
    if (
      transaction.disposition === "promoted" &&
      transaction.canonicalStateIdAfter !== transaction.canonicalStateIdBefore
    ) {
      await this.workspaces.verifyPortableStateProjection(
        run.agentId,
        transaction.canonicalStateIdAfter,
        expected("after"),
      );
    }
  }

  private async persistRunProgress(
    runId: string,
    transaction: RunTransaction,
  ): Promise<void> {
    await this.recordPortableDecisionAuthority(runId, transaction);
    if (
      transaction.disposition &&
      transaction.status === transaction.disposition &&
      transaction.promotionReceipt
    ) {
      return;
    }
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (storedRun) storedRun.transaction = structuredClone(transaction);
    });
  }

  private assertTerminalAuthorityExtendsRun(
    run: AgentRun,
    terminal: RunTransaction,
  ): void {
    const current = run.transaction;
    if (
      !current ||
      terminal.id !== run.id ||
      current.id !== terminal.id ||
      current.candidateStateId !== terminal.candidateStateId ||
      current.canonicalStateIdBefore !== terminal.canonicalStateIdBefore ||
      current.canonicalContentHashBefore !==
        terminal.canonicalContentHashBefore ||
      current.outcomeContractVersion !== terminal.outcomeContractVersion ||
      stableJson(current.outcomeContract) !==
        stableJson(terminal.outcomeContract) ||
      stableJson(current.lineage) !== stableJson(terminal.lineage) ||
      !terminal.disposition ||
      terminal.status !== terminal.disposition ||
      !terminal.promotionReceipt
    ) {
      throw new Error(
        "Immutable terminal decision contradicts the active Run projection",
      );
    }
  }

  private candidateLifecycleMatchesAuthority(
    database: Database,
    run: AgentRun,
    authority: PortableDecisionAuthorityRecord,
  ): boolean {
    if (!authority.candidateSetAuthorityDigest) return true;
    if (!run.candidateSetId) {
      throw new Error(
        "Candidate-bound terminal authority has no Candidate Set Run link",
      );
    }
    const candidateSet = database.candidateSets.find(
      (candidate) => candidate.id === run.candidateSetId,
    );
    const competitor = candidateSet?.competitors.find(
      (candidate) => candidate.runId === run.id,
    );
    if (!candidateSet || !competitor || candidateSet.agentId !== run.agentId) {
      throw new Error(
        "Candidate-bound terminal authority contradicts Candidate Set evidence",
      );
    }
    if (
      portableCandidateSetAuthorityHash(candidateSet) !==
      authority.candidateSetAuthorityDigest
    ) {
      return true;
    }
    const expected = terminalCompetitorLifecycle(
      candidateSet,
      run,
      authority.disposition,
    );
    return (
      competitor.status === expected.status &&
      competitor.loserDisposition === expected.loserDisposition
    );
  }

  private applyCandidateLifecycleAuthority(
    database: Database,
    run: AgentRun,
    authority: PortableDecisionAuthorityRecord,
  ): void {
    if (!authority.candidateSetAuthorityDigest) return;
    const candidateSet = database.candidateSets.find(
      (candidate) => candidate.id === run.candidateSetId,
    )!;
    if (
      portableCandidateSetAuthorityHash(candidateSet) !==
      authority.candidateSetAuthorityDigest
    ) {
      return;
    }
    this.candidateLifecycleMatchesAuthority(database, run, authority);
    const competitor = candidateSet.competitors.find(
      (candidate) => candidate.runId === run.id,
    )!;
    const expected = terminalCompetitorLifecycle(
      candidateSet,
      run,
      authority.disposition,
    );
    competitor.status = expected.status;
    competitor.loserDisposition = expected.loserDisposition;
    candidateSet.updatedAt = now();
  }

  private async recordPortableDecisionAuthority(
    runId: string,
    transaction: RunTransaction,
    candidateSetOverride?: CandidateSet | null,
  ): Promise<PortableDecisionAuthorityRecord | null> {
    return this.recordPortableDecisionAuthorityFromDatabase(
      this.store.snapshot(),
      runId,
      transaction,
      candidateSetOverride,
    );
  }

  private async recordPortableDecisionAuthoritiesFromDatabase(
    database: Database,
    runIds: ReadonlySet<string>,
  ): Promise<void> {
    const terminalRuns = database.runs
      .filter((run) => {
        const transaction = run.transaction;
        return (
          runIds.has(run.id) &&
          transaction?.disposition &&
          transaction.status === transaction.disposition &&
          transaction.promotionReceipt &&
          transaction.recovery.recoveryError === null
        );
      })
      .sort(
        (left, right) =>
          left.transaction!.lineage.depth - right.transaction!.lineage.depth ||
          left.id.localeCompare(right.id),
      );
    for (const run of terminalRuns) {
      await this.recordPortableDecisionAuthorityFromDatabase(
        database,
        run.id,
        run.transaction!,
      );
    }
  }

  private async recordPortableDecisionAuthorityFromDatabase(
    database: Database,
    runId: string,
    transaction: RunTransaction,
    candidateSetOverride?: CandidateSet | null,
  ): Promise<PortableDecisionAuthorityRecord | null> {
    if (
      !transaction.disposition ||
      transaction.status !== transaction.disposition ||
      !transaction.promotionReceipt ||
      transaction.recovery.recoveryError !== null
    ) {
      return null;
    }
    const storedRun = database.runs.find((run) => run.id === runId);
    if (!storedRun) {
      throw new Error("Portable decision authority Run is missing");
    }
    const run = { ...storedRun, transaction: structuredClone(transaction) };
    const parentRun = transaction.lineage.parentRunId
      ? (database.runs.find(
          (candidate) =>
            candidate.id === transaction.lineage.parentRunId &&
            candidate.agentId === run.agentId,
        ) ?? null)
      : null;
    const candidateSet =
      candidateSetOverride !== undefined
        ? candidateSetOverride
        : run.candidateSetId
          ? (database.candidateSets.find(
              (candidate) =>
                candidate.id === run.candidateSetId &&
                candidate.selectionDecision !== null,
            ) ?? null)
          : null;
    return this.portableDecisionJournal.record({
      run,
      transaction,
      parentRun,
      candidateSet,
    });
  }

  private async completeAuthorizedDiscard(
    authority: PortableDecisionAuthorityRecord,
    kind: "candidate" | "quarantine" | null,
  ): Promise<void> {
    if (authority.disposition !== "discarded") {
      throw new Error("Physical Discard requires immutable Discard authority");
    }
    let retainedStateRoot: string | null;
    if (kind === "quarantine") {
      retainedStateRoot = await this.workspaces.retainedQuarantinePath(
        authority.runId,
      );
    } else if (
      kind === "candidate" &&
      (await this.workspaces.candidateExists(authority.runId, true))
    ) {
      retainedStateRoot = path.dirname(
        await this.workspaces.candidateResourcesPath(authority.runId, true),
      );
    } else {
      retainedStateRoot = null;
    }
    if (requiresProviderDiscardCleanupFact(authority.transaction)) {
      const completed =
        await this.portableDecisionJournal.readDiscardCleanup(authority);
      if (!completed) {
        if (!retainedStateRoot) {
          throw new Error(
            "Authoritative Discard is missing provider cleanup evidence and retained recovery state",
          );
        }
        const cleaned = await this.runner.discardRetainedProviderState(
          authority.agentId,
          authority.transaction,
          retainedStateRoot,
        );
        await this.portableDecisionJournal.recordDiscardCleanup(
          authority,
          cleaned,
        );
      }
    }
    if (!retainedStateRoot) return;
    if (kind === "quarantine") {
      await this.workspaces.discardQuarantine(authority.runId);
    } else if (kind === "candidate") {
      await this.workspaces.cancelCandidate(authority.runId, true);
    }
  }

  getCandidateSet(candidateSetId: string): CandidateSet {
    const candidateSet = this.store
      .snapshot()
      .candidateSets.find((item) => item.id === candidateSetId);
    if (!candidateSet) throw new HttpError(404, "Candidate Set not found");
    return candidateSet;
  }

  getCandidateSets(agentId: string): CandidateSet[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .candidateSets.filter((candidateSet) => candidateSet.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createCandidateSet(
    agentId: string,
    rawInput: CreateCandidateSetInput,
  ): Promise<{ candidateSet: CandidateSet; runs: AgentRun[] }> {
    this.assertProviderRegistryReady();
    if (!this.runnerEnforcesTokenBudgets) {
      throw new HttpError(
        409,
        "Competing Futures requires a trusted Runner that enforces token allowances at the model-provider boundary",
      );
    }
    if (
      !this.config.demoMode &&
      this.config.runtimeProvider === "local-process" &&
      this.config.codexSandboxMode === "danger-full-access"
    ) {
      throw new HttpError(
        409,
        "Competing Futures requires an isolated container Runtime when Codex sandboxing is disabled",
      );
    }
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const input = validateCandidateSetInput(rawInput);
    this.getAgent(agentId);
    const canonical = await this.workspaces.readCanonical(agentId);
    const timestamp = now();
    const candidateSetId = randomUUID();
    const competitors: CandidateSetCompetitor[] = input.competitors.map(
      (competitor) => ({
        id: competitor.id,
        runId: randomUUID(),
        executorProfileId: competitor.executorProfileId,
        strategyInstruction: competitor.strategyInstruction,
        status: "pending",
        criterionValues: {},
        exclusions: [],
        evaluationDurationMs: null,
        resultThreadId: null,
        seal: null,
        loserDisposition: "pending",
        error: null,
        startedAt: null,
        completedAt: null,
      }),
    );
    const candidateSet: CandidateSet = {
      schemaVersion: 1,
      id: candidateSetId,
      agentId,
      objective: input.objective,
      source: {
        stateId: canonical.stateId,
        contentHash: canonical.contentHash,
        workspaceContentHash: canonical.workspaceContentHash,
        sessionContentHash: canonical.sessionContentHash,
        sqliteContentHash: canonical.sqliteContentHash,
        outboxContentHash: canonical.outboxContentHash,
        codexThreadId: canonical.codexThreadId,
        providerVersions: structuredClone(canonical.providerVersions),
      },
      outcomeContract: structuredClone(this.getAgent(agentId).outcomeContract),
      selectionContract: structuredClone(input.selectionContract),
      competitors,
      maxConcurrency: input.maxConcurrency,
      budget: structuredClone(input.budget),
      loserPolicy: input.loserPolicy,
      phase: "admitted",
      selectionDecision: null,
      selectedCompetitorId: null,
      winnerRunId: null,
      cancellationRequested: false,
      recoveryError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
      completedAt: null,
    };
    const runs: AgentRun[] = competitors.map((competitor) => ({
      id: competitor.runId,
      agentId,
      candidateSetId,
      competitorId: competitor.id,
      status: "queued",
      prompt: buildCandidateSetPrompt(
        candidateSetId,
        competitor.id,
        input.objective,
        competitor.strategyInstruction,
      ),
      output: null,
      error: null,
      usage: null,
      transaction: createRunTransaction(
        competitor.runId,
        canonical,
        candidateSet.outcomeContract,
        this.config.maxRepairDepth,
      ),
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    }));
    const agentAtStart = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "stopped") {
        throw new HttpError(
          409,
          "Start the Agent before exploring competing futures",
        );
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "This Agent already has an active operation");
      }
      if (this.isAgentLocked(agentId)) {
        throw new HttpError(
          409,
          "Wait for the Agent configuration update to finish",
        );
      }
      if (
        agent.canonicalStateId !== canonical.stateId ||
        agent.outcomeContract.version !== candidateSet.outcomeContract.version
      ) {
        throw new HttpError(
          409,
          "Canonical State changed during Candidate Set admission",
        );
      }
      agent.status = "busy";
      agent.lastError = null;
      agent.workspacePath = canonical.workspacePath;
      agent.codexThreadId = canonical.codexThreadId;
      agent.updatedAt = timestamp;
      database.candidateSets.push(candidateSet);
      database.runs.push(...runs);
      return structuredClone(agent);
    });
    this.startCandidateSetExecution(agentAtStart, candidateSet);
    return {
      candidateSet: structuredClone(candidateSet),
      runs: structuredClone(runs),
    };
  }

  async cancelCandidateSet(candidateSetId: string): Promise<CandidateSet> {
    const initial = this.getCandidateSet(candidateSetId);
    if (
      initial.phase === "completed" ||
      initial.phase === "stale" ||
      initial.phase === "recovery-error"
    ) {
      return initial;
    }
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      if (candidateSet && !candidateSet.selectionDecision) {
        candidateSet.cancellationRequested = true;
        candidateSet.updatedAt = now();
      }
    });
    if (!initial.selectionDecision) await this.cancelExecution(initial.agentId);
    return this.getCandidateSet(candidateSetId);
  }

  async listExternalEffects(): Promise<ExternalActionDeliveryReceipt[]> {
    return this.actionDispatcher.list();
  }

  async installFederatedAdmissionPolicy(
    policy: FederatedAdmissionPolicy,
  ): Promise<{
    policy: FederatedAdmissionPolicy;
    policyDigest: ReceiptDigest;
  }> {
    return this.federatedAdmissionPolicies.installAndActivate(policy);
  }

  async activeFederatedAdmissionPolicy(): Promise<{
    policy: FederatedAdmissionPolicy;
    policyDigest: ReceiptDigest;
  }> {
    return this.federatedAdmissionPolicies.readActive();
  }

  async listFederatedAdmissions(
    agentId: string,
    limit = 25,
  ): Promise<FederatedAdmissionInboxItem[]> {
    const agent = this.getAgent(agentId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, "Federated Admission inbox limit is invalid");
    }
    const admissions = (await this.federatedAdmissionJournal.listRecords())
      .filter((admission) => admission.localAgentId === agentId)
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) ||
          right.admissionId.localeCompare(left.admissionId),
      )
      .slice(0, limit);
    const snapshot = this.store.snapshot();
    return Promise.all(
      admissions.map(async (admission) => {
        const approvalResult =
          await this.federatedApprovalJournal.readResultByAdmissionId(
            admission.admissionId,
          );
        const approval = approvalResult?.approval ?? null;
        const stagedBundle =
          admission.decision.decision === "pending"
            ? await this.federatedAdmissionJournal.readPendingBundle(admission)
            : null;
        if (admission.decision.decision === "pending" && !stagedBundle) {
          throw new Error(
            "Approval-pending Federated Work Bundle is not durably staged",
          );
        }
        const review = stagedBundle
          ? buildFederatedAdmissionReview(
              stagedBundle,
              admission,
              agent.outcomeContract,
            )
          : null;
        const runRecord = admission.candidateRunId
          ? snapshot.runs.find((run) => run.id === admission.candidateRunId)
          : approvalResult?.plan.candidateRunId
            ? snapshot.runs.find(
                (run) => run.id === approvalResult.plan.candidateRunId,
              )
            : undefined;
        const run = runRecord
          ? {
              id: runRecord.id,
              status: runRecord.status,
              disposition: runRecord.transaction?.disposition ?? null,
            }
          : null;
        const state: FederatedAdmissionInboxState =
          admission.decision.decision === "reject"
            ? "rejected"
            : approval?.choice === "deny"
              ? "denied"
              : run?.disposition === "promoted"
                ? "promoted"
                : run?.disposition === "quarantined"
                  ? "quarantined"
                  : run?.status === "failed" ||
                      run?.status === "cancelled"
                    ? "failed"
                    : approval?.choice === "approve" ||
                        admission.decision.decision === "admit"
                      ? "approved"
                      : "pending";
        return {
          admission: structuredClone(admission),
          approval: approval ? structuredClone(approval) : null,
          review,
          run,
          state,
        };
      }),
    );
  }

  async importFederatedWork(
    agentId: string,
    input: FederatedImportInput,
  ): Promise<FederatedImportResult> {
    this.assertProviderRegistryReady();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.transferId)) {
      throw new HttpError(400, "Federated transfer identity is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.producerId)) {
      throw new HttpError(400, "Federated producer identity is invalid");
    }
    const agent = this.getAgent(agentId);
    const bundleReport = verifyFederatedWorkBundle(input.bundle);
    const active = await this.federatedAdmissionPolicies.readActive();
    const producerRule = active.policy.producers.find(
      (candidate) => candidate.producerId === input.producerId,
    );
    const previous = await this.federatedAdmissionJournal.readByTransfer(
      input.transferId,
    );
    const evaluatedAt = previous?.decision.evaluatedAt ?? now();
    const authorityKeyIds = producerRule?.authorityKeyIds ?? [];
    const trustPolicyReport = verifySignedSigningKeyTrustPolicyEnvelope(
      input.trustPolicy,
      authorityKeyIds,
    );
    const organizationalTrust =
      bundleReport.valid && trustPolicyReport.policy
        ? evaluateSigningKeyTrust(input.bundle.receipt, trustPolicyReport.policy, {
            cryptographicValid: true,
            evaluatedAt,
          })
        : null;
    const fallbackAuthorityKeyId =
      "sha256:" + "0".repeat(64) as ReceiptDigest;
    const admission = await this.federatedAdmissionCoordinator.admit({
      transferId: input.transferId,
      producerId: input.producerId,
      localAgentId: agentId,
      bundle: input.bundle,
      facts: {
        authorityKeyId:
          trustPolicyReport.authorityKeyId ?? fallbackAuthorityKeyId,
        authorityPinned:
          trustPolicyReport.valid && organizationalTrust?.trusted === true,
        completeDecisionChain:
          input.bundle.receipt.receipt.ancestry.depth === 0,
        evaluatedAt,
        onlineHandoff: null,
        transparency: null,
        localApprovalGranted: false,
      },
    });
    if (admission.decision.decision !== "admit") {
      return { admission, run: null };
    }
    const plan = await this.federatedAdmissionJournal.readByTransfer(
      input.transferId,
    );
    if (!plan?.candidateRunId || !plan.candidateStateId) {
      throw new Error("Admitted federated transfer has no prepared Candidate State");
    }
    const run = await this.executeFederatedCandidate({
      admission,
      candidateRunId: plan.candidateRunId,
      candidateStateId: plan.candidateStateId,
      authority: { recordDigest: admission.recordDigest },
      createdAt: admission.recordedAt,
      decisionSummary:
        "Receiver admitted verified work into isolated Candidate State under " +
        admission.decision.policyId +
        " generation " +
        admission.decision.policyGeneration,
    });
    return { admission, run };
  }

  async decideFederatedAdmission(
    admissionId: ReceiptDigest,
    input: {
      choice: FederatedApprovalChoice;
      reason: string;
      decisionContextDigest: ReceiptDigest;
    },
  ): Promise<FederatedApprovalDecisionResult> {
    this.assertProviderRegistryReady();
    if (!/^sha256:[a-f0-9]{64}$/.test(admissionId)) {
      throw new HttpError(400, "Federated Admission identity is invalid");
    }
    if (input.choice !== "approve" && input.choice !== "deny") {
      throw new HttpError(400, "Federated approval choice is invalid");
    }
    const admission = await this.federatedAdmissionJournal.readRecordByAdmissionId(
      admissionId,
    );
    if (!admission) {
      throw new HttpError(404, "Federated Admission not found");
    }
    return this.withFederatedDecisionLock(admission.localAgentId, async () => {
      const agent = this.getAgent(admission.localAgentId);
      const existingDecision =
        await this.federatedApprovalJournal.readResultByAdmissionId(admissionId);
      const expectedDecisionContextDigest = federatedDecisionContextDigest(
        admission,
        agent.outcomeContract,
      );
      if (
        !existingDecision &&
        input.decisionContextDigest !== expectedDecisionContextDigest
      ) {
        throw new HttpError(
          409,
          "Receiver review context is stale; refresh the Admission before deciding",
        );
      }
      let decision;
      try {
        decision = await this.federatedApprovalCoordinator.decide({
          pending: admission,
          decisionContextDigest: input.decisionContextDigest,
          operatorId: this.config.operatorId,
          choice: input.choice,
          reason: input.reason,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/invalid|not awaiting|conflicts/.test(message)) {
          throw new HttpError(409, message);
        }
        throw error;
      }
      if (decision.approval.choice === "deny") {
        return { admission, approval: decision.approval, run: null };
      }
      if (!decision.plan.candidateRunId || !decision.plan.candidateStateId) {
        throw new Error("Approved federated transfer has no prepared Candidate State");
      }
      const run = await this.executeFederatedCandidate({
        admission,
        candidateRunId: decision.plan.candidateRunId,
        candidateStateId: decision.plan.candidateStateId,
        authority: {
          pendingRecordDigest: admission.recordDigest,
          approvalDecisionDigest: decision.approval.recordDigest,
        },
        createdAt: decision.approval.decidedAt,
        decisionSummary:
          "Operator " +
          decision.approval.operatorId +
          " approved pending federated work after reviewing receiver evidence",
      });
      return { admission, approval: decision.approval, run };
    });
  }

  private async withFederatedDecisionLock<T>(
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.federatedDecisionOperations.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.federatedDecisionOperations.set(agentId, tail);
    await previous;
    try {
      if (this.configuringAgents.has(agentId)) {
        throw new HttpError(
          409,
          "Wait for the receiver Outcome Contract update to finish",
        );
      }
      return await operation();
    } finally {
      release();
      if (this.federatedDecisionOperations.get(agentId) === tail) {
        this.federatedDecisionOperations.delete(agentId);
      }
    }
  }

  private async executeFederatedCandidate(input: {
    admission: FederatedAdmissionRecord;
    candidateRunId: string;
    candidateStateId: string;
    authority:
      | { recordDigest: ReceiptDigest }
      | {
          pendingRecordDigest: ReceiptDigest;
          approvalDecisionDigest: ReceiptDigest;
        };
    createdAt: string;
    decisionSummary: string;
  }): Promise<AgentRun> {
    const { admission } = input;
    const agentId = admission.localAgentId;
    const agent = this.getAgent(agentId);
    const existing = this.store
      .snapshot()
      .runs.find((candidate) => candidate.id === input.candidateRunId);
    if (existing) {
      return structuredClone(existing);
    }
    const canonical = await this.workspaces.readCanonical(agentId);
    const timestamp = now();
    const transaction = createRunTransaction(
      input.candidateRunId,
      canonical,
      agent.outcomeContract,
      this.config.maxRepairDepth,
    );
    transaction.events[0] = {
      status: "preparing",
      at: timestamp,
      summary: input.decisionSummary,
    };
    transaction.candidateStateId = input.candidateStateId;
    const run: AgentRun = {
      id: input.candidateRunId,
      agentId,
      candidateSetId: null,
      competitorId: null,
      status: "running",
      prompt:
        "Federated import " +
        admission.importIdentifier +
        " from producer " +
        admission.producerId,
      output: null,
      error: null,
      usage: null,
      transaction,
      startedAt: timestamp,
      completedAt: null,
      createdAt: input.createdAt,
    };
    await this.store.mutate((database) => {
      const storedAgent = database.agents.find((candidate) => candidate.id === agentId);
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before importing federated work");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      if (
        storedAgent.canonicalStateId !== canonical.stateId ||
        storedAgent.outcomeContract.version !== transaction.outcomeContractVersion
      ) {
        throw new HttpError(
          409,
          "Receiver Canonical State changed during federated admission",
        );
      }
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      database.runs.push(run);
    });
    try {
      const result = await this.runner.validateAndPromoteFederatedCandidate(
        {
          runId: run.id,
          agentId,
          workspacePath: canonical.workspacePath,
          codexHomePath: canonical.codexHomePath,
          prompt: run.prompt,
          threadId: canonical.codexThreadId,
          canonicalStateId: canonical.stateId,
        },
        transaction,
        {
          admissionId: admission.admissionId,
          importIdentifier: admission.importIdentifier,
          recordDigest: admission.recordDigest,
          producerId: admission.producerId,
          policyDigest: admission.decision.policyDigest,
          ...(input.authority),
        },
        async (progress) => {
          await this.persistRunProgress(run.id, progress);
        },
      );
      const completedAt = now();
      await this.recordPortableDecisionAuthority(run.id, result.transaction);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((candidate) => candidate.id === run.id);
        const storedAgent = database.agents.find((candidate) => candidate.id === agentId);
        if (!storedRun || !storedAgent) {
          throw new Error("Federated Run disappeared before completion");
        }
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.transaction = result.transaction;
        storedRun.completedAt = completedAt;
        storedAgent.status = "ready";
        storedAgent.lastError = result.canonicalState
          ? null
          : "Federated Candidate was quarantined by receiver Validation";
        if (result.canonicalState) {
          storedAgent.workspacePath = result.canonicalState.workspacePath;
          storedAgent.canonicalStateId = result.canonicalState.stateId;
          storedAgent.codexThreadId = result.canonicalState.codexThreadId;
        }
        storedAgent.updatedAt = completedAt;
      });
      return this.getRun(run.id);
    } catch (error) {
      const completedAt = now();
      const terminal =
        error instanceof AirlockRunError ? error.transaction : null;
      if (
        terminal?.disposition &&
        terminal.status === terminal.disposition &&
        terminal.promotionReceipt
      ) {
        await this.recordPortableDecisionAuthority(run.id, terminal);
      }
      const message = boundedPersistedError(
        error,
        "Federated receiver execution failed closed",
        this.config,
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((candidate) => candidate.id === run.id);
        const storedAgent = database.agents.find((candidate) => candidate.id === agentId);
        if (storedRun) {
          storedRun.status = "failed";
          storedRun.error = message;
          if (terminal) storedRun.transaction = structuredClone(terminal);
          storedRun.completedAt = completedAt;
        }
        if (storedAgent) {
          storedAgent.status = "error";
          storedAgent.lastError = message;
          storedAgent.updatedAt = completedAt;
        }
      });
      throw error;
    }
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    this.assertProviderRegistryReady();
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    this.getAgent(agentId);
    const canonical = await this.workspaces.readCanonical(agentId);
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      candidateSetId: null,
      competitorId: null,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      transaction: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      if (this.isAgentLocked(agentId)) {
        throw new HttpError(
          409,
          "Wait for the Agent configuration update to finish",
        );
      }
      storedAgent.workspacePath = canonical.workspacePath;
      storedAgent.canonicalStateId = canonical.stateId;
      storedAgent.codexThreadId = canonical.codexThreadId;
      run.transaction = createRunTransaction(
        runId,
        canonical,
        storedAgent.outcomeContract,
        this.config.maxRepairDepth,
      );
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    this.startExecution(agentAtStart, run);
    return { run, message };
  }

  async repairRun(
    sourceRunId: string,
    objective?: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    this.assertProviderRegistryReady();
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    if (this.quarantineOperations.has(sourceRunId)) {
      throw new HttpError(
        409,
        "This Quarantine already has an active operation",
      );
    }
    this.quarantineOperations.add(sourceRunId);
    try {
      const source = this.getRun(sourceRunId);
      if (source.candidateSetId) {
        throw new HttpError(
          409,
          "Competing Futures losers are not Repair sources under the Phase 9 lineage contract",
        );
      }
      const sourceTransaction = source.transaction;
      if (
        !sourceTransaction ||
        sourceTransaction.disposition !== "quarantined" ||
        !sourceTransaction.quarantineAvailable
      ) {
        throw new HttpError(
          409,
          "Only an available Quarantine can start a Repair Run",
        );
      }
      if (!this.runner.canRepairProviderQuarantine(sourceTransaction)) {
        throw new HttpError(
          409,
          "This Quarantine was retained for Resource cleanup and cannot start a Repair Run",
        );
      }
      if (
        sourceTransaction.lineage.depth >= sourceTransaction.lineage.maxDepth
      ) {
        throw new HttpError(
          409,
          "This repair lineage reached its configured maximum depth",
        );
      }
      const canonical = await this.workspaces.readCanonical(source.agentId);
      if (
        canonical.stateId !== sourceTransaction.canonicalStateIdBefore ||
        canonical.contentHash !== sourceTransaction.canonicalContentHashBefore
      ) {
        throw new HttpError(
          409,
          "Canonical State advanced after this Quarantine; start a new Run against current reality",
        );
      }

      const timestamp = now();
      const runId = randomUUID();
      const prompt = buildRepairPrompt(source, objective);
      const run: AgentRun = {
        id: runId,
        agentId: source.agentId,
        candidateSetId: null,
        competitorId: null,
        status: "queued",
        prompt,
        output: null,
        error: null,
        usage: null,
        transaction: createRunTransaction(
          runId,
          canonical,
          sourceTransaction.outcomeContract,
          sourceTransaction.lineage.maxDepth,
          {
            rootRunId: sourceTransaction.lineage.rootRunId,
            parentRunId: source.id,
            depth: sourceTransaction.lineage.depth + 1,
            maxDepth: sourceTransaction.lineage.maxDepth,
          },
        ),
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
      };
      const message: Message = {
        id: randomUUID(),
        agentId: source.agentId,
        runId,
        role: "user",
        content:
          "Repair quarantined Run " +
          source.id.slice(0, 8) +
          " using its recorded failed Validation evidence.",
        createdAt: timestamp,
      };
      const agentAtStart = await this.store.mutate((database) => {
        const storedSource = database.runs.find(
          (item) => item.id === sourceRunId,
        );
        const agent = database.agents.find(
          (item) => item.id === source.agentId,
        );
        if (!storedSource?.transaction || !agent) {
          throw new HttpError(404, "Quarantine or Agent not found");
        }
        if (
          storedSource.transaction.disposition !== "quarantined" ||
          !storedSource.transaction.quarantineAvailable
        ) {
          throw new HttpError(
            409,
            "Only an available Quarantine can start a Repair Run",
          );
        }
        if (agent.status === "stopped") {
          throw new HttpError(
            409,
            "Start the Agent before repairing this Quarantine",
          );
        }
        if (agent.status === "busy") {
          throw new HttpError(409, "This Agent is already running");
        }
        if (this.isAgentLocked(agent.id)) {
          throw new HttpError(
            409,
            "Wait for the Agent configuration update to finish",
          );
        }
        if (
          database.runs.some(
            (candidate) =>
              candidate.transaction?.lineage.parentRunId === sourceRunId &&
              candidate.status !== "cancelled",
          )
        ) {
          throw new HttpError(
            409,
            "A Repair Run already exists for this Quarantine; continue from that lineage",
          );
        }
        agent.workspacePath = canonical.workspacePath;
        agent.canonicalStateId = canonical.stateId;
        agent.codexThreadId = canonical.codexThreadId;
        agent.status = "busy";
        agent.lastError = null;
        agent.updatedAt = timestamp;
        database.runs.push(run);
        database.messages.push(message);
        return structuredClone(agent);
      });
      this.startExecution(agentAtStart, run);
      return { run, message };
    } finally {
      this.quarantineOperations.delete(sourceRunId);
    }
  }

  async discardRun(runId: string): Promise<AgentRun> {
    const initial = this.getRun(runId);
    if (
      this.configuringAgents.has(initial.agentId) ||
      this.deletingAgents.has(initial.agentId)
    ) {
      throw new HttpError(409, "Wait for the active Agent operation to finish");
    }
    if (this.quarantineOperations.has(runId)) {
      throw new HttpError(
        409,
        "This Quarantine already has an active operation",
      );
    }
    this.configuringAgents.add(initial.agentId);
    this.quarantineOperations.add(runId);
    try {
      const snapshot = this.store.snapshot();
      const run = snapshot.runs.find((item) => item.id === runId);
      let transaction = run?.transaction;
      const agent = run
        ? snapshot.agents.find((item) => item.id === run.agentId)
        : undefined;
      if (!run || !transaction || !agent) {
        throw new HttpError(404, "Quarantine or Agent not found");
      }
      if (
        transaction.disposition !== "discarded" &&
        (transaction.disposition !== "quarantined" ||
          !transaction.quarantineAvailable)
      ) {
        throw new HttpError(
          409,
          "Only an available Quarantine can be discarded",
        );
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent Run to finish");
      }
      if (
        snapshot.runs.some(
          (candidate) =>
            candidate.transaction?.lineage.parentRunId === runId &&
            (candidate.status === "queued" || candidate.status === "running"),
        )
      ) {
        throw new HttpError(409, "Wait for the active Repair Run to finish");
      }

      const terminalAuthority =
        await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
          run.id,
          run.agentId,
        );
      if (!terminalAuthority) {
        throw new HttpError(
          409,
          "Quarantine has no immutable terminal decision authority",
        );
      }
      this.assertTerminalAuthorityExtendsRun(
        run,
        terminalAuthority.transaction,
      );
      if (terminalAuthority.disposition === "discarded") {
        await this.completeAuthorizedDiscard(terminalAuthority, "quarantine");
        return await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === runId);
          if (!storedRun) throw new HttpError(404, "Quarantine not found");
          storedRun.transaction = structuredClone(
            terminalAuthority.transaction,
          );
          storedRun.status = terminalRunStatus(terminalAuthority.disposition);
          this.applyCandidateLifecycleAuthority(
            database,
            storedRun,
            terminalAuthority,
          );
          return structuredClone(storedRun);
        });
      }
      if (terminalAuthority.disposition !== "quarantined") {
        throw new HttpError(
          409,
          "Only an authoritative Quarantine can be discarded",
        );
      }
      if (!(await this.workspaces.quarantineExists(run.id))) {
        throw new Error(
          "Authoritative Quarantine is missing from physical Candidate State",
        );
      }
      const candidateSetAtDiscard = run.candidateSetId
        ? (snapshot.candidateSets.find(
            (candidateSet) => candidateSet.id === run.candidateSetId,
          ) ?? null)
        : null;
      if (run.candidateSetId) {
        if (
          !candidateSetAtDiscard ||
          !candidateSetAtDiscard.competitors.some(
            (competitor) => competitor.runId === run.id,
          )
        ) {
          throw new Error(
            "Discarded Candidate Set Run contradicts its competitor lifecycle",
          );
        }
        terminalCompetitorLifecycle(candidateSetAtDiscard, run, "discarded");
      }
      transaction = structuredClone(terminalAuthority.transaction);
      const discardedAt = now();
      const discardedTransaction = markTransactionDiscarded(
        transaction,
        discardedAt,
        false,
      );
      const discardAuthority = await this.recordPortableDecisionAuthority(
        runId,
        discardedTransaction,
        candidateSetAtDiscard,
      );
      if (!discardAuthority) {
        throw new Error("Discard did not publish terminal decision authority");
      }
      await this.completeAuthorizedDiscard(discardAuthority, "quarantine");
      return await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (!storedRun?.transaction) {
          throw new HttpError(404, "Quarantine not found");
        }
        const storedCandidateSet = storedRun.candidateSetId
          ? database.candidateSets.find(
              (candidateSet) => candidateSet.id === storedRun.candidateSetId,
            )
          : null;
        const storedCompetitor = storedCandidateSet?.competitors.find(
          (competitor) => competitor.runId === storedRun.id,
        );
        if (
          storedRun.candidateSetId &&
          (!storedCandidateSet || !storedCompetitor)
        ) {
          throw new Error(
            "Discarded Candidate Set Run contradicts its competitor lifecycle",
          );
        }
        storedRun.transaction = structuredClone(discardedTransaction);
        this.applyCandidateLifecycleAuthority(
          database,
          storedRun,
          discardAuthority,
        );
        const storedAgent = database.agents.find(
          (item) => item.id === storedRun.agentId,
        );
        if (storedAgent && storedAgent.status !== "stopped") {
          storedAgent.status = "ready";
          storedAgent.lastError = null;
          storedAgent.updatedAt = discardedAt;
        }
        return structuredClone(storedRun);
      });
    } finally {
      this.quarantineOperations.delete(runId);
      this.configuringAgents.delete(initial.agentId);
    }
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    let runtime = "Codex CLI in application container";
    if (this.config.demoMode) {
      runtime = "Deterministic Codex protocol fixture";
    } else if (
      this.config.protocolFixtureMode &&
      this.config.runtimeProvider === "container"
    ) {
      runtime =
        "Real Codex CLI in disposable " +
        this.config.containerEngine +
        " Runtime";
    } else if (this.config.protocolFixtureMode) {
      runtime =
        "Real Codex CLI in application container against the local Responses protocol fixture";
    } else if (this.config.runtimeProvider === "container") {
      runtime = "Codex CLI in " + this.config.containerEngine + " Runtime";
    }

    return {
      demoMode: this.config.demoMode,
      protocolFixtureMode: this.config.protocolFixtureMode,
      modelArkDemoMode: this.config.modelArkDemoMode,
      modelArkPreflight: this.config.modelArkPreflightProof
        ? {
            checkedAt: this.config.modelArkPreflightProof.checkedAt,
            generatedAssistantOutput: true,
            attemptCount: this.config.modelArkPreflightProof.attemptCount,
            requestCount: this.config.modelArkPreflightProof.requestCount,
            retryDelayMs: this.config.modelArkPreflightProof.retryDelayMs,
          }
        : null,
      inferenceMode: this.config.demoMode
        ? "deterministic-local-fixture"
        : this.config.protocolFixtureMode
          ? "local-responses-protocol-fixture"
          : "modelark",
      arkConfigured: isArkConfigured(this.config),
      modelProfileDisclosure: "configured-status-only",
      externalActionDelivery: {
        mode: this.actionDispatcher.deliveryMode,
        destination: "demo-console",
        transport:
          this.actionDispatcher.deliveryMode === "idempotent-http"
            ? "loopback-http"
            : "platform-local-store",
        idempotency:
          this.actionDispatcher.deliveryMode === "idempotent-http"
            ? "receiver-enforced"
            : "atomic-store-enforced",
      },
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      competingFutures: {
        available: this.runnerEnforcesTokenBudgets,
        tokenBudgetEnforcement: this.runnerEnforcesTokenBudgets
          ? "provider-boundary"
          : "unsupported",
        reason: this.runnerEnforcesTokenBudgets
          ? null
          : "The configured Runner cannot enforce total-token allowances before or at inference",
      },
      portableTrust: {
        available: true,
        receiptSchema: "agent-airlock/portable-promotion-receipt@1",
        signatureAlgorithm: "Ed25519",
        verification: "offline-self-contained",
        evidenceDisclosure: "selective-merkle-proof",
        localTransparency: "optional",
        evmPayload: "offline-digest-only",
        networkRequired: false,
      },
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime,
    };
  }

  private async appendPortableTransparencyAnchor(receiptDigest: ReceiptDigest) {
    const operation = this.transparencyOperation.then(async () => {
      const transparencyKey = await loadOrCreatePortableSigningKey(
        this.config.transparencySigningKeyPath,
      );
      const log = new LocalTransparencyLog(
        this.config.transparencyLogPath,
        transparencyKey.privateKeyPem,
      );
      await log.initialize();
      return log.append(receiptDigest, now());
    });
    this.transparencyOperation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async buildPromotionRecoveryAuthorityContext(
    candidateSets: readonly CandidateSet[],
    runs: readonly AgentRun[],
  ): Promise<{
    candidateSetRunIds: Set<string>;
    expectedCandidateSetAuthorities: Map<string, PromotionAuthority>;
    expectedFederatedAuthorities: Map<string, PromotionAuthority>;
    terminalPromotionTransactions: Map<string, RunTransaction>;
    invalidCandidateSets: Map<string, string>;
  }> {
    const candidateSetRunIds = new Set(
      runs.filter((run) => run.candidateSetId !== null).map((run) => run.id),
    );
    const expectedCandidateSetAuthorities = new Map<
      string,
      PromotionAuthority
    >();
    const terminalPromotionTransactions = new Map<string, RunTransaction>();
    const expectedFederatedAuthorities = new Map<string, PromotionAuthority>();
    const invalidCandidateSets = new Map<string, string>();
    const runsById = new Map(runs.map((run) => [run.id, run]));
    for (const record of await this.federatedAdmissionJournal.listRecords()) {
      if (
        record.decision.decision !== "admit" ||
        !record.candidateRunId
      ) {
        continue;
      }
      expectedFederatedAuthorities.set(record.candidateRunId, {
        schemaVersion: 1,
        kind: "federated-admission",
        admissionId: record.admissionId,
        importIdentifier: record.importIdentifier,
        recordDigest: record.recordDigest,
        producerId: record.producerId,
        policyDigest: record.decision.policyDigest,
      });
    }
    for (const approval of await this.federatedApprovalJournal.listRecords()) {
      if (approval.choice !== "approve") continue;
      const result = await this.federatedApprovalJournal.readResultByAdmissionId(
        approval.admissionId,
      );
      const admission = await this.federatedAdmissionJournal.readRecordByAdmissionId(
        approval.admissionId,
      );
      if (
        !result ||
        result.plan.phase !== "completed" ||
        !result.plan.candidateRunId ||
        !admission ||
        admission.recordDigest !== approval.pendingRecordDigest
      ) {
        continue;
      }
      expectedFederatedAuthorities.set(result.plan.candidateRunId, {
        schemaVersion: 1,
        kind: "federated-approval",
        admissionId: admission.admissionId,
        importIdentifier: admission.importIdentifier,
        pendingRecordDigest: admission.recordDigest,
        approvalDecisionDigest: approval.recordDigest,
        producerId: admission.producerId,
        policyDigest: admission.decision.policyDigest,
      });
    }
    for (const run of runs) {
      try {
        const authority =
          await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
            run.id,
            run.agentId,
          );
        if (authority?.disposition === "promoted") {
          terminalPromotionTransactions.set(
            run.id,
            structuredClone(authority.transaction),
          );
        }
      } catch {
        // The existing authority scan below reports bounded per-Run failures.
      }
    }
    for (const candidateSet of candidateSets) {
      for (const competitor of candidateSet.competitors) {
        candidateSetRunIds.add(competitor.runId);
      }
      try {
        const authority = await this.candidateSetPromotionAuthority(
          candidateSet,
          runsById,
        );
        if (authority?.kind === "candidate-set") {
          expectedCandidateSetAuthorities.set(authority.winnerRunId, authority);
        }
      } catch (error) {
        invalidCandidateSets.set(
          candidateSet.id,
          boundedCandidateSetError(error, this.config),
        );
      }
    }
    return {
      candidateSetRunIds,
      expectedCandidateSetAuthorities,
      expectedFederatedAuthorities,
      terminalPromotionTransactions,
      invalidCandidateSets,
    };
  }

  private async candidateSetPromotionAuthority(
    candidateSet: CandidateSet,
    runsById = new Map(this.store.snapshot().runs.map((run) => [run.id, run])),
  ): Promise<PromotionAuthority | null> {
    if (candidateSet.schemaVersion !== 1) {
      throw new Error("Candidate Set schema is unsupported");
    }
    const competitorIds = new Set<string>();
    const runIds = new Set<string>();
    for (const competitor of candidateSet.competitors) {
      if (competitorIds.has(competitor.id) || runIds.has(competitor.runId)) {
        throw new Error("Candidate Set competitor identity is duplicated");
      }
      competitorIds.add(competitor.id);
      runIds.add(competitor.runId);
      const run = runsById.get(competitor.runId);
      if (
        !run ||
        run.agentId !== candidateSet.agentId ||
        run.candidateSetId !== candidateSet.id ||
        run.competitorId !== competitor.id
      ) {
        throw new Error("Candidate Set Run cross-reference is invalid");
      }
      if (competitor.seal) {
        assertPersistedSealIdentity(candidateSet, competitor);
        if (
          !run.transaction ||
          run.transaction.candidateStateId !==
            competitor.seal.candidateStateId ||
          run.output === null ||
          competitor.seal.runtimeResultHash !==
            airlockEvidenceHash({
              output: run.output,
              threadId: competitor.resultThreadId,
              usage: run.usage,
            }) ||
          (run.transaction.status === "sealed" &&
            competitor.seal.transactionEvidenceHash !==
              airlockEvidenceHash(run.transaction))
        ) {
          throw new Error(
            "Candidate Set seal contradicts its persisted Run evidence",
          );
        }
      }
    }
    if (!candidateSet.selectionDecision) {
      if (
        candidateSet.selectedCompetitorId !== null ||
        candidateSet.winnerRunId !== null
      ) {
        throw new Error(
          "Candidate Set winner exists without a Selection Decision",
        );
      }
      return null;
    }
    await this.portableDecisionJournal.readCandidateSetDecision(candidateSet);
    const replayed = this.computeCandidateSetDecision(candidateSet);
    if (stableJson(replayed) !== stableJson(candidateSet.selectionDecision)) {
      throw new Error(
        "Candidate Set Selection Decision failed deterministic replay",
      );
    }
    const selectedId = candidateSet.selectionDecision.winnerCompetitorId;
    if (selectedId === null) {
      if (
        candidateSet.selectedCompetitorId !== null ||
        candidateSet.winnerRunId !== null
      ) {
        throw new Error(
          "No-winner Selection Decision contradicts winner links",
        );
      }
      return null;
    }
    const winner = candidateSet.competitors.find(
      (competitor) => competitor.id === selectedId,
    );
    if (
      !winner?.seal ||
      candidateSet.selectedCompetitorId !== selectedId ||
      candidateSet.winnerRunId !== winner.runId
    ) {
      throw new Error(
        "Selection Decision contradicts the persisted winner seal",
      );
    }
    return {
      schemaVersion: 1,
      kind: "candidate-set",
      candidateSetId: candidateSet.id,
      competitorId: winner.id,
      winnerRunId: winner.runId,
      selectionDecisionDigest: candidateSet.selectionDecision.decisionDigest,
      sealDigest: winner.seal.sealDigest,
      sourceStateId: candidateSet.source.stateId,
      sourceContentHash: candidateSet.source.contentHash,
    };
  }

  private async reconcileCandidateSetsAfterStartup(
    invalidCandidateSets: ReadonlyMap<string, string>,
  ): Promise<number> {
    for (const [candidateSetId, message] of invalidCandidateSets) {
      await this.failCandidateSetClosed(
        candidateSetId,
        "recovery-error",
        "Candidate Set authority validation failed: " + message,
      );
    }
    const candidateSetIds = this.store
      .snapshot()
      .candidateSets.filter(
        (candidateSet) =>
          !invalidCandidateSets.has(candidateSet.id) &&
          candidateSet.phase !== "completed" &&
          candidateSet.phase !== "stale" &&
          candidateSet.phase !== "recovery-error",
      )
      .map((candidateSet) => candidateSet.id);
    for (const candidateSetId of candidateSetIds) {
      try {
        let candidateSet = this.getCandidateSet(candidateSetId);
        if (
          candidateSet.phase === "admitted" ||
          candidateSet.phase === "evaluating" ||
          candidateSet.phase === "evaluated"
        ) {
          if (
            candidateSet.phase === "admitted" ||
            candidateSet.phase === "evaluating"
          ) {
            await this.normalizeInterruptedCandidateSetEvaluations(
              candidateSetId,
            );
          }
          candidateSet = this.getCandidateSet(candidateSetId);
          const canonical =
            await this.workspaces.readCanonicalForProviderTransition(
              candidateSet.agentId,
            );
          if (
            canonical.stateId !== candidateSet.source.stateId ||
            canonical.contentHash !== candidateSet.source.contentHash
          ) {
            throw new StaleCandidateSourceError(
              "Canonical State changed before interrupted Candidate Selection",
            );
          }
          await this.persistRecoveredCandidateSetDecision(candidateSetId);
          candidateSet = this.getCandidateSet(candidateSetId);
        }
        if (candidateSet.phase === "selected") {
          await this.promoteCandidateSetWinner(candidateSetId);
          candidateSet = this.getCandidateSet(candidateSetId);
        } else if (candidateSet.phase === "promoting") {
          const winnerRun = candidateSet.winnerRunId
            ? this.getRun(candidateSet.winnerRunId)
            : null;
          if (winnerRun?.transaction?.disposition === "promoted") {
            const canonical =
              await this.workspaces.readCanonicalForProviderTransition(
                candidateSet.agentId,
              );
            await this.store.mutate((database) => {
              const storedSet = database.candidateSets.find(
                (item) => item.id === candidateSetId,
              );
              const winner = storedSet?.competitors.find(
                (competitor) =>
                  competitor.id === storedSet.selectedCompetitorId,
              );
              const agent = database.agents.find(
                (item) => item.id === candidateSet.agentId,
              );
              if (storedSet) {
                storedSet.phase = "promoted";
                storedSet.recoveryError = null;
                storedSet.updatedAt = now();
              }
              if (winner) winner.status = "promoted";
              if (agent) {
                agent.workspacePath = canonical.workspacePath;
                agent.canonicalStateId = canonical.stateId;
                agent.codexThreadId = canonical.codexThreadId;
              }
            });
            candidateSet = this.getCandidateSet(candidateSetId);
          } else if (winnerRun?.transaction?.status === "sealed") {
            await this.promoteCandidateSetWinner(candidateSetId);
            candidateSet = this.getCandidateSet(candidateSetId);
          } else {
            throw new Error(
              "Interrupted winner Promotion did not converge to its selected Candidate",
            );
          }
        }
        if (candidateSet.phase === "no-winner") {
          await this.updateCandidateSetPhase(candidateSetId, "cleaning-losers");
          candidateSet = this.getCandidateSet(candidateSetId);
        } else if (candidateSet.phase === "promoted") {
          await this.updateCandidateSetPhase(candidateSetId, "cleaning-losers");
          candidateSet = this.getCandidateSet(candidateSetId);
        }
        if (candidateSet.phase === "cleaning-losers") {
          await this.cleanupCandidateSetLosers(
            candidateSetId,
            candidateSet.selectedCompetitorId,
            true,
          );
          await this.completeCandidateSet(
            candidateSetId,
            candidateSet.selectedCompetitorId,
          );
        }
      } catch (error) {
        if (error instanceof StaleCandidateSourceError) {
          const cleanupFailure = await this.cleanupCandidateSetLosers(
            candidateSetId,
            null,
            false,
          ).then(
            () => null,
            (failure: unknown) => failure,
          );
          await this.failCandidateSetClosed(
            candidateSetId,
            cleanupFailure ? "recovery-error" : "stale",
            cleanupFailure
              ? error.message +
                  "; Candidate cleanup also failed closed: " +
                  (cleanupFailure instanceof Error
                    ? cleanupFailure.message
                    : String(cleanupFailure))
              : error.message,
          );
          continue;
        }
        await this.failCandidateSetClosed(
          candidateSetId,
          "recovery-error",
          "Candidate Set restart recovery failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return this.store.snapshot().candidateSets.filter((candidateSet) => {
      if (candidateSet.phase === "recovery-error") return true;
      if (
        candidateSet.phase !== "completed" &&
        candidateSet.phase !== "stale"
      ) {
        return true;
      }
      return candidateSet.competitors.some((competitor) => {
        const run = this.store
          .snapshot()
          .runs.find((item) => item.id === competitor.runId);
        return !run?.transaction?.disposition;
      });
    }).length;
  }

  private async normalizeInterruptedCandidateSetEvaluations(
    candidateSetId: string,
  ): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      if (!candidateSet) return;
      for (const competitor of candidateSet.competitors) {
        const run = database.runs.find((item) => item.id === competitor.runId);
        if (!run) {
          competitor.status = "failed";
          competitor.exclusions = ["restart-missing-run-evidence"];
          continue;
        }
        if (run.transaction?.status === "sealed" && competitor.seal) {
          competitor.status = "eligible";
          continue;
        }
        if (
          competitor.status === "pending" ||
          competitor.status === "running" ||
          competitor.status === "eligible"
        ) {
          competitor.status =
            run.status === "cancelled" ? "cancelled" : "ineligible";
          competitor.exclusions = ["restart-interrupted-evaluation"];
          competitor.error = run.error
            ? boundedCandidateSetError(run.error, this.config)
            : null;
          competitor.completedAt = run.completedAt ?? timestamp;
        }
      }
      candidateSet.phase = "evaluated";
      candidateSet.updatedAt = timestamp;
    });
  }

  private async persistRecoveredCandidateSetDecision(
    candidateSetId: string,
  ): Promise<void> {
    const candidateSet = this.getCandidateSet(candidateSetId);
    if (candidateSet.selectionDecision) {
      await this.portableDecisionJournal.readCandidateSetDecision(candidateSet);
      return;
    }
    const existingAuthority =
      await this.portableDecisionJournal.readCandidateSetDecisionById(
        candidateSetId,
      );
    const authorizedCandidateSet = existingAuthority
      ? this.restoreCandidateSetDecision(candidateSet, existingAuthority)
      : this.createAuthorizedCandidateSetDecision(candidateSet);
    if (!existingAuthority) {
      await this.portableDecisionJournal.recordCandidateSetDecision(
        authorizedCandidateSet,
      );
    }
    await this.recordTerminalCandidateSetAuthorities(authorizedCandidateSet);
    await this.store.mutate((database) => {
      const storedSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      if (!storedSet || storedSet.selectionDecision) return;
      storedSet.selectionDecision = structuredClone(
        authorizedCandidateSet.selectionDecision,
      );
      storedSet.selectedCompetitorId =
        authorizedCandidateSet.selectedCompetitorId;
      storedSet.winnerRunId = authorizedCandidateSet.winnerRunId;
      storedSet.phase = authorizedCandidateSet.winnerRunId
        ? "selected"
        : "no-winner";
      storedSet.decidedAt = authorizedCandidateSet.decidedAt;
      storedSet.updatedAt = authorizedCandidateSet.decidedAt!;
      const winner = storedSet.competitors.find(
        (competitor) =>
          competitor.id === authorizedCandidateSet.selectedCompetitorId,
      );
      if (winner) {
        winner.status = "selected";
        winner.loserDisposition = "winner";
      }
    });
  }

  private createAuthorizedCandidateSetDecision(
    candidateSet: CandidateSet,
  ): CandidateSet {
    const decision = this.computeCandidateSetDecision(candidateSet);
    const authorized = structuredClone(candidateSet);
    authorized.selectionDecision = structuredClone(decision);
    authorized.selectedCompetitorId = decision.winnerCompetitorId;
    authorized.winnerRunId = decision.winnerCompetitorId
      ? (authorized.competitors.find(
          (competitor) => competitor.id === decision.winnerCompetitorId,
        )?.runId ?? null)
      : null;
    authorized.decidedAt = candidateSet.updatedAt;
    return authorized;
  }

  private restoreCandidateSetDecision(
    candidateSet: CandidateSet,
    authority: CandidateSetDecisionAuthorityRecord,
  ): CandidateSet {
    const recorded = authority.candidateSetAuthority;
    const restored = structuredClone(candidateSet);
    restored.selectionDecision = structuredClone(recorded.selectionDecision);
    restored.selectedCompetitorId = recorded.selectedCompetitorId;
    restored.winnerRunId = recorded.winnerRunId;
    restored.decidedAt = recorded.decidedAt;
    if (
      portableCandidateSetAuthorityHash(restored) !==
      authority.candidateSetAuthorityDigest
    ) {
      throw new Error(
        "Mutable Candidate Set contradicts its immutable Selection authority",
      );
    }
    return restored;
  }

  private async recordTerminalCandidateSetAuthorities(
    candidateSet: CandidateSet,
  ): Promise<void> {
    const database = this.store.snapshot();
    for (const competitor of candidateSet.competitors) {
      const run = database.runs.find((item) => item.id === competitor.runId);
      const transaction = run?.transaction;
      if (
        !run ||
        !transaction?.disposition ||
        transaction.status !== transaction.disposition ||
        !transaction.promotionReceipt ||
        transaction.recovery.recoveryError !== null
      ) {
        continue;
      }
      await this.recordPortableDecisionAuthorityFromDatabase(
        database,
        run.id,
        transaction,
        candidateSet,
      );
    }
  }

  private computeCandidateSetDecision(candidateSet: CandidateSet) {
    return replayCandidateSelection(
      candidateSet,
      new Map(this.store.snapshot().runs.map((run) => [run.id, run])),
    );
  }

  private async executeCandidateSet(
    agentAtStart: Agent,
    admitted: CandidateSet,
  ): Promise<void> {
    await this.updateCandidateSetPhase(admitted.id, "evaluating");
    let nextIndex = 0;
    try {
      const workers = Array.from(
        { length: admitted.maxConcurrency },
        async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const competitor = admitted.competitors[index];
            if (!competitor) return;
            const current = this.getCandidateSet(admitted.id);
            if (current.cancellationRequested) {
              await this.markPendingCompetitorCancelled(
                admitted.id,
                competitor.id,
              );
              continue;
            }
            await this.evaluateCandidateSetCompetitor(
              agentAtStart,
              admitted,
              competitor,
            );
          }
        },
      );
      await Promise.all(workers);

      const canonical = await this.workspaces.readCanonical(admitted.agentId);
      if (
        canonical.stateId !== admitted.source.stateId ||
        canonical.contentHash !== admitted.source.contentHash
      ) {
        const staleMessage =
          "Canonical State changed before Candidate Selection";
        const cleanupFailure = await this.cleanupCandidateSetLosers(
          admitted.id,
          null,
          false,
        ).then(
          () => null,
          (failure: unknown) => failure,
        );
        await this.failCandidateSetClosed(
          admitted.id,
          cleanupFailure ? "recovery-error" : "stale",
          cleanupFailure
            ? staleMessage +
                "; Candidate cleanup also failed closed: " +
                (cleanupFailure instanceof Error
                  ? cleanupFailure.message
                  : String(cleanupFailure))
            : staleMessage,
        );
        return;
      }
      await this.updateCandidateSetPhase(admitted.id, "evaluated");
      await this.persistRecoveredCandidateSetDecision(admitted.id);
      const decidedCandidateSet = this.getCandidateSet(admitted.id);
      const decision = decidedCandidateSet.selectionDecision;
      if (!decision) {
        throw new Error("Candidate Set Selection authority was not persisted");
      }

      if (!decision.winnerCompetitorId) {
        await this.updateCandidateSetPhase(admitted.id, "cleaning-losers");
        await this.cleanupCandidateSetLosers(admitted.id, null, true);
        await this.completeCandidateSet(admitted.id, null);
        return;
      }
      await this.promoteCandidateSetWinner(admitted.id);
      await this.updateCandidateSetPhase(admitted.id, "cleaning-losers");
      await this.cleanupCandidateSetLosers(
        admitted.id,
        decision.winnerCompetitorId,
        true,
      );
      await this.completeCandidateSet(admitted.id, decision.winnerCompetitorId);
    } catch (error) {
      if (error instanceof StaleCandidateSourceError) {
        const cleanupError = await this.cleanupCandidateSetLosers(
          admitted.id,
          null,
          false,
        ).then(
          () => null,
          (failure: unknown) => failure,
        );
        await this.failCandidateSetClosed(
          admitted.id,
          cleanupError ? "recovery-error" : "stale",
          cleanupError
            ? error.message +
                "; Candidate cleanup also failed closed: " +
                (cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError))
            : error.message,
        );
        return;
      }
      if (error instanceof AirlockRunError) {
        const safeError = boundedCandidateSetError(error, this.config);
        const authorityCandidateSet = this.getCandidateSet(admitted.id);
        const winnerRunId = authorityCandidateSet.winnerRunId;
        if (winnerRunId) {
          await this.recordPortableDecisionAuthority(
            winnerRunId,
            error.transaction,
            authorityCandidateSet.selectionDecision
              ? authorityCandidateSet
              : null,
          );
        }
        await this.store.mutate((database) => {
          const candidateSet = database.candidateSets.find(
            (item) => item.id === admitted.id,
          );
          const run = database.runs.find(
            (item) => item.id === candidateSet?.winnerRunId,
          );
          const agent = database.agents.find(
            (item) => item.id === admitted.agentId,
          );
          if (run) {
            run.status = "failed";
            run.error = safeError;
            run.transaction = error.transaction;
            run.completedAt = now();
          }
          if (candidateSet) {
            candidateSet.recoveryError = safeError;
            candidateSet.updatedAt = now();
          }
          if (agent) {
            agent.status = "error";
            agent.lastError = safeError;
            agent.updatedAt = now();
          }
        });
        return;
      }
      const failureMessage = boundedCandidateSetError(error, this.config);
      let cleanupFailure: unknown = null;
      try {
        await this.cleanupCandidateSetLosers(admitted.id, null, false);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      await this.failCandidateSetClosed(
        admitted.id,
        "recovery-error",
        cleanupFailure
          ? failureMessage +
              "; Candidate cleanup also failed closed: " +
              (cleanupFailure instanceof Error
                ? cleanupFailure.message
                : String(cleanupFailure))
          : failureMessage,
      );
    }
  }

  private async evaluateCandidateSetCompetitor(
    agentAtStart: Agent,
    candidateSet: CandidateSet,
    competitorAtAdmission: CandidateSetCompetitor,
  ): Promise<void> {
    const tokenAllowance = candidateTokenAllowance(
      candidateSet,
      competitorAtAdmission.id,
    );
    const startedAt = now();
    await this.store.mutate((database) => {
      const storedSet = database.candidateSets.find(
        (item) => item.id === candidateSet.id,
      );
      const competitor = storedSet?.competitors.find(
        (item) => item.id === competitorAtAdmission.id,
      );
      const run = database.runs.find(
        (item) => item.id === competitorAtAdmission.runId,
      );
      if (competitor) {
        competitor.status = "running";
        competitor.startedAt = startedAt;
      }
      if (run) {
        run.status = "running";
        run.startedAt = startedAt;
      }
      if (storedSet) storedSet.updatedAt = startedAt;
    });
    const monotonicStarted = performance.now();
    let durationBudgetExpired = false;
    let durationCancellation: Promise<boolean> = Promise.resolve(false);
    const durationTimer = setTimeout(() => {
      durationBudgetExpired = true;
      durationCancellation = this.runner
        .cancel(candidateSet.agentId, competitorAtAdmission.runId)
        .catch(() => false);
    }, candidateSet.budget.maxDurationMsPerCompetitor);
    try {
      const run = this.getRun(competitorAtAdmission.runId);
      const result = await this.runner.run(
        {
          runId: run.id,
          agentId: candidateSet.agentId,
          executionId: run.id,
          workspacePath: agentAtStart.workspacePath,
          codexHomePath: "",
          prompt: run.prompt,
          threadId: candidateSet.source.codexThreadId,
          canonicalStateId: candidateSet.source.stateId,
          tokenBudget: {
            schemaVersion: 1,
            maximumTotalTokens: tokenAllowance,
          },
        },
        run.transaction ??
          createRunTransaction(
            run.id,
            await this.workspaces.readCanonical(candidateSet.agentId),
            candidateSet.outcomeContract,
            this.config.maxRepairDepth,
          ),
        async (transaction) => {
          await this.persistRunProgress(run.id, transaction);
        },
        {
          deferPromotionFor: {
            candidateSetId: candidateSet.id,
            competitorId: competitorAtAdmission.id,
          },
        },
      );
      const durationMs = Math.round(performance.now() - monotonicStarted);
      const observedTokens = trustedTotalTokenUsage(result.usage);
      if (observedTokens === null) {
        throw new Error(
          "Trusted Runtime omitted required total-token usage evidence",
        );
      }
      if (observedTokens > tokenAllowance) {
        throw new Error(
          "Trusted Runtime exceeded its reserved total-token allowance",
        );
      }
      const completedAt = now();
      const sourceMatches =
        result.transaction.canonicalStateIdBefore ===
          candidateSet.source.stateId &&
        result.transaction.canonicalContentHashBefore ===
          candidateSet.source.contentHash &&
        result.transaction.outcomeContractVersion ===
          candidateSet.outcomeContract.version;
      if (!sourceMatches) {
        throw new StaleCandidateSourceError(
          "Sibling Candidate did not share the admitted source and Outcome Contract",
        );
      }
      const values = result.sealedCandidate
        ? criterionValuesForRun(result.transaction, result.usage, durationMs)
        : {};
      const exclusions = [
        ...(durationMs > candidateSet.budget.maxDurationMsPerCompetitor
          ? ["competitor-budget:duration-ms"]
          : []),
        ...(!result.sealedCandidate ? ["required-validation-failed"] : []),
      ];
      await this.store.mutate((database) => {
        const storedSet = database.candidateSets.find(
          (item) => item.id === candidateSet.id,
        );
        const competitor = storedSet?.competitors.find(
          (item) => item.id === competitorAtAdmission.id,
        );
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (competitor) {
          competitor.status = result.sealedCandidate
            ? "eligible"
            : "ineligible";
          competitor.criterionValues = values;
          competitor.exclusions = exclusions;
          competitor.evaluationDurationMs = durationMs;
          competitor.resultThreadId = result.threadId;
          competitor.seal = result.sealedCandidate ?? null;
          competitor.completedAt = completedAt;
        }
        if (storedRun) {
          storedRun.status = "completed";
          storedRun.output = result.output;
          storedRun.error = null;
          storedRun.usage = result.usage;
          storedRun.transaction = result.transaction;
          storedRun.completedAt = completedAt;
        }
        if (storedSet) storedSet.updatedAt = completedAt;
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - monotonicStarted);
      const completedAt = now();
      const cancelled =
        !durationBudgetExpired &&
        (error instanceof RunCancelledError ||
          (error instanceof AirlockRunError && error.cancelled));
      const message = durationBudgetExpired
        ? "Candidate evaluation exceeded its duration budget"
        : boundedCandidateSetError(error, this.config);
      if (error instanceof AirlockRunError) {
        await this.recordPortableDecisionAuthority(
          competitorAtAdmission.runId,
          error.transaction,
          null,
        );
      }
      await this.store.mutate((database) => {
        const storedSet = database.candidateSets.find(
          (item) => item.id === candidateSet.id,
        );
        const competitor = storedSet?.competitors.find(
          (item) => item.id === competitorAtAdmission.id,
        );
        const run = database.runs.find(
          (item) => item.id === competitorAtAdmission.runId,
        );
        if (competitor) {
          competitor.status = cancelled ? "cancelled" : "failed";
          competitor.exclusions = [
            durationBudgetExpired
              ? "competitor-budget:duration-ms"
              : cancelled
                ? "candidate-set-cancelled"
                : "candidate-evaluation-failed",
          ];
          competitor.evaluationDurationMs = durationMs;
          competitor.error = message;
          competitor.completedAt = completedAt;
        }
        if (run) {
          run.status = cancelled ? "cancelled" : "failed";
          run.error = message;
          if (error instanceof AirlockRunError)
            run.transaction = error.transaction;
          run.completedAt = completedAt;
        }
        if (storedSet) storedSet.updatedAt = completedAt;
      });
    } finally {
      clearTimeout(durationTimer);
      await durationCancellation;
    }
  }

  private async promoteCandidateSetWinner(
    candidateSetId: string,
  ): Promise<void> {
    const candidateSet = this.getCandidateSet(candidateSetId);
    const authority = await this.candidateSetPromotionAuthority(candidateSet);
    const winner = candidateSet.competitors.find(
      (competitor) => competitor.id === candidateSet.selectedCompetitorId,
    );
    if (
      authority?.kind !== "candidate-set" ||
      !winner?.seal ||
      winner.runId !== candidateSet.winnerRunId ||
      authority.winnerRunId !== winner.runId
    ) {
      throw new Error(
        "Candidate Set winner decision has no matching sealed Candidate",
      );
    }
    const run = this.getRun(winner.runId);
    if (!run.transaction || run.output === null) {
      throw new Error("Selected Candidate Run evidence is incomplete");
    }
    if (candidateSet.phase === "selected") {
      await this.updateCandidateSetPhase(candidateSetId, "promoting");
    } else if (candidateSet.phase !== "promoting") {
      throw new Error(
        "Candidate Set cannot resume Promotion from " + candidateSet.phase,
      );
    }
    const canonical = await this.workspaces.readCanonicalForProviderTransition(
      candidateSet.agentId,
    );
    const result = await this.runner.promoteSealedCandidate(
      {
        runId: run.id,
        agentId: candidateSet.agentId,
        workspacePath: canonical.workspacePath,
        codexHomePath: canonical.codexHomePath,
        prompt: run.prompt,
        threadId: candidateSet.source.codexThreadId,
        canonicalStateId: candidateSet.source.stateId,
      },
      winner.seal,
      run.transaction,
      { output: run.output, threadId: winner.resultThreadId, usage: run.usage },
      authority,
      async (transaction) => {
        await this.persistRunProgress(run.id, transaction);
      },
    );
    const promotedAt = now();
    await this.recordPortableDecisionAuthority(
      run.id,
      result.transaction,
      candidateSet,
    );
    await this.store.mutate((database) => {
      const storedSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const storedWinner = storedSet?.competitors.find(
        (competitor) => competitor.id === winner.id,
      );
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find(
        (item) => item.id === candidateSet.agentId,
      );
      if (!storedSet || !storedWinner || !storedRun || !agent) {
        throw new Error("Candidate Set winner disappeared during Promotion");
      }
      storedSet.phase = "promoted";
      storedSet.updatedAt = promotedAt;
      storedWinner.status = "promoted";
      storedRun.status = "completed";
      storedRun.output = result.output;
      storedRun.usage = result.usage;
      storedRun.transaction = result.transaction;
      storedRun.error = null;
      storedRun.completedAt = promotedAt;
      if (!result.canonicalState) {
        throw new Error(
          "Selected Candidate Promotion returned no Canonical State",
        );
      }
      agent.workspacePath = result.canonicalState.workspacePath;
      agent.canonicalStateId = result.canonicalState.stateId;
      agent.codexThreadId = result.canonicalState.codexThreadId;
      agent.updatedAt = promotedAt;
    });
  }

  private async cleanupCandidateSetLosers(
    candidateSetId: string,
    winnerId: string | null,
    updatePhase: boolean,
  ): Promise<void> {
    const candidateSet = this.getCandidateSet(candidateSetId);
    for (const competitor of candidateSet.competitors) {
      if (competitor.id === winnerId) continue;
      const run = this.getRun(competitor.runId);
      if (!run.transaction) {
        throw new Error(
          "Candidate Set loser cleanup requires its admitted Run Transaction",
        );
      }
      let transaction = run.transaction;
      let terminalAuthority: PortableDecisionAuthorityRecord | null = null;
      if (transaction.status === "sealed" && transaction.disposition === null) {
        transaction = await this.runner.disposeSealedCandidate(
          candidateSet.agentId,
          transaction,
          candidateSet.loserPolicy,
          async (progress) => {
            if (
              progress.disposition &&
              progress.status === progress.disposition &&
              progress.promotionReceipt
            ) {
              terminalAuthority = await this.recordPortableDecisionAuthority(
                run.id,
                progress,
                candidateSet,
              );
              return;
            }
            await this.persistRunProgress(run.id, progress);
          },
          async (cleaned) => {
            const authority =
              terminalAuthority ??
              (await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
                run.id,
                run.agentId,
              ));
            if (!authority || authority.disposition !== "discarded") {
              throw new Error(
                "Candidate Set loser provider cleanup has no Discard authority",
              );
            }
            if (!requiresProviderDiscardCleanupFact(authority.transaction)) {
              return;
            }
            await this.portableDecisionJournal.recordDiscardCleanup(
              authority,
              cleaned,
            );
            terminalAuthority = authority;
          },
        );
      } else if (
        candidateSet.loserPolicy === "discard" &&
        transaction.disposition === "quarantined" &&
        transaction.quarantineAvailable
      ) {
        const authority =
          await this.portableDecisionJournal.readUnambiguousTerminalAuthority(
            run.id,
            run.agentId,
          );
        if (!authority) {
          throw new Error(
            "Candidate Set loser Quarantine has no immutable authority",
          );
        }
        this.assertTerminalAuthorityExtendsRun(run, authority.transaction);
        if (authority.disposition === "discarded") {
          transaction = structuredClone(authority.transaction);
          terminalAuthority = authority;
        } else if (authority.disposition === "quarantined") {
          if (!(await this.workspaces.quarantineExists(run.id))) {
            throw new Error(
              "Candidate Set loser authoritative Quarantine is missing",
            );
          }
          transaction = markTransactionDiscarded(
            authority.transaction,
            now(),
            false,
          );
          terminalAuthority = await this.recordPortableDecisionAuthority(
            run.id,
            transaction,
            candidateSet,
          );
          if (!terminalAuthority) {
            throw new Error(
              "Candidate Set loser Discard did not publish terminal authority",
            );
          }
        } else {
          throw new Error(
            "Candidate Set loser cleanup found contradictory terminal authority",
          );
        }
        await this.completeAuthorizedDiscard(terminalAuthority, "quarantine");
        transaction = structuredClone(terminalAuthority.transaction);
      }
      if (
        !transaction.disposition ||
        transaction.status !== transaction.disposition ||
        !transaction.promotionReceipt
      ) {
        throw new Error(
          "Candidate Set loser cleanup did not produce a terminal Run decision",
        );
      }
      const disposition =
        transaction.disposition === "quarantined" ? "retained" : "discarded";
      if (candidateSet.selectionDecision && !terminalAuthority) {
        terminalAuthority = await this.recordPortableDecisionAuthority(
          run.id,
          transaction,
          candidateSet,
        );
      }
      await this.store.mutate((database) => {
        const storedSet = database.candidateSets.find(
          (item) => item.id === candidateSetId,
        );
        const storedCompetitor = storedSet?.competitors.find(
          (item) => item.id === competitor.id,
        );
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (!storedSet || !storedCompetitor || !storedRun) {
          throw new Error(
            "Candidate Set loser disappeared before terminal publication",
          );
        }
        storedRun.transaction = structuredClone(transaction);
        if (terminalAuthority && storedSet.winnerRunId !== storedRun.id) {
          this.applyCandidateLifecycleAuthority(
            database,
            storedRun,
            terminalAuthority,
          );
        } else {
          storedCompetitor.status = disposition;
          storedCompetitor.loserDisposition = disposition;
          storedSet.updatedAt = now();
        }
      });
    }
    if (updatePhase) {
      const latest = this.getCandidateSet(candidateSetId);
      if (latest.phase !== "cleaning-losers") {
        throw new Error(
          "Candidate Set loser cleanup changed phase unexpectedly",
        );
      }
    }
  }

  private async markPendingCompetitorCancelled(
    candidateSetId: string,
    competitorId: string,
  ): Promise<void> {
    const completedAt = now();
    const snapshot = this.store.snapshot();
    const candidateSet = snapshot.candidateSets.find(
      (item) => item.id === candidateSetId,
    );
    const competitor = candidateSet?.competitors.find(
      (item) => item.id === competitorId,
    );
    const run = snapshot.runs.find((item) => item.id === competitor?.runId);
    if (!candidateSet || !competitor || !run) {
      throw new Error("Candidate Set pending competitor disappeared");
    }
    if (competitor.status !== "pending" || run.status !== "queued") {
      throw new Error(
        "Candidate Set pending competitor changed before cancellation",
      );
    }
    if (!run.transaction) {
      throw new Error(
        "Candidate Set pending competitor has no Run Transaction",
      );
    }
    const terminalTransaction = markTransactionCancelledBeforeStart(
      run.transaction,
      completedAt,
    );
    await this.recordPortableDecisionAuthority(
      run.id,
      terminalTransaction,
      null,
    );
    await this.store.mutate((database) => {
      const storedCandidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const storedCompetitor = storedCandidateSet?.competitors.find(
        (item) => item.id === competitorId,
      );
      const storedRun = database.runs.find(
        (item) => item.id === storedCompetitor?.runId,
      );
      if (
        !storedCandidateSet ||
        !storedCompetitor ||
        !storedRun ||
        storedCompetitor.status !== "pending" ||
        storedRun.status !== "queued"
      ) {
        throw new Error(
          "Candidate Set pending competitor changed during cancellation",
        );
      }
      storedCompetitor.status = "cancelled";
      storedCompetitor.exclusions = ["candidate-set-cancelled"];
      storedCompetitor.completedAt = completedAt;
      storedRun.status = "cancelled";
      storedRun.error =
        "Candidate Set was cancelled before this competitor started";
      storedRun.completedAt = completedAt;
      storedRun.transaction = structuredClone(terminalTransaction);
      storedCandidateSet.updatedAt = completedAt;
    });
  }

  private async updateCandidateSetPhase(
    candidateSetId: string,
    phase: CandidateSet["phase"],
  ): Promise<void> {
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      if (!candidateSet) throw new Error("Candidate Set not found");
      const allowed: Partial<
        Record<CandidateSet["phase"], CandidateSet["phase"][]>
      > = {
        admitted: ["evaluating"],
        evaluating: ["evaluated"],
        selected: ["promoting"],
        promoted: ["cleaning-losers"],
        "no-winner": ["cleaning-losers"],
      };
      if (!allowed[candidateSet.phase]?.includes(phase)) {
        throw new Error(
          "Candidate Set cannot transition from " +
            candidateSet.phase +
            " to " +
            phase,
        );
      }
      candidateSet.phase = phase;
      candidateSet.updatedAt = now();
    });
  }

  private async completeCandidateSet(
    candidateSetId: string,
    winnerId: string | null,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const agent = database.agents.find(
        (item) => item.id === candidateSet?.agentId,
      );
      if (!candidateSet || !agent) return;
      candidateSet.phase = "completed";
      candidateSet.completedAt = completedAt;
      candidateSet.updatedAt = completedAt;
      if (agent.status !== "stopped") agent.status = "ready";
      agent.lastError = winnerId
        ? null
        : "Candidate Set completed without an eligible winner";
      agent.updatedAt = completedAt;
    });
  }

  private async failCandidateSetClosed(
    candidateSetId: string,
    phase: "stale" | "recovery-error",
    error: string,
  ): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const agent = database.agents.find(
        (item) => item.id === candidateSet?.agentId,
      );
      const safeError = boundedCandidateSetError(error, this.config);
      if (candidateSet) {
        candidateSet.phase = phase;
        candidateSet.recoveryError = safeError;
        candidateSet.updatedAt = timestamp;
        candidateSet.completedAt = timestamp;
      }
      if (agent) {
        agent.status = phase === "stale" ? "ready" : "error";
        agent.lastError = safeError;
        agent.updatedAt = timestamp;
      }
    });
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const canonical = await this.workspaces.readCanonical(agentAtStart.id);
      const repairSourceRunId = run.transaction?.lineage.parentRunId ?? null;
      const repairProviderQuarantines = repairSourceRunId
        ? (this.store
            .snapshot()
            .runs.find((candidate) => candidate.id === repairSourceRunId)
            ?.transaction?.providerResources.flatMap((resource) =>
              resource.quarantine ? [resource.quarantine] : [],
            ) ?? [])
        : [];
      const result = await this.runner.run(
        {
          runId: run.id,
          agentId: agentAtStart.id,
          workspacePath: canonical.workspacePath,
          codexHomePath: canonical.codexHomePath,
          prompt: run.prompt,
          threadId: canonical.codexThreadId,
          canonicalStateId: canonical.stateId,
          repairSourceRunId,
          repairProviderQuarantines,
        },
        run.transaction ??
          createRunTransaction(
            run.id,
            await this.workspaces.readCanonical(agentAtStart.id),
            agentAtStart.outcomeContract,
            this.config.maxRepairDepth,
          ),
        async (transaction) => {
          await this.persistRunProgress(run.id, transaction);
        },
      );
      const completedAt = now();
      await this.recordPortableDecisionAuthority(run.id, result.transaction);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.transaction = result.transaction;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        if (result.canonicalState) {
          agent.workspacePath = result.canonicalState.workspacePath;
          agent.canonicalStateId = result.canonicalState.stateId;
          agent.codexThreadId = result.canonicalState.codexThreadId;
          agent.lastError = null;
        } else {
          agent.lastError =
            "Run quarantined because a required Validation failed";
        }
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError ||
        (error instanceof AirlockRunError && error.cancelled);
      const message = boundedPersistedError(
        error,
        "Run failed closed",
        this.config,
      );
      const currentRun = this.store
        .snapshot()
        .runs.find((candidate) => candidate.id === run.id);
      let terminalTransaction: RunTransaction | null = null;
      if (error instanceof AirlockRunError) {
        terminalTransaction = structuredClone(error.transaction);
      } else if (cancelled && currentRun?.transaction) {
        terminalTransaction = structuredClone(currentRun.transaction);
        terminalTransaction.status = "cancelled";
        terminalTransaction.disposition = "cancelled";
        terminalTransaction.canonicalStateIdAfter =
          terminalTransaction.canonicalStateIdBefore;
        terminalTransaction.canonicalContentHashAfter =
          terminalTransaction.canonicalContentHashBefore;
        terminalTransaction = completeInterruptedValidationEvidence(
          terminalTransaction,
          "Validation was skipped because the Run was cancelled before execution",
        );
        terminalTransaction = finalizeResources(
          terminalTransaction,
          "cancelled",
        );
        terminalTransaction.events.push({
          status: "cancelled",
          at: completedAt,
          summary: "Run Transaction was cancelled before execution",
        });
        terminalTransaction.promotionReceipt =
          createPromotionReceipt(terminalTransaction);
      }
      if (terminalTransaction) {
        await this.recordPortableDecisionAuthority(run.id, terminalTransaction);
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          if (terminalTransaction) {
            storedRun.transaction = structuredClone(terminalTransaction);
          }
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private assertProviderRegistryReady(): void {
    if (this.actionDispatcherReadinessError) {
      throw new HttpError(
        503,
        "External action dispatcher is not operational: " +
          this.actionDispatcherReadinessError,
      );
    }
    if (!this.providerRegistryReady) {
      throw new HttpError(
        503,
        "Resource Registry transition is incomplete; resolve provider onboarding errors before creating or running Agents",
      );
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    if (status === "ready" && this.isAgentLocked(id)) {
      throw new HttpError(
        409,
        "This Agent has unresolved Candidate disposition evidence",
      );
    }
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before starting this Agent",
        );
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private startExecution(agent: Agent, run: AgentRun): void {
    const execution = this.executeRun(agent, run);
    this.activeExecutions.set(agent.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agent.id) === execution) {
          this.activeExecutions.delete(agent.id);
        }
      })
      .catch(() => undefined);
  }

  private startCandidateSetExecution(
    agent: Agent,
    candidateSet: CandidateSet,
  ): void {
    const execution = this.executeCandidateSet(agent, candidateSet);
    this.activeExecutions.set(agent.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agent.id) === execution) {
          this.activeExecutions.delete(agent.id);
        }
      })
      .catch(() => undefined);
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

function normalizeAssuranceDecisionReason(reason: string): string {
  const normalized = reason.trim();
  if (
    Buffer.byteLength(normalized, "utf8") > 500 ||
    redactSensitiveText(normalized) !== normalized
  ) {
    throw new HttpError(
      400,
      "Assurance decision reason must be credential-free and at most 500 bytes",
    );
  }
  return normalized;
}

function boundedCandidateSetError(error: unknown, config: AppConfig): string {
  return boundedPersistedError(
    error,
    "Candidate Set operation failed closed",
    config,
  );
}

function boundedPersistedError(
  error: unknown,
  fallback: string,
  config: AppConfig,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /429 Too Many Requests|HTTP 429|inference limit|safe experience mode/i.test(
      message,
    )
  ) {
    return "ModelArk temporarily unavailable because its configured inference limit or free capacity was reached. Canonical State remains unchanged; keep Free Credits Only Mode enabled and retry later.";
  }
  if (/401 Unauthorized|HTTP 401|authentication failed/i.test(message)) {
    return "ModelArk authentication failed. Verify the Ark API key, region, and model configuration.";
  }
  if (
    /HTTP 404|modelnotopen|model.*not activated|model.*unavailable/i.test(
      message,
    )
  ) {
    return "The configured ModelArk model is unavailable. Verify model activation, model ID, and region.";
  }
  const configuredValues = [
    config.arkApiKey,
    config.authToken,
    config.arkBaseUrl,
    config.arkModel,
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const withoutConfiguredValues = configuredValues.reduce(
    (value, configured) => value.split(configured).join("[REDACTED]"),
    message,
  );
  const safe = redactSensitiveText(withoutConfiguredValues)
    .replace(
      /\brequest(?:[_ -]?id)?\s*[:=]\s*[A-Za-z0-9._:-]+/gi,
      "request id: [REDACTED]",
    )
    .replace(/\baccount\s+\d{4,}\b/gi, "account [REDACTED]")
    .trim();
  return (safe || fallback).slice(0, 500);
}

function sanitizeTransactionRecoveryError(
  transaction: RunTransaction,
  config: AppConfig,
): RunTransaction {
  const sanitized = structuredClone(transaction);
  if (sanitized.recovery.recoveryError) {
    sanitized.recovery.recoveryError = boundedPersistedError(
      sanitized.recovery.recoveryError,
      "Run recovery failed closed",
      config,
    );
  }
  return sanitized;
}

function assertPersistedSealIdentity(
  candidateSet: CandidateSet,
  competitor: CandidateSetCompetitor,
): void {
  const seal = competitor.seal;
  if (!seal) throw new Error("Candidate Set competitor seal is missing");
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
    seal.candidateSetId !== candidateSet.id ||
    seal.competitorId !== competitor.id ||
    seal.runId !== competitor.runId ||
    seal.sourceStateId !== candidateSet.source.stateId ||
    seal.sourceContentHash !== candidateSet.source.contentHash ||
    seal.outcomeContractVersion !== candidateSet.outcomeContract.version ||
    seal.sealDigest !== airlockEvidenceHash(unsigned)
  ) {
    throw new Error("Candidate Set seal identity or digest is invalid");
  }
}

function airlockEvidenceHash(value: unknown): string {
  return (
    "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex")
  );
}

function buildRepairPrompt(source: AgentRun, objective?: string): string {
  const failedEvidence =
    source.transaction?.validations
      .filter(
        (validation) => validation.required && validation.status !== "passed",
      )
      .map((validation) => {
        const output = validation.output
          ? "\nEvidence: " + validation.output
          : "";
        return "- " + validation.name + ": " + validation.summary + output;
      })
      .join("\n") ||
    "- The prior Run did not retain a decisive Validation detail.";
  const boundedObjective =
    objective?.trim() ||
    "Correct only the recorded required Validation failures while preserving useful quarantined work.";
  const prompt = [
    "Agent Airlock Repair Run for quarantined transaction " + source.id + ".",
    "",
    "Original objective:",
    source.prompt,
    "",
    "Bounded remediation objective:",
    boundedObjective,
    "",
    "Failed required Validation evidence:",
    failedEvidence,
    "",
    "A bounded snapshot of the unchanged Canonical workspace is available at AIRLOCK_REPAIR_REFERENCE_PATH.",
    "Use it only to restore required or protected content cited by the failed evidence.",
    "Preserve useful Candidate State changes, keep the repair narrow, and rerun relevant checks.",
    "If an external action is still intended, submit it deliberately through the fresh AIRLOCK_OUTBOX_PATH.",
  ].join("\n");
  const bytes = Buffer.from(prompt, "utf8");
  return bytes.byteLength <= 12_000
    ? prompt
    : bytes.subarray(0, 12_000).toString("utf8") +
        "\n[Repair evidence truncated by Agent Airlock]";
}

function buildCandidateSetPrompt(
  candidateSetId: string,
  competitorId: string,
  objective: string,
  strategyInstruction: string,
): string {
  return [
    "Agent Airlock Candidate Set " + candidateSetId + ".",
    "Competitor " + competitorId + ".",
    "Work only inside your isolated Candidate State.",
    "You cannot observe or coordinate with sibling Candidates.",
    "Do not request Promotion or dispatch external effects.",
    "",
    "Shared objective:",
    objective,
    "",
    "Trusted bounded strategy:",
    strategyInstruction,
  ].join("\n");
}

function criterionValuesForRun(
  transaction: RunTransaction,
  usage: AgentRun["usage"],
  durationMs: number,
): CandidateSetCompetitor["criterionValues"] {
  const values: CandidateSetCompetitor["criterionValues"] = {
    "quality-assertion": createQualityAssertion({
      validations: transaction.validations.filter(
        (validation) => !validation.name.startsWith("assurance-"),
      ),
    }),
  };
  const changedFiles = transaction.changes?.totalChangedFiles;
  if (
    Number.isSafeInteger(changedFiles) &&
    changedFiles !== undefined &&
    changedFiles >= 0 &&
    changedFiles <= SELECTION_CRITERIA["changed-files"].maximum
  ) {
    values["changed-files"] = changedFiles;
  }
  const addedBytes = transaction.changes?.totalAddedBytes;
  if (
    Number.isSafeInteger(addedBytes) &&
    addedBytes !== undefined &&
    addedBytes >= 0 &&
    addedBytes <= SELECTION_CRITERIA["added-bytes"].maximum
  ) {
    values["added-bytes"] = addedBytes;
  }
  if (
    Number.isSafeInteger(durationMs) &&
    durationMs >= 0 &&
    durationMs <= SELECTION_CRITERIA["latency-ms"].maximum
  ) {
    values["latency-ms"] = durationMs;
  }
  const totalTokens = trustedTotalTokenUsage(usage);
  if (
    totalTokens !== null &&
    Number.isSafeInteger(totalTokens) &&
    totalTokens >= 0 &&
    totalTokens <= SELECTION_CRITERIA["total-tokens"].maximum
  ) {
    values["total-tokens"] = totalTokens;
  }
  return values;
}

function candidateTokenAllowance(
  candidateSet: CandidateSet,
  competitorId: string,
): number {
  const index = candidateSet.competitors.findIndex(
    (competitor) => competitor.id === competitorId,
  );
  if (index < 0)
    throw new Error("Candidate Set token reservation has no competitor");
  const base = Math.floor(
    candidateSet.budget.maxTotalTokens / candidateSet.competitors.length,
  );
  const remainder =
    candidateSet.budget.maxTotalTokens % candidateSet.competitors.length;
  const allowance = base + (index < remainder ? 1 : 0);
  if (!Number.isSafeInteger(allowance) || allowance < 1) {
    throw new Error("Candidate Set token reservation is invalid");
  }
  return allowance;
}

function trustedTotalTokenUsage(usage: AgentRun["usage"]): number | null {
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    (usage.inputTokens ?? -1) < 0 ||
    (usage.outputTokens ?? -1) < 0
  ) {
    return null;
  }
  const total = (usage.inputTokens as number) + (usage.outputTokens as number);
  return Number.isSafeInteger(total) ? total : null;
}

function completeInterruptedValidationEvidence(
  transaction: RunTransaction,
  summary: string,
): RunTransaction {
  const next = structuredClone(transaction);
  const existing = new Set(
    next.validations.map((validation) => validation.name),
  );
  const required = [
    { name: "path-safety", required: true },
    { name: "protected-paths", required: true },
    { name: "required-paths", required: true },
    { name: "change-limits", required: true },
    { name: "secret-patterns", required: true },
    ...next.outcomeContract.validationCommands.map((command) => ({
      name: `command:${command.name}`,
      required: command.required,
    })),
  ];
  for (const validation of required) {
    if (existing.has(validation.name)) continue;
    next.validations.push({
      name: validation.name,
      status: "error",
      required: validation.required,
      summary,
      durationMs: 0,
      output: null,
    });
  }
  return next;
}

function markTransactionDiscarded(
  transaction: RunTransaction,
  discardedAt: string,
  expired: boolean,
): RunTransaction {
  let next = structuredClone(transaction);
  next.disposition = "discarded";
  next.status = "discarded";
  next.quarantinePath = null;
  next.quarantineAvailable = false;
  next.discardedAt = discardedAt;
  next = finalizeResources(next, "discarded");
  next.providerResources = next.providerResources.map((resource) => ({
    ...resource,
    disposition: "discarded",
    summary: resource.label + " Quarantine was discarded",
  }));
  next.events.push({
    status: "discarded",
    at: discardedAt,
    summary: expired
      ? "Quarantine retention expired; bounded decision evidence remains"
      : "Mutable Quarantine was discarded; bounded decision evidence remains",
  });
  next.promotionReceipt = createPromotionReceipt(next);
  return next;
}

function requiresProviderDiscardCleanupFact(
  transaction: RunTransaction,
): boolean {
  const hasProviderRecoveryState =
    transaction.providerResources.length > 0 ||
    transaction.providerResourceEvents.some(
      (event) => event.stage === "prepare" && event.status === "failed",
    );
  return (
    hasProviderRecoveryState && !hasCompleteProviderDiscardEvidence(transaction)
  );
}

function isEquivalentRecoveredPromotionReplay(
  authority: RunTransaction,
  replay: RunTransaction,
): boolean {
  if (
    authority.status !== "promoted" ||
    authority.disposition !== "promoted" ||
    authority.recovery.journalPhase !== "completed" ||
    !authority.recovery.recoveredAfterRestart ||
    authority.recovery.recoveryError !== null ||
    replay.status !== "promoted" ||
    replay.disposition !== "promoted" ||
    replay.recovery.journalPhase !== "completed" ||
    !replay.recovery.recoveredAfterRestart ||
    replay.recovery.recoveryError !== null
  ) {
    return false;
  }
  const providerCount = authority.providerResources.length;
  const providerKinds = new Map(
    authority.providerResources.map((resource) => [
      resource.providerId,
      resource.resourceKind,
    ]),
  );
  if (
    replay.providerResources.length !== providerCount ||
    providerKinds.size !== providerCount
  ) {
    return false;
  }
  const authorityCore = structuredClone(authority);
  const replayCore = structuredClone(replay);
  authorityCore.providerResourceEvents = [];
  replayCore.providerResourceEvents = [];
  if (stableJson(authorityCore) !== stableJson(replayCore)) {
    return false;
  }
  if (providerCount === 0) {
    return (
      stableJson(authority.providerResourceEvents) ===
      stableJson(replay.providerResourceEvents)
    );
  }
  let commonEventCount = 0;
  while (
    commonEventCount < authority.providerResourceEvents.length &&
    commonEventCount < replay.providerResourceEvents.length &&
    stableJson(authority.providerResourceEvents[commonEventCount]) ===
      stableJson(replay.providerResourceEvents[commonEventCount])
  ) {
    commonEventCount += 1;
  }
  for (let split = commonEventCount; split >= 0; split -= 1) {
    const authorityRecoveryEvents =
      authority.providerResourceEvents.slice(split);
    const replayRecoveryEvents = replay.providerResourceEvents.slice(split);
    if (
      authorityRecoveryEvents.length === 0 &&
      replayRecoveryEvents.length === 0
    ) {
      continue;
    }
    if (
      isExactPromotionReconciliationSequence(
        authorityRecoveryEvents,
        providerKinds,
      ) &&
      isExactPromotionReconciliationSequence(
        replayRecoveryEvents,
        providerKinds,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isExactPromotionReconciliationSequence(
  events: RunTransaction["providerResourceEvents"],
  providerKinds: Map<string, string>,
): boolean {
  const providerCount = providerKinds.size;
  if (providerCount === 0) return true;
  if (events.length === 0) return true;
  if (events.length % providerCount !== 0) return false;
  const exactEventKeys = [
    "schemaVersion",
    "providerId",
    "resourceKind",
    "stage",
    "status",
    "summary",
    "at",
  ].sort();
  for (let offset = 0; offset < events.length; offset += providerCount) {
    const seen = new Set<string>();
    const batch = events.slice(offset, offset + providerCount);
    if (
      !batch.every((event) => {
        if (
          stableJson(Object.keys(event).sort()) !==
            stableJson(exactEventKeys) ||
          event.schemaVersion !== 1 ||
          providerKinds.get(event.providerId) !== event.resourceKind ||
          seen.has(event.providerId) ||
          event.stage !== "reconcile" ||
          event.status !== "passed" ||
          typeof event.summary !== "string" ||
          event.summary.length === 0 ||
          event.summary.length > 512 ||
          !Number.isFinite(Date.parse(event.at))
        ) {
          return false;
        }
        seen.add(event.providerId);
        return true;
      })
    ) {
      return false;
    }
  }
  return true;
}

function terminalRunStatus(
  disposition: NonNullable<RunTransaction["disposition"]>,
): AgentRun["status"] {
  if (disposition === "promoted") return "completed";
  if (disposition === "cancelled") return "cancelled";
  return "failed";
}

function isImmutableTerminalRecoveryFailure(run: AgentRun): boolean {
  return (
    run.status === "failed" &&
    Boolean(
      run.error?.startsWith("Immutable terminal decision recovery failed:"),
    )
  );
}

function terminalRunStatusMatches(
  disposition: NonNullable<RunTransaction["disposition"]>,
  status: AgentRun["status"],
): boolean {
  if (disposition === "promoted") return status === "completed";
  if (disposition === "cancelled") return status === "cancelled";
  return status === "completed" || status === "failed";
}

function terminalCompetitorLifecycle(
  candidateSet: CandidateSet,
  run: AgentRun,
  disposition: NonNullable<RunTransaction["disposition"]>,
): Pick<CandidateSetCompetitor, "status" | "loserDisposition"> {
  if (disposition === "promoted") {
    if (
      candidateSet.winnerRunId !== run.id ||
      candidateSet.selectedCompetitorId !== run.competitorId
    ) {
      throw new Error(
        "Promoted terminal authority contradicts the Candidate Set winner",
      );
    }
    return { status: "promoted", loserDisposition: "winner" };
  }
  if (disposition === "quarantined") {
    return { status: "retained", loserDisposition: "retained" };
  }
  return { status: "discarded", loserDisposition: "discarded" };
}

function projectCandidateSetLifecycleAtAuthority(
  candidateSet: CandidateSet,
  run: AgentRun,
  disposition: NonNullable<RunTransaction["disposition"]>,
): CandidateSet {
  const projected = structuredClone(candidateSet);
  const competitor = projected.competitors.find(
    (candidate) => candidate.runId === run.id,
  );
  if (!competitor) {
    throw new Error(
      "Portable receipt authority has no Candidate Set competitor",
    );
  }
  const lifecycle = terminalCompetitorLifecycle(projected, run, disposition);
  competitor.status = lifecycle.status;
  competitor.loserDisposition = lifecycle.loserDisposition;
  return projected;
}

function markTransactionCancelledBeforeStart(
  transaction: RunTransaction,
  cancelledAt: string,
): RunTransaction {
  let next = structuredClone(transaction);
  next.status = "cancelled";
  next.disposition = "cancelled";
  next.canonicalStateIdAfter = next.canonicalStateIdBefore;
  next.canonicalContentHashAfter = next.canonicalContentHashBefore;
  next.externalActions.intents = next.externalActions.intents.map((intent) => ({
    ...intent,
    status: "rejected",
    deliveredAt: null,
  }));
  if (next.sqlite?.before)
    next.sqlite.after = structuredClone(next.sqlite.before);
  next = completeInterruptedValidationEvidence(
    next,
    "Validation could not run because the Candidate Set cancelled this Run before execution",
  );
  next = finalizeResources(next, "cancelled");
  next.events.push({
    status: "cancelled",
    at: cancelledAt,
    summary: "Candidate Set cancelled this Run before Runtime execution",
  });
  next.promotionReceipt = createPromotionReceipt(next);
  return next;
}

function buildFederatedAdmissionReview(
  bundle: FederatedWorkBundle,
  admission: FederatedAdmissionRecord,
  contract: OutcomeContract,
): FederatedAdmissionReview {
  const operations = bundle.artifact.artifact.operations;
  const displayed = operations.slice(0, 50).map((operation) => ({
    operation: operation.operation,
    path:
      operation.operation === "rename" ? operation.fromPath : operation.path,
    toPath: operation.operation === "rename" ? operation.toPath : null,
    byteLength:
      operation.operation === "add" || operation.operation === "modify"
        ? operation.byteLength
        : null,
  }));
  const receipt = bundle.receipt.receipt;
  const affectedPaths = [
    ...new Set(
      operations.flatMap((operation) =>
        operation.operation === "rename"
          ? [operation.fromPath, operation.toPath]
          : [operation.path],
      ),
    ),
  ].sort();
  const protectedPaths = affectedPaths.filter((affectedPath) =>
    contract.protectedPaths.some((pattern) =>
      matchesOutcomePathPattern(affectedPath, pattern),
    ),
  );
  const resultingWrittenPaths = new Set(
    operations.flatMap((operation) =>
      operation.operation === "add" || operation.operation === "modify"
        ? [operation.path]
        : operation.operation === "rename"
          ? [operation.toPath]
          : [],
    ),
  );
  const removedPaths = new Set(
    operations.flatMap((operation) =>
      operation.operation === "delete"
        ? [operation.path]
        : operation.operation === "rename"
          ? [operation.fromPath]
          : [],
    ),
  );
  const requiredLiteralRemoved = contract.requiredPaths
    .filter((pattern) => !/[*?]/.test(pattern))
    .filter(
      (requiredPath) =>
        removedPaths.has(requiredPath) && !resultingWrittenPaths.has(requiredPath),
    );
  const totalPayloadBytes = operations.reduce(
    (total, operation) =>
      total +
      (operation.operation === "add" || operation.operation === "modify"
        ? operation.byteLength
        : 0),
    0,
  );
  const blockers: FederatedAdmissionReview["preflight"]["blockers"] = [];
  if (protectedPaths.length > 0) {
    blockers.push({
      code: "protected-path-change",
      summary:
        protectedPaths.length +
        " proposed path" +
        (protectedPaths.length === 1 ? " matches" : "s match") +
        " the receiver protected-path policy",
      paths: protectedPaths.slice(0, 10),
    });
  }
  if (affectedPaths.length > contract.maxChangedFiles) {
    blockers.push({
      code: "changed-files-limit",
      summary:
        affectedPaths.length +
        " affected paths exceed the receiver limit of " +
        contract.maxChangedFiles,
      paths: affectedPaths.slice(0, 10),
    });
  }
  if (totalPayloadBytes > contract.maxAddedBytes) {
    blockers.push({
      code: "added-bytes-limit",
      summary:
        totalPayloadBytes +
        " known payload bytes exceed the receiver limit of " +
        contract.maxAddedBytes,
      paths: [],
    });
  }
  if (requiredLiteralRemoved.length > 0) {
    blockers.push({
      code: "required-literal-removed",
      summary:
        requiredLiteralRemoved.length +
        " required literal path" +
        (requiredLiteralRemoved.length === 1 ? " is" : "s are") +
        " removed without replacement",
      paths: requiredLiteralRemoved.slice(0, 10),
    });
  }
  const deferredChecks: FederatedAdmissionReview["preflight"]["deferredChecks"] = [
    "secret-content-scan",
    "candidate-resource-validation",
  ];
  if (contract.requiredPaths.some((pattern) => /[*?]/.test(pattern))) {
    deferredChecks.push("required-glob-presence");
  }
  if (operations.some((operation) => operation.operation === "rename")) {
    deferredChecks.push("rename-payload-size");
  }
  if (contract.validationCommands.length > 0) {
    deferredChecks.push("validation-commands");
  }
  return {
    schemaVersion: 1,
    authority: "producer-claim-non-authoritative",
    decisionContextDigest: federatedDecisionContextDigest(admission, contract),
    producerClaim: {
      runId: receipt.decision.runId,
      agentId: receipt.decision.agentId,
      disposition: receipt.decision.disposition,
      decidedAt: receipt.decision.decidedAt,
      outcomeContractVersion: receipt.outcomeContract.version,
    },
    artifact: {
      operationCount: operations.length,
      displayedOperationCount: displayed.length,
      truncated: displayed.length < operations.length,
      totalPayloadBytes,
      operations: displayed,
    },
    resources: {
      builtinBefore: receipt.state.before.builtinResources.length,
      builtinAfter: receipt.state.after.builtinResources.length,
      providerBefore: receipt.state.before.providerResources.length,
      providerAfter: receipt.state.after.providerResources.length,
    },
    preflight: {
      authority: "metadata-only-not-validation",
      contractVersion: contract.version,
      status: blockers.length > 0 ? "predicted-blocker" : "no-metadata-blocker",
      affectedPathCount: affectedPaths.length,
      blockers,
      deferredChecks,
    },
  };
}

function federatedDecisionContextDigest(
  admission: FederatedAdmissionRecord,
  contract: OutcomeContract,
): ReceiptDigest {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        stableJson({
          schema: "agent-airlock/federated-decision-context",
          schemaVersion: 1,
          admissionId: admission.admissionId,
          pendingRecordDigest: admission.recordDigest,
          outcomeContractDigest: outcomeContractHash(contract),
        }),
      )
      .digest("hex")
  ) as ReceiptDigest;
}
