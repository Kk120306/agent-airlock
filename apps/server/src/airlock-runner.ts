import { createHash } from "node:crypto";
import { RunCancelledError } from "./errors.js";
import { OutcomeValidator } from "./outcome-validator.js";
import type {
  AgentRunner,
  CanonicalStateReference,
  OutcomeContract,
  PromotionReceipt,
  RunTransaction,
  RunTransactionStatus,
  RunnerRequest,
  RunnerResult,
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
  outcomeContract: OutcomeContract,
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
    ],
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
    promotionReceipt: null,
  };
}

export class AirlockRunner {
  private readonly activeAgentIds = new Set<string>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly inner: AgentRunner,
    private readonly workspaces: WorkspaceManager,
    private readonly validator: OutcomeValidator,
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
      const candidateWorkspacePath =
        await this.workspaces.candidateWorkspacePath(request.runId);
      const candidateCodexHomePath =
        await this.workspaces.candidateCodexHomePath(request.runId);
      this.assertNotCancelled(request.agentId);
      if (
        candidate.canonicalStateIdBefore !== request.canonicalStateId ||
        candidate.canonicalThreadIdBefore !== request.threadId
      ) {
        throw new Error(
          "Agent metadata does not match the current Canonical State pair",
        );
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
        workspacePath: candidateWorkspacePath,
        codexHomePath: candidateCodexHomePath,
        prompt: request.prompt,
        threadId: candidate.canonicalThreadIdBefore,
      });
      await this.workspaces.recordCandidateThread(request.runId, result.threadId);
      this.assertNotCancelled(request.agentId);

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
      transaction.changes = validationResult.changes;
      transaction.validations = validationResult.validations;
      const failedRequiredValidation = transaction.validations.find(
        (validation) => validation.required && validation.status !== "passed",
      );

      if (failedRequiredValidation) {
        transaction.quarantinePath = await this.workspaces.quarantineCandidate(
          request.runId,
        );
        candidatePrepared = false;
        transaction.disposition = "quarantined";
        transaction.canonicalStateIdAfter = transaction.canonicalStateIdBefore;
        transaction.canonicalContentHashAfter =
          transaction.canonicalContentHashBefore;
        transaction = finalizeResources(transaction, "quarantined");
        transaction.promotionReceipt = createPromotionReceipt(transaction);
        transaction = await this.transition(
          transaction,
          "quarantined",
          "Candidate State failed " + failedRequiredValidation.name,
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
      transaction = finalizeResources(transaction, "promoted", canonicalState);
      transaction.promotionReceipt = createPromotionReceipt(transaction);
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
      transaction = finalizeResources(
        transaction,
        cancelled ? "cancelled" : "quarantined",
      );
      transaction.promotionReceipt = createPromotionReceipt(transaction);
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

export function finalizeResources(
  transaction: RunTransaction,
  disposition: "promoted" | "quarantined" | "cancelled",
  canonicalState?: CanonicalStateReference,
): RunTransaction {
  const next = structuredClone(transaction);
  next.resources = next.resources.map((resource) => {
    const fingerprintAfter =
      disposition === "promoted" && canonicalState
        ? resource.kind === "workspace"
          ? canonicalState.workspaceContentHash
          : canonicalState.sessionContentHash
        : resource.fingerprintBefore;
    return {
      ...resource,
      disposition,
      fingerprintAfter,
      summary:
        disposition === "promoted"
          ? resource.label + " accepted in the new Canonical State"
          : resource.label + " remained on the prior Canonical State",
    };
  });
  return next;
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
    createdAt: now(),
  };
}
