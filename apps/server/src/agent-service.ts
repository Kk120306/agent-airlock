import { randomUUID } from "node:crypto";
import {
  AirlockRunError,
  AirlockRunner,
  createPromotionReceipt,
  createRunTransaction,
  finalizeResources,
} from "./airlock-runner.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  createDefaultOutcomeContract,
  createNextOutcomeContract,
} from "./outcome-contract.js";
import { OutcomeValidator } from "./outcome-validator.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CanonicalStateReference,
  CreateAgentInput,
  Message,
  OutcomeContract,
  OutcomeContractInput,
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
  private readonly runner: AirlockRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    runner: AgentRunner,
    validationCommandExecutor: ValidationCommandExecutor =
      new ContainerValidationCommandExecutor(config),
  ) {
    this.runner = new AirlockRunner(
      runner,
      workspaces,
      new OutcomeValidator(validationCommandExecutor),
    );
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const snapshot = this.store.snapshot();
    const canonicalStates = new Map<string, CanonicalStateReference>();
    for (const agent of snapshot.agents) {
      canonicalStates.set(agent.id, await this.workspaces.ensureCanonical(agent));
    }
    await Promise.all(
      snapshot.runs
        .filter((run) => run.status === "queued" || run.status === "running")
        .map((run) => this.workspaces.cancelCandidate(run.id)),
    );
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          if (run.transaction) {
            run.transaction.status = "cancelled";
            run.transaction.disposition = "cancelled";
            run.transaction.canonicalStateIdAfter =
              run.transaction.canonicalStateIdBefore;
            run.transaction.canonicalContentHashAfter =
              run.transaction.canonicalContentHashBefore;
            run.transaction = finalizeResources(
              run.transaction,
              "cancelled",
            );
            run.transaction.events.push({
              status: "cancelled",
              at: now(),
              summary: "Server restarted while the Run Transaction was active",
            });
            run.transaction.promotionReceipt = createPromotionReceipt(
              run.transaction,
            );
          }
        }
      }
      for (const agent of database.agents) {
        const canonical = canonicalStates.get(agent.id);
        if (!canonical) throw new Error("Canonical State reconciliation failed");
        agent.canonicalStateId = canonical.stateId;
        agent.workspacePath = canonical.workspacePath;
        agent.codexThreadId = canonical.codexThreadId;
        if (agent.status === "busy") {
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
    const timestamp = now();
    const id = randomUUID();
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

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
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
      );
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
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
        this.config.runtimeProvider === "container"
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
      const result = await this.runner.run(
        {
          runId: run.id,
          agentId: agentAtStart.id,
          workspacePath: canonical.workspacePath,
          codexHomePath: canonical.codexHomePath,
          prompt: run.prompt,
          threadId: canonical.codexThreadId,
          canonicalStateId: canonical.stateId,
        },
        run.transaction ??
          createRunTransaction(
            run.id,
            await this.workspaces.readCanonical(agentAtStart.id),
            agentAtStart.outcomeContract,
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
