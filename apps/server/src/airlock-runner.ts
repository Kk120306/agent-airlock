import { createHash } from "node:crypto";
import {
  EXTERNAL_ACTION_BYPASS_DISCLOSURE,
  ExternalActionOutbox,
  intentEvidence,
  MockExternalActionDispatcher,
  type ParsedExternalActionIntent,
} from "./external-actions.js";
import { RunCancelledError } from "./errors.js";
import { OutcomeValidator } from "./outcome-validator.js";
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
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface AirlockRunRequest extends Omit<RunnerRequest, "outboxPath"> {
  runId: string;
  canonicalStateId: string;
  repairSourceRunId?: string | null;
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
    private readonly sqlite: SqliteResource,
    private readonly actionOutbox: ExternalActionOutbox,
    private readonly actionDispatcher: MockExternalActionDispatcher,
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
    let parsedIntents: ParsedExternalActionIntent[] = [];
    this.activeAgentIds.add(request.agentId);
    try {
      const candidate = request.repairSourceRunId
        ? await this.workspaces.prepareRepairCandidate(
            request.agentId,
            request.repairSourceRunId,
            request.runId,
          )
        : await this.workspaces.prepareCandidate(request.agentId, request.runId);
      candidatePrepared = true;
      const candidateWorkspacePath =
        await this.workspaces.candidateWorkspacePath(request.runId);
      const candidateCodexHomePath =
        await this.workspaces.candidateCodexHomePath(request.runId);
      const candidateOutboxPath =
        await this.workspaces.candidateOutboxPath(request.runId);
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
        outboxPath: candidateOutboxPath,
        repairReferencePath: candidate.repairReferencePath,
        prompt: request.prompt,
        threadId: candidate.runtimeThreadId,
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
      const [sqliteValidation, actionValidation] = await Promise.all([
        this.sqlite.validate(
          candidateWorkspacePath,
          transaction.outcomeContract.secretPatterns,
        ),
        this.actionOutbox.validate(candidateOutboxPath, request.runId),
      ]);
      const repairReferenceValidation =
        await this.workspaces.repairReferenceEvidence(request.runId);
      parsedIntents = actionValidation.intents;
      transaction.changes = validationResult.changes;
      transaction.validations = [
        ...validationResult.validations,
        sqliteValidation.evidence,
        actionValidation.evidence,
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
      transaction.quarantineAvailable = false;
      transaction.canonicalStateIdAfter = canonicalState.stateId;
      transaction.canonicalContentHashAfter = canonicalState.contentHash;
      if (transaction.sqlite) transaction.sqlite.after = sqliteValidation.snapshot;
      let actionFingerprint = externalActionFingerprint([]);
      try {
        const current = await this.workspaces.readCanonical(request.agentId);
        if (current.stateId !== canonicalState.stateId) {
          throw new Error("Canonical State did not advance to the promoted state");
        }
        const receipts = await this.actionDispatcher.dispatch(
          request.runId,
          parsedIntents,
        );
        transaction.externalActions.intents = intentEvidence(
          parsedIntents,
          "deferred",
          receipts,
        );
        transaction.externalActions.deliveredCount = receipts.length;
        actionFingerprint = externalActionFingerprint(receipts);
      } catch {
        transaction.externalActions.intents = intentEvidence(
          parsedIntents,
          "delivery-error",
        );
      }
      transaction = finalizeResources(transaction, "promoted", canonicalState, {
        sqlite: sqliteValidation.snapshot?.contentHash ?? null,
        "external-actions": actionFingerprint,
      });
      const deliveryFailed = transaction.externalActions.intents.some(
        (intent) => intent.status === "delivery-error",
      );
      transaction.resources = transaction.resources.map((resource) =>
        resource.kind === "external-actions" && deliveryFailed
          ? {
              ...resource,
              summary: "Canonical intent awaits delivery recovery",
            }
          : resource,
      );
      transaction.promotionReceipt = createPromotionReceipt(transaction);
      transaction = this.recordTransition(
        transaction,
        "promoted",
        deliveryFailed
          ? "Candidate State is Canonical; external delivery needs recovery"
          : "Candidate State is now Canonical State",
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
          transaction.quarantineAvailable = true;
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
