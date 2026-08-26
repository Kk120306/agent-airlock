import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  AirlockRunError,
  AirlockRunner,
  createPromotionReceipt,
  createRunTransaction,
  finalizeResources,
  type PromotionFaultInjector,
} from "./airlock-runner.js";
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
import { PromotionJournal } from "./promotion-journal.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import { JsonStore } from "./store.js";
import { SqliteResource } from "./sqlite-resource.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CanonicalStateReference,
  CreateAgentInput,
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
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly configuringAgents = new Set<string>();
  private readonly quarantineOperations = new Set<string>();
  private readonly runner: AirlockRunner;
  private readonly actionDispatcher: MockExternalActionDispatcher;
  private readonly promotionJournal: PromotionJournal;
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
    const recoverCompletedRunIds = new Set(
      snapshot.runs
        .filter((run) => run.status !== "completed")
        .map((run) => run.id),
    );
    const recovery = await this.runner.reconcilePromotions(
      recoverCompletedRunIds,
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

    const canonicalStates = new Map<string, CanonicalStateReference>();
    const canonicalErrors = new Map<string, string>();
    if (recovery.failures.length === 0) {
      for (const agent of snapshot.agents) {
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
      for (const agent of snapshot.agents) {
        canonicalErrors.set(
          agent.id,
          "Resource Registry transition deferred until every prior-generation Promotion recovers",
        );
      }
    }
    if (canonicalErrors.size === 0 && recovery.failures.length === 0) {
      await this.workspaces.commitProviderRegistryGeneration(
        registryDescriptors,
        registryGeneration,
      );
      this.providerRegistryReady = true;
    }

    const protectedRunIds = new Set([
      ...recovery.protectedRunIds,
      ...activeRunIds,
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
        if (!run || !agent || run.status === "completed") continue;
        const completedAt = now();
        run.status = "completed";
        run.output = recovered.result.output;
        run.error = null;
        run.usage = recovered.result.usage;
        run.transaction = recovered.transaction;
        run.completedAt = completedAt;
        if (
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
        const canonical = canonicalStates.get(agent.id);
        const recoveryFailure = recovery.failures.find(
          (failure) => failure.agentId === agent.id,
        );
        const corruptJournalFailure = database.runs
          .filter((run) => run.agentId === agent.id)
          .map((run) => recoveryFailures.get(run.id))
          .find((failure) => failure !== undefined);
        const canonicalError = canonicalErrors.get(agent.id);
        if (canonical) {
          agent.canonicalStateId = canonical.stateId;
          agent.workspacePath = canonical.workspacePath;
          agent.codexThreadId = canonical.codexThreadId;
        }
        if (recoveryFailure || corruptJournalFailure || canonicalError) {
          agent.status = "error";
          agent.lastError =
            recoveryFailure?.message ??
            corruptJournalFailure?.message ??
            canonicalError ??
            null;
          agent.updatedAt = now();
        } else if (agent.status === "busy") {
          agent.status = "ready";
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
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
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
