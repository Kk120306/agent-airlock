import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  CanonicalStateReference,
  RunTransaction,
  RunTransactionStatus,
  RunnerRequest,
  RunnerResult,
  ValidationEvidence,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface AirlockRunRequest extends RunnerRequest {
  runId: string;
  canonicalStateId: string;
}

export interface AirlockRunResult extends RunnerResult {
  transaction: RunTransaction;
  canonicalState: CanonicalStateReference | null;
}

export type TransactionProgress = (transaction: RunTransaction) => Promise<void>;

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
    outcomeContractVersion: 1,
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
  };
}

export class AirlockRunner {
  private readonly activeAgentIds = new Set<string>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly inner: AgentRunner,
    private readonly workspaces: WorkspaceManager,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async cancel(agentId: string): Promise<boolean> {
    if (!this.activeAgentIds.has(agentId)) return this.inner.cancel(agentId);
    this.cancellationRequests.add(agentId);
    await this.inner.cancel(agentId);
    return true;
  }

  async run(
    request: AirlockRunRequest,
    initialTransaction: RunTransaction,
    onProgress: TransactionProgress,
  ): Promise<AirlockRunResult> {
    let transaction = structuredClone(initialTransaction);
    let candidatePrepared = false;
    this.activeAgentIds.add(request.agentId);
    try {
      const candidate = await this.workspaces.prepareCandidate(
        request.agentId,
        request.runId,
      );
      candidatePrepared = true;
      this.assertNotCancelled(request.agentId);
      if (candidate.canonicalStateIdBefore !== request.canonicalStateId) {
        throw new Error("Agent metadata does not match the current Canonical State");
      }
      transaction.candidateStateId = candidate.candidateStateId;
      transaction = await this.transition(
        transaction,
        "executing",
        "Agent Runtime is executing against Candidate State",
        onProgress,
      );

      const result = await this.inner.run({
        agentId: request.agentId,
        workspacePath: candidate.workspacePath,
        prompt: request.prompt,
        threadId: request.threadId,
      });
      this.assertNotCancelled(request.agentId);

      transaction = await this.transition(
        transaction,
        "validating",
        "Evaluating the Candidate State outcome",
        onProgress,
      );
      const validationStarted = Date.now();
      const hasInstructions = await this.workspaces.candidateHasPath(
        request.runId,
        "AGENTS.md",
      );
      const requiredPathValidation: ValidationEvidence = {
        name: "required-paths",
        status: hasInstructions ? "passed" : "failed",
        summary: hasInstructions
          ? "Required platform instructions remain present"
          : "Required path AGENTS.md is missing",
        durationMs: Date.now() - validationStarted,
        output: null,
      };
      transaction.validations = [requiredPathValidation];

      if (!hasInstructions) {
        transaction.quarantinePath = await this.workspaces.quarantineCandidate(
          request.runId,
        );
        candidatePrepared = false;
        transaction.disposition = "quarantined";
        transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
        transaction.canonicalContentHashAfter =
          transaction.canonicalContentHashBefore;
        transaction = await this.transition(
          transaction,
          "quarantined",
          "Candidate State failed required Validation",
          onProgress,
        );
        return { ...result, transaction, canonicalState: null };
      }

      this.assertNotCancelled(request.agentId);
      transaction = await this.transition(
        transaction,
        "promoting",
        "All required Validations passed",
        onProgress,
      );
      const canonicalState = await this.workspaces.promoteCandidate(
        request.agentId,
        request.runId,
      );
      candidatePrepared = false;
      transaction.disposition = "promoted";
      transaction.canonicalStateIdAfter = canonicalState.stateId;
      transaction.canonicalContentHashAfter = canonicalState.contentHash;
      transaction = this.recordTransition(
        transaction,
        "promoted",
        "Candidate State is now Canonical State",
      );
      return { ...result, transaction, canonicalState };
    } catch (error) {
      const cancelled = error instanceof RunCancelledError;
      if (candidatePrepared) {
        if (cancelled) {
          await this.workspaces.cancelCandidate(request.runId);
        } else {
          transaction.quarantinePath = await this.workspaces.quarantineCandidate(
            request.runId,
          );
        }
      }
      transaction.disposition = cancelled ? "cancelled" : "quarantined";
      transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
      transaction.canonicalContentHashAfter =
        transaction.canonicalContentHashBefore;
      transaction = await this.transition(
        transaction,
        cancelled ? "cancelled" : "quarantined",
        cancelled
          ? "Run Transaction was cancelled before Promotion"
          : "Runtime failed and Candidate State was quarantined",
        onProgress,
      );
      const message = error instanceof Error ? error.message : String(error);
      throw new AirlockRunError(message, transaction, cancelled, error);
    } finally {
      this.activeAgentIds.delete(request.agentId);
      this.cancellationRequests.delete(request.agentId);
    }
  }

  private assertNotCancelled(agentId: string): void {
    if (this.cancellationRequests.has(agentId)) throw new RunCancelledError();
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
