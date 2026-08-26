import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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
  selectCandidates,
  stableJson,
} from "./candidate-selection.js";
import { validateCandidateSetInput } from "./candidate-set.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  ExternalActionOutbox,
  MockExternalActionDispatcher,
  type MockDeliveryReceipt,
} from "./external-actions.js";
import {
  createDefaultOutcomeContract,
  createNextOutcomeContract,
} from "./outcome-contract.js";
import { OutcomeValidator } from "./outcome-validator.js";
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
  CandidateSet,
  CandidateSetCompetitor,
  CanonicalStateReference,
  CreateAgentInput,
  CreateCandidateSetInput,
  Message,
  OutcomeContract,
  OutcomeContractInput,
  RunTransaction,
  UpdateAgentInput,
} from "./types.js";
import {
  ContainerValidationCommandExecutor,
  type ValidationCommandExecutor,
} from "./validation-command-runner.js";
import { WorkspaceManager, type AgentArchiveAudit } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly configuringAgents = new Set<string>();
  private readonly quarantineOperations = new Set<string>();
  private readonly runner: AirlockRunner;
  private readonly actionDispatcher: MockExternalActionDispatcher;
  private readonly promotionJournal: PromotionJournal;
  private readonly runnerEnforcesTokenBudgets: boolean;
  private providerRegistryReady = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    runner: AgentRunner,
    validationCommandExecutor: ValidationCommandExecutor =
      new ContainerValidationCommandExecutor(config),
    promotionFaultInjector?: PromotionFaultInjector,
    private readonly resourceCoordinator: ResourceCoordinator = new ResourceCoordinator(
      new ResourceRegistry(),
    ),
  ) {
    this.runnerEnforcesTokenBudgets =
      runner.tokenBudgetEnforcement === "provider-boundary";
    this.actionDispatcher = new MockExternalActionDispatcher(
      path.join(config.dataDirectory, "mock-deliveries.json"),
    );
    this.promotionJournal = new PromotionJournal(
      path.join(config.dataDirectory, "promotion-journal"),
    );
    this.runner = new AirlockRunner(
      runner,
      workspaces,
      new OutcomeValidator(validationCommandExecutor),
      new SqliteResource(),
      new ExternalActionOutbox(),
      this.actionDispatcher,
      this.promotionJournal,
      this.resourceCoordinator,
      promotionFaultInjector,
    );
  }

  async initialize(): Promise<void> {
    this.providerRegistryReady = false;
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.actionDispatcher.initialize();
    await this.promotionJournal.initialize();
    const registryDescriptors = this.resourceCoordinator.registryDescriptors();
    const registryGeneration = await this.workspaces.nextProviderRegistryGeneration(
      registryDescriptors,
    );
    const snapshot = this.store.snapshot();
    const promotionAuthority = this.buildPromotionRecoveryAuthorityContext(
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
            run.status !== "completed" || unresolvedCandidateSetRunIds.has(run.id),
        )
        .map((run) => run.id),
    );
    const recovery = await this.runner.reconcilePromotions(
      recoverCompletedRunIds,
      {
        candidateSetRunIds: promotionAuthority.candidateSetRunIds,
        expectedCandidateSetAuthorities:
          promotionAuthority.expectedCandidateSetAuthorities,
      },
    );
    const recoveredRunIds = new Set(recovery.recovered.map((item) => item.runId));
    const recoveryFailures = new Map(
      recovery.failures
        .filter((failure) => failure.runId)
        .map((failure) => [failure.runId as string, failure]),
    );
    const interrupted = new Map<
      string,
      Awaited<ReturnType<WorkspaceManager["quarantineInterruptedCandidate"]>>
    >();
    const activeRunIds = snapshot.runs
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => run.id);
    for (const runId of activeRunIds) {
      if (recoveredRunIds.has(runId) || recovery.protectedRunIds.has(runId)) {
        continue;
      }
      interrupted.set(
        runId,
        await this.workspaces.quarantineInterruptedCandidate(runId),
      );
    }

    const protectedRunIds = new Set([
      ...recovery.protectedRunIds,
      ...activeRunIds,
      ...unresolvedCandidateSetRunIds,
    ]);
    const cleanupTransactions = new Map<string, RunTransaction>();
    const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
    const startupTime = Date.now();
    const cleanup = await this.workspaces.cleanupExpiredState({
      candidateOlderThan: new Date(
        startupTime - this.config.candidateRetentionMs,
      ).toISOString(),
      quarantineOlderThan: new Date(
        startupTime - this.config.quarantineRetentionMs,
      ).toISOString(),
      protectedRunIds,
      beforeRemove: async ({ runId, root }) => {
        const run = runsById.get(runId);
        if (
          !run?.transaction ||
          (run.transaction.providerResources.length === 0 &&
            !run.transaction.providerResourceEvents.some(
              (event) => event.stage === "prepare" && event.status === "failed",
            ))
        ) {
          return;
        }
        const cleaned = await this.runner.discardRetainedProviderState(
          run.agentId,
          cleanupTransactions.get(runId) ?? run.transaction,
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

    const missingQuarantineDisposition = new Map<
      string,
      "discarded" | "recovery-error"
    >();
    for (const run of snapshot.runs) {
      if (
        run.transaction?.disposition !== "quarantined" ||
        !run.transaction.quarantineAvailable ||
        cleanup.quarantineRunIds.includes(run.id)
      ) {
        continue;
      }
      try {
        if (await this.workspaces.quarantineExists(run.id)) continue;
        missingQuarantineDisposition.set(
          run.id,
          this.runner.providerDiscardCompleted(run.transaction)
            ? "discarded"
            : "recovery-error",
        );
      } catch {
        missingQuarantineDisposition.set(run.id, "recovery-error");
      }
    }

    await this.store.mutate((database) => {
      for (const recovered of recovery.recovered) {
        const run = database.runs.find((item) => item.id === recovered.runId);
        const agent = database.agents.find((item) => item.id === recovered.agentId);
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
        run.transaction = recovered.transaction;
        run.completedAt = completedAt;
        if (
          !run.candidateSetId &&
          !database.messages.some(
            (message) => message.runId === run.id && message.role === "assistant",
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
        run.status = "failed";
        run.error = failure.message;
        run.completedAt = now();
        if (failure.transaction) {
          run.transaction = failure.transaction;
        } else if (run.transaction) {
          run.transaction.status = "recovery-error";
          run.transaction.recovery = {
            ...run.transaction.recovery,
            recoveredAfterRestart: true,
            recoveryError: failure.message.slice(0, 500),
          };
        }
      }

      for (const run of database.runs) {
        if (
          (run.status !== "queued" && run.status !== "running") ||
          recoveredRunIds.has(run.id) ||
          recoveryFailures.has(run.id)
        ) {
          continue;
        }
        const retained = interrupted.get(run.id);
        const completedAt = now();
        run.completedAt = completedAt;
        if (retained?.quarantinePath && run.transaction) {
          run.status = "failed";
          run.error = "Server restarted; the interrupted Candidate was retained in Quarantine";
          run.transaction.status = "quarantined";
          run.transaction.disposition = "quarantined";
          run.transaction.quarantinePath = retained.quarantinePath;
          run.transaction.quarantineAvailable = true;
          run.transaction.canonicalStateIdAfter =
            run.transaction.canonicalStateIdBefore;
          run.transaction.canonicalContentHashAfter =
            run.transaction.canonicalContentHashBefore;
          run.transaction = finalizeResources(run.transaction, "quarantined");
          run.transaction.events.push({
            status: "quarantined",
            at: completedAt,
            summary: "Server restart retained the interrupted Candidate in Quarantine",
          });
          run.transaction.promotionReceipt = createPromotionReceipt(run.transaction);
        } else if (retained?.error && run.transaction) {
          run.status = "failed";
          run.error = "Interrupted Candidate recovery failed: " + retained.error;
          run.transaction.status = "recovery-error";
          run.transaction.recovery = {
            ...run.transaction.recovery,
            recoveredAfterRestart: true,
            recoveryError: retained.error.slice(0, 500),
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
            run.transaction = finalizeResources(run.transaction, "cancelled");
            run.transaction.events.push({
              status: "cancelled",
              at: completedAt,
              summary: "Server restarted before Candidate State was available",
            });
            run.transaction.promotionReceipt = createPromotionReceipt(run.transaction);
          }
        }
      }

      for (const runId of cleanup.quarantineRunIds) {
        const run = database.runs.find((item) => item.id === runId);
        if (!run?.transaction || run.transaction.disposition !== "quarantined") {
          continue;
        }
        const discardedAt = now();
        run.transaction = markTransactionDiscarded(
          cleanupTransactions.get(runId) ?? run.transaction,
          discardedAt,
          true,
        );
      }

      for (const runId of cleanup.candidateRunIds) {
        const run = database.runs.find((item) => item.id === runId);
        const cleaned = cleanupTransactions.get(runId);
        if (run?.transaction && cleaned) {
          run.transaction = structuredClone(cleaned);
        }
      }

      for (const [runId, disposition] of missingQuarantineDisposition) {
        const run = database.runs.find((item) => item.id === runId);
        if (!run?.transaction || run.transaction.disposition !== "quarantined") {
          continue;
        }
        if (disposition === "discarded") {
          run.transaction = markTransactionDiscarded(
            run.transaction,
            now(),
            false,
          );
          run.transaction.events.at(-1)!.summary =
            "Interrupted Discard completed; bounded decision evidence remains";
          continue;
        }
        run.status = "failed";
        run.error =
          "Quarantine recovery failed: mutable state is missing without complete provider Discard evidence";
        run.transaction.status = "recovery-error";
        run.transaction.quarantineAvailable = false;
        run.transaction.recovery = {
          ...run.transaction.recovery,
          recoveredAfterRestart: true,
          recoveryError:
            "Mutable Quarantine is missing without complete provider Discard evidence",
        };
      }

      for (const agent of database.agents) {
        const recoveryFailure = recovery.failures.find(
          (failure) => failure.agentId === agent.id,
        );
        const corruptJournalFailure = database.runs
          .filter((run) => run.agentId === agent.id)
          .map((run) => recoveryFailures.get(run.id))
          .find((failure) => failure !== undefined);
        if (recoveryFailure || corruptJournalFailure) {
          agent.status = "error";
          agent.lastError =
            recoveryFailure?.message ??
            corruptJournalFailure?.message ??
            null;
          agent.updatedAt = now();
        } else if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    const candidateSetRecoveryFailureCount =
      await this.reconcileCandidateSetsAfterStartup(
        promotionAuthority.invalidCandidateSets,
      );
    await this.transitionProviderRegistryAfterRecovery(
      registryDescriptors,
      registryGeneration,
      recovery.failures.length,
      candidateSetRecoveryFailureCount,
    );
  }

  private async transitionProviderRegistryAfterRecovery(
    registryDescriptors: ReturnType<ResourceCoordinator["registryDescriptors"]>,
    registryGeneration: number,
    promotionRecoveryFailureCount: number,
    candidateSetRecoveryFailureCount: number,
  ): Promise<void> {
    const canonicalStates = new Map<string, CanonicalStateReference>();
    const canonicalErrors = new Map<string, string>();
    const agents = this.store.snapshot().agents;
    if (
      promotionRecoveryFailureCount === 0 &&
      candidateSetRecoveryFailureCount === 0
    ) {
      for (const agent of agents) {
        try {
          const current = await this.workspaces.ensureCanonicalForProviderTransition(
            agent,
          );
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
          canonicalErrors.set(
            agent.id,
            "Canonical State reconciliation failed: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    } else {
      for (const agent of agents) {
        canonicalErrors.set(
          agent.id,
          candidateSetRecoveryFailureCount > 0
            ? "Resource Registry transition deferred until every prior-generation Candidate Set recovers"
            : "Resource Registry transition deferred until every prior-generation Promotion recovers",
        );
      }
    }
    if (
      canonicalErrors.size === 0 &&
      promotionRecoveryFailureCount === 0 &&
      candidateSetRecoveryFailureCount === 0
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
          (agent.lastError?.startsWith("Canonical State reconciliation failed:") ||
            agent.lastError?.startsWith("Resource Registry transition deferred"))
        ) {
          agent.status = "ready";
          agent.lastError = null;
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    if (this.configuringAgents.has(id)) {
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
          throw new HttpError(409, "Stop the active run before editing this Agent");
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
    const agent = this.getAgent(id);
    if (this.configuringAgents.has(id)) {
      throw new HttpError(409, "Wait for the Agent configuration update to finish");
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
      const audit: AgentArchiveAudit = {
        schemaVersion: 1,
        agentId: id,
        archivedAt: now(),
        runs: agentRuns.map((run) => ({
          runId: run.id,
          status: run.status,
          candidateSetId: run.candidateSetId,
          disposition: run.transaction?.disposition ?? null,
          promotionReceiptDigest: run.transaction?.promotionReceipt
            ? createHash("sha256")
                .update(stableJson(run.transaction.promotionReceipt))
                .digest("hex")
            : null,
        })),
        candidateSets: agentCandidateSets.map((candidateSet) => {
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
        }),
      };
      const archivedWorkspace = await this.workspaces.archive(agent, audit);
      await this.store.mutate((database) => {
        database.agents = database.agents.filter((item) => item.id !== id);
        database.messages = database.messages.filter((item) => item.agentId !== id);
        database.runs = database.runs.filter((item) => item.agentId !== id);
        database.candidateSets = database.candidateSets.filter(
          (item) => item.agentId !== id,
        );
      });
      return { archivedWorkspace };
    } finally {
      this.configuringAgents.delete(id);
    }
  }

  async updateOutcomeContract(
    id: string,
    input: OutcomeContractInput,
  ): Promise<OutcomeContract> {
    const current = this.getAgent(id);
    if (current.status === "busy" || this.configuringAgents.has(id)) {
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
        return structuredClone(next);
      });
    } finally {
      this.configuringAgents.delete(id);
    }
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
        throw new HttpError(409, "Start the Agent before exploring competing futures");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "This Agent already has an active operation");
      }
      if (this.configuringAgents.has(agentId)) {
        throw new HttpError(409, "Wait for the Agent configuration update to finish");
      }
      if (
        agent.canonicalStateId !== canonical.stateId ||
        agent.outcomeContract.version !== candidateSet.outcomeContract.version
      ) {
        throw new HttpError(409, "Canonical State changed during Candidate Set admission");
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

  async listExternalEffects(): Promise<MockDeliveryReceipt[]> {
    return this.actionDispatcher.list();
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
      if (this.configuringAgents.has(agentId)) {
        throw new HttpError(409, "Wait for the Agent configuration update to finish");
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
      throw new HttpError(409, "This Quarantine already has an active operation");
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
        throw new HttpError(409, "Only an available Quarantine can start a Repair Run");
      }
      if (!this.runner.canRepairProviderQuarantine(sourceTransaction)) {
        throw new HttpError(
          409,
          "This Quarantine was retained for Resource cleanup and cannot start a Repair Run",
        );
      }
      if (sourceTransaction.lineage.depth >= sourceTransaction.lineage.maxDepth) {
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
        const storedSource = database.runs.find((item) => item.id === sourceRunId);
        const agent = database.agents.find((item) => item.id === source.agentId);
        if (!storedSource?.transaction || !agent) {
          throw new HttpError(404, "Quarantine or Agent not found");
        }
        if (
          storedSource.transaction.disposition !== "quarantined" ||
          !storedSource.transaction.quarantineAvailable
        ) {
          throw new HttpError(409, "Only an available Quarantine can start a Repair Run");
        }
        if (agent.status === "stopped") {
          throw new HttpError(409, "Start the Agent before repairing this Quarantine");
        }
        if (agent.status === "busy") {
          throw new HttpError(409, "This Agent is already running");
        }
        if (this.configuringAgents.has(agent.id)) {
          throw new HttpError(409, "Wait for the Agent configuration update to finish");
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
    if (initial.transaction?.disposition === "discarded") return initial;
    if (this.quarantineOperations.has(runId)) {
      throw new HttpError(409, "This Quarantine already has an active operation");
    }
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
      if (transaction.disposition === "discarded") return run;
      if (transaction.disposition !== "quarantined" || !transaction.quarantineAvailable) {
        throw new HttpError(409, "Only an available Quarantine can be discarded");
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

      let retainedTransaction: RunTransaction = transaction;
      retainedTransaction = await this.runner.discardProviderQuarantines(
        run.agentId,
        retainedTransaction,
        async (progress) => {
          retainedTransaction = structuredClone(progress);
          await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === runId);
            if (storedRun?.transaction) {
              storedRun.transaction = structuredClone(progress);
            }
          });
        },
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (
          storedRun?.transaction &&
          storedRun.transaction.disposition === "quarantined"
        ) {
          storedRun.transaction = structuredClone(retainedTransaction);
        }
      });
      await this.workspaces.discardQuarantine(runId);
      const discardedAt = now();
      return await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (!storedRun?.transaction) {
          throw new HttpError(404, "Quarantine not found");
        }
        if (storedRun.transaction.disposition === "discarded") {
          return structuredClone(storedRun);
        }
        storedRun.transaction = markTransactionDiscarded(
          retainedTransaction,
          discardedAt,
          false,
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
    }
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      demoMode: this.config.demoMode,
      inferenceMode: this.config.demoMode
        ? "deterministic-local-fixture"
        : "modelark",
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
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
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.demoMode
          ? "Deterministic Codex protocol fixture"
          : this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private buildPromotionRecoveryAuthorityContext(
    candidateSets: readonly CandidateSet[],
    runs: readonly AgentRun[],
  ): {
    candidateSetRunIds: Set<string>;
    expectedCandidateSetAuthorities: Map<string, PromotionAuthority>;
    invalidCandidateSets: Map<string, string>;
  } {
    const candidateSetRunIds = new Set(
      runs.filter((run) => run.candidateSetId !== null).map((run) => run.id),
    );
    const expectedCandidateSetAuthorities = new Map<string, PromotionAuthority>();
    const invalidCandidateSets = new Map<string, string>();
    const runsById = new Map(runs.map((run) => [run.id, run]));
    for (const candidateSet of candidateSets) {
      for (const competitor of candidateSet.competitors) {
        candidateSetRunIds.add(competitor.runId);
      }
      try {
        const authority = this.candidateSetPromotionAuthority(
          candidateSet,
          runsById,
        );
        if (authority?.kind === "candidate-set") {
          expectedCandidateSetAuthorities.set(authority.winnerRunId, authority);
        }
      } catch (error) {
        invalidCandidateSets.set(
          candidateSet.id,
          boundedCandidateSetError(error),
        );
      }
    }
    return {
      candidateSetRunIds,
      expectedCandidateSetAuthorities,
      invalidCandidateSets,
    };
  }

  private candidateSetPromotionAuthority(
    candidateSet: CandidateSet,
    runsById = new Map(
      this.store.snapshot().runs.map((run) => [run.id, run]),
    ),
  ): PromotionAuthority | null {
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
          run.transaction.candidateStateId !== competitor.seal.candidateStateId ||
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
          throw new Error("Candidate Set seal contradicts its persisted Run evidence");
        }
      }
    }
    if (!candidateSet.selectionDecision) {
      if (
        candidateSet.selectedCompetitorId !== null ||
        candidateSet.winnerRunId !== null
      ) {
        throw new Error("Candidate Set winner exists without a Selection Decision");
      }
      return null;
    }
    const replayed = this.computeCandidateSetDecision(candidateSet);
    if (stableJson(replayed) !== stableJson(candidateSet.selectionDecision)) {
      throw new Error("Candidate Set Selection Decision failed deterministic replay");
    }
    const selectedId = candidateSet.selectionDecision.winnerCompetitorId;
    if (selectedId === null) {
      if (
        candidateSet.selectedCompetitorId !== null ||
        candidateSet.winnerRunId !== null
      ) {
        throw new Error("No-winner Selection Decision contradicts winner links");
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
      throw new Error("Selection Decision contradicts the persisted winner seal");
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
          await this.normalizeInterruptedCandidateSetEvaluations(candidateSetId);
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
                (competitor) => competitor.id === storedSet.selectedCompetitorId,
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
          await this.failCandidateSetClosed(candidateSetId, "stale", error.message);
          await this.cleanupCandidateSetLosers(candidateSetId, null, false).catch(
            () => undefined,
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
          competitor.status = run.status === "cancelled" ? "cancelled" : "ineligible";
          competitor.exclusions = ["restart-interrupted-evaluation"];
          competitor.error = run.error ? boundedCandidateSetError(run.error) : null;
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
    if (candidateSet.selectionDecision) return;
    const decision = this.computeCandidateSetDecision(candidateSet);
    const decidedAt = now();
    await this.store.mutate((database) => {
      const storedSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      if (!storedSet || storedSet.selectionDecision) return;
      storedSet.selectionDecision = decision;
      storedSet.selectedCompetitorId = decision.winnerCompetitorId;
      storedSet.winnerRunId = decision.winnerCompetitorId
        ? storedSet.competitors.find(
            (competitor) => competitor.id === decision.winnerCompetitorId,
          )?.runId ?? null
        : null;
      storedSet.phase = decision.winnerCompetitorId ? "selected" : "no-winner";
      storedSet.decidedAt = decidedAt;
      storedSet.updatedAt = decidedAt;
      const winner = storedSet.competitors.find(
        (competitor) => competitor.id === decision.winnerCompetitorId,
      );
      if (winner) {
        winner.status = "selected";
        winner.loserDisposition = "winner";
      }
    });
  }

  private computeCandidateSetDecision(candidateSet: CandidateSet) {
    const aggregateTokens = candidateSet.competitors.reduce(
      (total, competitor) =>
        total + (competitor.criterionValues["total-tokens"] ?? 0),
      0,
    );
    const aggregateChangedBytes = candidateSet.competitors.reduce(
      (total, competitor) =>
        total + (competitor.criterionValues["added-bytes"] ?? 0),
      0,
    );
    const aggregateExclusions = [
      ...(aggregateTokens > candidateSet.budget.maxTotalTokens
        ? ["aggregate-budget:total-tokens"]
        : []),
      ...(aggregateChangedBytes > candidateSet.budget.maxTotalChangedBytes
        ? ["aggregate-budget:changed-bytes"]
        : []),
      ...(candidateSet.cancellationRequested
        ? ["candidate-set-cancelled-before-selection"]
        : []),
    ];
    return selectCandidates({
      candidateSetId: candidateSet.id,
      sourceStateId: candidateSet.source.stateId,
      contract: candidateSet.selectionContract,
      candidates: candidateSet.competitors.map((competitor) => {
        const run = this.getRun(competitor.runId);
        return {
          competitorId: competitor.id,
          requiredValidationsPassed:
            Boolean(competitor.seal) &&
            Boolean(run.transaction) &&
            !run.transaction!.validations.some(
              (validation) =>
                validation.required && validation.status !== "passed",
            ),
          exclusions: [...competitor.exclusions, ...aggregateExclusions],
          criterionValues: structuredClone(competitor.criterionValues),
        };
      }),
    });
  }

  private async executeCandidateSet(
    agentAtStart: Agent,
    admitted: CandidateSet,
  ): Promise<void> {
    await this.updateCandidateSetPhase(admitted.id, "evaluating");
    let nextIndex = 0;
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
            await this.markPendingCompetitorCancelled(admitted.id, competitor.id);
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

    try {
      const canonical = await this.workspaces.readCanonical(admitted.agentId);
      if (
        canonical.stateId !== admitted.source.stateId ||
        canonical.contentHash !== admitted.source.contentHash
      ) {
        await this.failCandidateSetClosed(
          admitted.id,
          "stale",
          "Canonical State changed before Candidate Selection",
        );
        await this.cleanupCandidateSetLosers(admitted.id, null, false);
        return;
      }
      await this.updateCandidateSetPhase(admitted.id, "evaluated");
      const evaluated = this.getCandidateSet(admitted.id);
      const decision = this.computeCandidateSetDecision(evaluated);
      const decidedAt = now();
      await this.store.mutate((database) => {
        const candidateSet = database.candidateSets.find(
          (item) => item.id === admitted.id,
        );
        if (!candidateSet || candidateSet.phase !== "evaluated") {
          throw new Error("Candidate Set changed before its decision was persisted");
        }
        candidateSet.selectionDecision = decision;
        candidateSet.selectedCompetitorId = decision.winnerCompetitorId;
        candidateSet.winnerRunId = decision.winnerCompetitorId
          ? candidateSet.competitors.find(
              (competitor) => competitor.id === decision.winnerCompetitorId,
            )?.runId ?? null
          : null;
        candidateSet.phase = decision.winnerCompetitorId
          ? "selected"
          : "no-winner";
        candidateSet.decidedAt = decidedAt;
        candidateSet.updatedAt = decidedAt;
        if (decision.winnerCompetitorId) {
          const winner = candidateSet.competitors.find(
            (competitor) => competitor.id === decision.winnerCompetitorId,
          );
          if (winner) {
            winner.status = "selected";
            winner.loserDisposition = "winner";
          }
        }
      });

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
        await this.failCandidateSetClosed(admitted.id, "stale", error.message);
        await this.cleanupCandidateSetLosers(admitted.id, null, false).catch(
          () => undefined,
        );
        return;
      }
      if (error instanceof AirlockRunError) {
        const safeError = boundedCandidateSetError(error);
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
      const failureMessage = boundedCandidateSetError(error);
      await this.failCandidateSetClosed(
        admitted.id,
        "recovery-error",
        failureMessage,
      );
      try {
        await this.cleanupCandidateSetLosers(admitted.id, null, false);
      } catch (cleanupError) {
        await this.failCandidateSetClosed(
          admitted.id,
          "recovery-error",
          failureMessage +
            "; Candidate cleanup also failed closed: " +
            (cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)),
        );
      }
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
          await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (storedRun) storedRun.transaction = structuredClone(transaction);
          });
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
        result.transaction.canonicalStateIdBefore === candidateSet.source.stateId &&
        result.transaction.canonicalContentHashBefore === candidateSet.source.contentHash &&
        result.transaction.outcomeContractVersion === candidateSet.outcomeContract.version;
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
          competitor.status = result.sealedCandidate ? "eligible" : "ineligible";
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
        : boundedCandidateSetError(error);
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
          if (error instanceof AirlockRunError) run.transaction = error.transaction;
          run.completedAt = completedAt;
        }
        if (storedSet) storedSet.updatedAt = completedAt;
      });
    } finally {
      clearTimeout(durationTimer);
      await durationCancellation;
    }
  }

  private async promoteCandidateSetWinner(candidateSetId: string): Promise<void> {
    const candidateSet = this.getCandidateSet(candidateSetId);
    const authority = this.candidateSetPromotionAuthority(candidateSet);
    const winner = candidateSet.competitors.find(
      (competitor) => competitor.id === candidateSet.selectedCompetitorId,
    );
    if (
      authority?.kind !== "candidate-set" ||
      !winner?.seal ||
      winner.runId !== candidateSet.winnerRunId ||
      authority.winnerRunId !== winner.runId
    ) {
      throw new Error("Candidate Set winner decision has no matching sealed Candidate");
    }
    const run = this.getRun(winner.runId);
    if (!run.transaction || run.output === null) {
      throw new Error("Selected Candidate Run evidence is incomplete");
    }
    await this.updateCandidateSetPhase(candidateSetId, "promoting");
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
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (storedRun) storedRun.transaction = structuredClone(transaction);
        });
      },
    );
    const promotedAt = now();
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
        throw new Error("Selected Candidate Promotion returned no Canonical State");
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
      let run = this.getRun(competitor.runId);
      if (!run.transaction) {
        await this.updateCompetitorDisposition(
          candidateSetId,
          competitor.id,
          "discarded",
          "discarded",
        );
        continue;
      }
      let transaction = run.transaction;
      if (transaction.status === "sealed" && transaction.disposition === null) {
        transaction = await this.runner.disposeSealedCandidate(
          candidateSet.agentId,
          transaction,
          candidateSet.loserPolicy,
          async (progress) => {
            await this.store.mutate((database) => {
              const storedRun = database.runs.find((item) => item.id === run.id);
              if (storedRun) storedRun.transaction = structuredClone(progress);
            });
          },
        );
      } else if (
        candidateSet.loserPolicy === "discard" &&
        transaction.disposition === "quarantined" &&
        transaction.quarantineAvailable
      ) {
        transaction = await this.runner.discardProviderQuarantines(
          candidateSet.agentId,
          transaction,
        );
        await this.workspaces.discardQuarantine(run.id);
        transaction = markTransactionDiscarded(transaction, now(), false);
      }
      const disposition =
        transaction.disposition === "quarantined" ? "retained" : "discarded";
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) storedRun.transaction = structuredClone(transaction);
      });
      await this.updateCompetitorDisposition(
        candidateSetId,
        competitor.id,
        disposition,
        disposition,
      );
    }
    if (updatePhase) {
      const latest = this.getCandidateSet(candidateSetId);
      if (latest.phase !== "cleaning-losers") {
        throw new Error("Candidate Set loser cleanup changed phase unexpectedly");
      }
    }
  }

  private async updateCompetitorDisposition(
    candidateSetId: string,
    competitorId: string,
    status: "retained" | "discarded",
    disposition: "retained" | "discarded",
  ): Promise<void> {
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const competitor = candidateSet?.competitors.find(
        (item) => item.id === competitorId,
      );
      if (competitor) {
        competitor.status = status;
        competitor.loserDisposition = disposition;
      }
      if (candidateSet) candidateSet.updatedAt = now();
    });
  }

  private async markPendingCompetitorCancelled(
    candidateSetId: string,
    competitorId: string,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (item) => item.id === candidateSetId,
      );
      const competitor = candidateSet?.competitors.find(
        (item) => item.id === competitorId,
      );
      const run = database.runs.find((item) => item.id === competitor?.runId);
      if (competitor?.status === "pending") {
        competitor.status = "cancelled";
        competitor.exclusions = ["candidate-set-cancelled"];
        competitor.completedAt = completedAt;
      }
      if (run?.status === "queued") {
        run.status = "cancelled";
        run.error = "Candidate Set was cancelled before this competitor started";
        run.completedAt = completedAt;
        if (run.transaction) {
          run.transaction = markTransactionCancelledBeforeStart(
            run.transaction,
            completedAt,
          );
        }
      }
      if (candidateSet) candidateSet.updatedAt = completedAt;
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
      const allowed: Partial<Record<CandidateSet["phase"], CandidateSet["phase"][]>> = {
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
      const safeError = boundedCandidateSetError(error);
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
        ? this.store
            .snapshot()
            .runs.find((candidate) => candidate.id === repairSourceRunId)
            ?.transaction?.providerResources.flatMap((resource) =>
              resource.quarantine ? [resource.quarantine] : [],
            ) ?? []
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
          await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (storedRun) storedRun.transaction = transaction;
          });
        },
      );
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
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
          agent.lastError = "Run quarantined because a required Validation failed";
        }
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError ||
        (error instanceof AirlockRunError && error.cancelled);
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          if (error instanceof AirlockRunError) {
            storedRun.transaction = error.transaction;
          } else if (cancelled && storedRun.transaction) {
            storedRun.transaction.status = "cancelled";
            storedRun.transaction.disposition = "cancelled";
            storedRun.transaction.canonicalStateIdAfter =
              storedRun.transaction.canonicalStateIdBefore;
            storedRun.transaction.canonicalContentHashAfter =
              storedRun.transaction.canonicalContentHashBefore;
            storedRun.transaction = finalizeResources(
              storedRun.transaction,
              "cancelled",
            );
            storedRun.transaction.events.push({
              status: "cancelled",
              at: completedAt,
              summary: "Run Transaction was cancelled before execution",
            });
            storedRun.transaction.promotionReceipt = createPromotionReceipt(
              storedRun.transaction,
            );
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
    if (!this.providerRegistryReady) {
      throw new HttpError(
        503,
        "Resource Registry transition is incomplete; resolve provider onboarding errors before creating or running Agents",
      );
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
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

function boundedCandidateSetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = redactSensitiveText(message).trim();
  return (safe || "Candidate Set operation failed closed").slice(0, 500);
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
    "sha256:" +
    createHash("sha256").update(stableJson(value)).digest("hex")
  );
}

function buildRepairPrompt(source: AgentRun, objective?: string): string {
  const failedEvidence =
    source.transaction?.validations
      .filter((validation) => validation.required && validation.status !== "passed")
      .map((validation) => {
        const output = validation.output ? "\nEvidence: " + validation.output : "";
        return "- " + validation.name + ": " + validation.summary + output;
      })
      .join("\n") || "- The prior Run did not retain a decisive Validation detail.";
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
      validations: transaction.validations,
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
  if (index < 0) throw new Error("Candidate Set token reservation has no competitor");
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
  if (next.sqlite?.before) next.sqlite.after = structuredClone(next.sqlite.before);
  next = finalizeResources(next, "cancelled");
  next.events.push({
    status: "cancelled",
    at: cancelledAt,
    summary: "Candidate Set cancelled this Run before Runtime execution",
  });
  next.promotionReceipt = createPromotionReceipt(next);
  return next;
}
