import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  parseCanonicalJson,
  sha256Digest,
  type ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import {
  type FederatedAdmissionJournal,
  type FederatedAdmissionRecord,
  type FederatedCandidateAdapter,
  type FederatedCandidatePreparationProvenance,
} from "./federated-admission-journal.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAXIMUM_RECORD_BYTES = 262_144;
const MAXIMUM_REASON_CHARACTERS = 512;

export type FederatedApprovalChoice = "approve" | "deny";
export type FederatedApprovalPhase =
  | "decision-published"
  | "candidate-prepared"
  | "completed";

interface FederatedApprovalDecisionRecordV1 {
  schema: "agent-airlock/federated-approval-decision";
  schemaVersion: 1;
  approvalId: ReceiptDigest;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  pendingRecordDigest: ReceiptDigest;
  localAgentId: string;
  operatorId: string;
  choice: FederatedApprovalChoice;
  reason: string;
  decidedAt: string;
  recordDigest: ReceiptDigest;
}

interface FederatedApprovalDecisionRecordV2 {
  schema: "agent-airlock/federated-approval-decision";
  schemaVersion: 2;
  approvalId: ReceiptDigest;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  pendingRecordDigest: ReceiptDigest;
  decisionContextDigest: ReceiptDigest;
  localAgentId: string;
  operatorId: string;
  choice: FederatedApprovalChoice;
  reason: string;
  decidedAt: string;
  recordDigest: ReceiptDigest;
}

export type FederatedApprovalDecisionRecord =
  | FederatedApprovalDecisionRecordV1
  | FederatedApprovalDecisionRecordV2;

export interface FederatedApprovalPlan {
  schemaVersion: 1;
  approvalId: ReceiptDigest;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  pendingRecordDigest: ReceiptDigest;
  decisionRecordDigest: ReceiptDigest;
  localAgentId: string;
  candidateRunId: string | null;
  candidateStateId: string | null;
  phase: FederatedApprovalPhase;
  createdAt: string;
  updatedAt: string;
}

export interface FederatedApprovalResult {
  approval: FederatedApprovalDecisionRecord;
  plan: FederatedApprovalPlan;
}

export type FederatedApprovalFaultBoundary =
  | "decision-published"
  | "candidate-created"
  | "candidate-recorded"
  | "commit-completed";

export class FederatedApprovalJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.recordRoot(), { recursive: true, mode: 0o700 }),
      mkdir(this.planRoot(), { recursive: true, mode: 0o700 }),
    ]);
    await this.reconcile();
  }

  async begin(input: {
    pending: FederatedAdmissionRecord;
    decisionContextDigest: ReceiptDigest;
    operatorId: string;
    choice: FederatedApprovalChoice;
    reason: string;
    now: string;
  }): Promise<FederatedApprovalResult> {
    assertPendingAdmission(input.pending);
    validateDigest(input.decisionContextDigest, "decision context digest");
    validateIdentifier(input.operatorId, "operator identity");
    validateChoice(input.choice);
    validateReason(input.reason);
    validateTimestamp(input.now, "approval decision time");
    let result!: FederatedApprovalResult;
    const operation = this.queue.then(async () => {
      const approvalId = digestApprovalId(input.pending.admissionId);
      let approval = await this.readRecordOrNull(approvalId);
      if (approval) {
        assertSameDecision(approval, input);
      } else {
        const body: Omit<FederatedApprovalDecisionRecordV2, "recordDigest"> = {
          schema: "agent-airlock/federated-approval-decision",
          schemaVersion: 2,
          approvalId,
          admissionId: input.pending.admissionId,
          importIdentifier: input.pending.importIdentifier,
          pendingRecordDigest: input.pending.recordDigest,
          decisionContextDigest: input.decisionContextDigest,
          localAgentId: input.pending.localAgentId,
          operatorId: input.operatorId,
          choice: input.choice,
          reason: input.reason,
          decidedAt: input.now,
        };
        approval = {
          ...body,
          recordDigest: sha256Digest(canonicalize(body)),
        };
        validateApprovalRecord(approval);
        await publishImmutableJson(this.recordPath(approvalId), approval);
      }
      let plan = await this.readPlanOrNull(approvalId);
      if (!plan) {
        plan = {
          schemaVersion: 1,
          approvalId,
          admissionId: approval.admissionId,
          importIdentifier: approval.importIdentifier,
          pendingRecordDigest: approval.pendingRecordDigest,
          decisionRecordDigest: approval.recordDigest,
          localAgentId: approval.localAgentId,
          candidateRunId:
            approval.choice === "approve"
              ? `federated-${approvalId.slice("sha256:".length, "sha256:".length + 48)}`
              : null,
          candidateStateId: null,
          phase: "decision-published",
          createdAt: approval.decidedAt,
          updatedAt: approval.decidedAt,
        };
        validateApprovalPlan(plan);
        await this.persistPlan(plan);
      } else {
        assertPlanMatchesRecord(plan, approval);
      }
      result = {
        approval: structuredClone(approval),
        plan: structuredClone(plan),
      };
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async readRecordByAdmissionId(
    admissionId: ReceiptDigest,
  ): Promise<FederatedApprovalDecisionRecord | null> {
    return this.readRecordOrNull(digestApprovalId(admissionId));
  }

  async readResultByAdmissionId(
    admissionId: ReceiptDigest,
  ): Promise<FederatedApprovalResult | null> {
    const approval = await this.readRecordByAdmissionId(admissionId);
    if (!approval) return null;
    const plan = await this.readPlan(approval.approvalId);
    assertPlanMatchesRecord(plan, approval);
    return { approval, plan };
  }

  async listRecords(): Promise<FederatedApprovalDecisionRecord[]> {
    const entries = await readdir(this.recordRoot(), { withFileTypes: true });
    const result: FederatedApprovalDecisionRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const approvalId = `sha256:${entry.name.slice(0, -5)}` as ReceiptDigest;
      const record = await this.readRecordOrNull(approvalId);
      if (!record) throw new Error("Federated Approval Decision disappeared");
      result.push(record);
    }
    return result;
  }

  async markCandidatePrepared(
    approvalId: ReceiptDigest,
    candidateStateId: string,
    now: string,
  ): Promise<FederatedApprovalPlan> {
    validateIdentifier(candidateStateId, "Candidate State identity");
    return this.advance(approvalId, "candidate-prepared", candidateStateId, now);
  }

  async complete(
    approvalId: ReceiptDigest,
    now: string,
  ): Promise<FederatedApprovalPlan> {
    return this.advance(approvalId, "completed", null, now);
  }

  private async advance(
    approvalId: ReceiptDigest,
    phase: FederatedApprovalPhase,
    candidateStateId: string | null,
    now: string,
  ): Promise<FederatedApprovalPlan> {
    validateDigest(approvalId, "approval identity");
    validateTimestamp(now, "approval journal time");
    let result!: FederatedApprovalPlan;
    const operation = this.queue.then(async () => {
      const current = await this.readPlan(approvalId);
      const currentIndex = phaseIndex(current.phase);
      const nextIndex = phaseIndex(phase);
      if (currentIndex > nextIndex) {
        result = current;
        return;
      }
      if (currentIndex === nextIndex) {
        if (
          candidateStateId !== null &&
          current.candidateStateId !== candidateStateId
        ) {
          throw new Error(
            "Federated approval journal contradicts Candidate State",
          );
        }
        result = current;
        return;
      }
      const denialCompletesDirectly =
        current.candidateRunId === null &&
        current.phase === "decision-published" &&
        phase === "completed";
      if (nextIndex !== currentIndex + 1 && !denialCompletesDirectly) {
        throw new Error("Federated approval phase transition is not contiguous");
      }
      const next: FederatedApprovalPlan = {
        ...current,
        candidateStateId: candidateStateId ?? current.candidateStateId,
        phase,
        updatedAt: now,
      };
      validateApprovalPlan(next);
      await this.persistPlan(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async reconcile(): Promise<void> {
    const records = await this.listRecords();
    for (const record of records) {
      const plan = await this.readPlanOrNull(record.approvalId);
      if (!plan) {
        const reconstructed: FederatedApprovalPlan = {
          schemaVersion: 1,
          approvalId: record.approvalId,
          admissionId: record.admissionId,
          importIdentifier: record.importIdentifier,
          pendingRecordDigest: record.pendingRecordDigest,
          decisionRecordDigest: record.recordDigest,
          localAgentId: record.localAgentId,
          candidateRunId:
            record.choice === "approve"
              ? `federated-${record.approvalId.slice("sha256:".length, "sha256:".length + 48)}`
              : null,
          candidateStateId: null,
          phase: "decision-published",
          createdAt: record.decidedAt,
          updatedAt: record.decidedAt,
        };
        validateApprovalPlan(reconstructed);
        await this.persistPlan(reconstructed);
      } else {
        assertPlanMatchesRecord(plan, record);
      }
    }
    const plans = await readdir(this.planRoot(), { withFileTypes: true });
    for (const entry of plans) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const approvalId = `sha256:${entry.name.slice(0, -5)}` as ReceiptDigest;
      const plan = await this.readPlan(approvalId);
      const record = await this.readRecordOrNull(approvalId);
      if (!record) {
        throw new Error("Federated approval plan has no immutable decision");
      }
      assertPlanMatchesRecord(plan, record);
    }
  }

  private async readRecordOrNull(
    approvalId: ReceiptDigest,
  ): Promise<FederatedApprovalDecisionRecord | null> {
    validateDigest(approvalId, "approval identity");
    let source: string;
    try {
      source = await readFile(this.recordPath(approvalId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    validateApprovalRecord(parsed);
    if (parsed.approvalId !== approvalId) {
      throw new Error("Federated Approval Decision contradicts its filename");
    }
    return structuredClone(parsed);
  }

  private async readPlan(approvalId: ReceiptDigest): Promise<FederatedApprovalPlan> {
    const plan = await this.readPlanOrNull(approvalId);
    if (!plan) throw new Error("Federated approval plan does not exist");
    return plan;
  }

  private async readPlanOrNull(
    approvalId: ReceiptDigest,
  ): Promise<FederatedApprovalPlan | null> {
    let source: string;
    try {
      source = await readFile(this.planPath(approvalId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    validateApprovalPlan(parsed);
    if (parsed.approvalId !== approvalId) {
      throw new Error("Federated approval plan contradicts its filename");
    }
    return structuredClone(parsed);
  }

  private async persistPlan(plan: FederatedApprovalPlan): Promise<void> {
    validateApprovalPlan(plan);
    const target = this.planPath(plan.approvalId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(canonicalize(plan) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      await syncDirectory(this.planRoot());
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private recordRoot(): string {
    return path.join(this.root, "records");
  }

  private planRoot(): string {
    return path.join(this.root, "plans");
  }

  private recordPath(approvalId: ReceiptDigest): string {
    return path.join(this.recordRoot(), `${approvalId.slice(7)}.json`);
  }

  private planPath(approvalId: ReceiptDigest): string {
    return path.join(this.planRoot(), `${approvalId.slice(7)}.json`);
  }
}

export class FederatedApprovalCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly admissions: FederatedAdmissionJournal,
    private readonly approvals: FederatedApprovalJournal,
    private readonly candidates: FederatedCandidateAdapter,
    private readonly options: {
      now?: () => string;
      injectFault?: (boundary: FederatedApprovalFaultBoundary) => void;
    } = {},
  ) {}

  async decide(input: {
    pending: FederatedAdmissionRecord;
    decisionContextDigest: ReceiptDigest;
    operatorId: string;
    choice: FederatedApprovalChoice;
    reason: string;
  }): Promise<FederatedApprovalResult> {
    let result!: FederatedApprovalResult;
    const operation = this.queue.then(async () => {
      let current = await this.approvals.begin({
        ...input,
        now: this.now(),
      });
      this.options.injectFault?.("decision-published");
      if (current.plan.phase === "completed") {
        result = current;
        return;
      }
      if (current.approval.choice === "deny") {
        current.plan = await this.approvals.complete(
          current.approval.approvalId,
          this.now(),
        );
        this.options.injectFault?.("commit-completed");
        result = current;
        return;
      }
      if (!current.plan.candidateRunId) {
        throw new Error("Approved federated transfer has no Candidate Run identity");
      }
      if (current.plan.phase === "decision-published") {
        const bundle = await this.admissions.readPendingBundle(input.pending);
        if (!bundle) {
          throw new Error(
            "Approval-pending Federated Work Bundle is not durably staged",
          );
        }
        const provenance: FederatedCandidatePreparationProvenance = {
          schemaVersion: 1,
          admissionId: input.pending.admissionId,
          importIdentifier: input.pending.importIdentifier,
          producerId: input.pending.producerId,
          receiptDigest: input.pending.decision.receiptDigest,
          artifactDigest: input.pending.decision.artifactDigest,
          policyId: input.pending.decision.policyId,
          policyGeneration: input.pending.decision.policyGeneration,
          policyDigest: input.pending.decision.policyDigest,
        };
        let candidate = await this.candidates.inspect({
          agentId: input.pending.localAgentId,
          runId: current.plan.candidateRunId,
          provenance,
        });
        if (!candidate) {
          candidate = await this.candidates.prepare({
            agentId: input.pending.localAgentId,
            runId: current.plan.candidateRunId,
            bundle,
            provenance,
          });
          this.options.injectFault?.("candidate-created");
        }
        current.plan = await this.approvals.markCandidatePrepared(
          current.approval.approvalId,
          candidate.candidateStateId,
          this.now(),
        );
        this.options.injectFault?.("candidate-recorded");
      }
      current.plan = await this.approvals.complete(
        current.approval.approvalId,
        this.now(),
      );
      this.options.injectFault?.("commit-completed");
      result = current;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function digestApprovalId(admissionId: ReceiptDigest): ReceiptDigest {
  validateDigest(admissionId, "admission identity");
  return sha256Digest(
    `agent-airlock/federated-approval-id/v1\n${admissionId}`,
  );
}

function assertPendingAdmission(record: FederatedAdmissionRecord): void {
  if (
    record.decision.decision !== "pending" ||
    record.decision.reason !== "approval-required" ||
    record.candidateRunId !== null
  ) {
    throw new Error("Federated Admission is not awaiting local approval");
  }
  validateDigest(record.admissionId, "admission identity");
  validateDigest(record.importIdentifier, "import identity");
  validateDigest(record.recordDigest, "pending Admission Record digest");
  validateIdentifier(record.localAgentId, "local Agent identity");
}

function assertSameDecision(
  existing: FederatedApprovalDecisionRecord,
  input: {
    pending: FederatedAdmissionRecord;
    decisionContextDigest: ReceiptDigest;
    operatorId: string;
    choice: FederatedApprovalChoice;
    reason: string;
  },
): void {
  if (
    existing.admissionId !== input.pending.admissionId ||
    existing.importIdentifier !== input.pending.importIdentifier ||
    existing.pendingRecordDigest !== input.pending.recordDigest ||
    existing.localAgentId !== input.pending.localAgentId ||
    existing.operatorId !== input.operatorId ||
    existing.choice !== input.choice ||
    existing.reason !== input.reason
  ) {
    throw new Error(
      "Federated Approval Decision conflicts with the immutable first decision",
    );
  }
  if (
    existing.schemaVersion === 2 &&
    existing.decisionContextDigest !== input.decisionContextDigest
  ) {
    throw new Error(
      "Federated Approval Decision conflicts with the immutable first decision",
    );
  }
}

function assertPlanMatchesRecord(
  plan: FederatedApprovalPlan,
  record: FederatedApprovalDecisionRecord,
): void {
  if (
    plan.approvalId !== record.approvalId ||
    plan.admissionId !== record.admissionId ||
    plan.importIdentifier !== record.importIdentifier ||
    plan.pendingRecordDigest !== record.pendingRecordDigest ||
    plan.decisionRecordDigest !== record.recordDigest ||
    plan.localAgentId !== record.localAgentId ||
    (record.choice === "approve") !== (plan.candidateRunId !== null)
  ) {
    throw new Error(
      "Federated approval plan contradicts its immutable decision",
    );
  }
}

function validateApprovalRecord(
  value: unknown,
): asserts value is FederatedApprovalDecisionRecord {
  const record = asRecord(value, "Federated Approval Decision");
  const commonKeys = [
    "schema",
    "schemaVersion",
    "approvalId",
    "admissionId",
    "importIdentifier",
    "pendingRecordDigest",
    "localAgentId",
    "operatorId",
    "choice",
    "reason",
    "decidedAt",
    "recordDigest",
  ];
  if (record.schemaVersion === 1) {
    assertExactKeys(record, commonKeys);
  } else if (record.schemaVersion === 2) {
    assertExactKeys(record, [
      ...commonKeys.slice(0, 6),
      "decisionContextDigest",
      ...commonKeys.slice(6),
    ]);
  } else {
    throw new Error("Federated Approval Decision protocol is invalid");
  }
  if (
    record.schema !== "agent-airlock/federated-approval-decision" ||
    (record.schemaVersion !== 1 && record.schemaVersion !== 2)
  ) {
    throw new Error("Federated Approval Decision protocol is invalid");
  }
  validateDigest(record.approvalId, "approval identity");
  validateDigest(record.admissionId, "admission identity");
  validateDigest(record.importIdentifier, "import identity");
  validateDigest(record.pendingRecordDigest, "pending record digest");
  if (record.schemaVersion === 2) {
    validateDigest(record.decisionContextDigest, "decision context digest");
  }
  validateDigest(record.recordDigest, "approval record digest");
  validateIdentifier(record.localAgentId, "local Agent identity");
  validateIdentifier(record.operatorId, "operator identity");
  validateChoice(record.choice);
  validateReason(record.reason);
  validateTimestamp(record.decidedAt, "approval decision time");
  if (record.approvalId !== digestApprovalId(record.admissionId)) {
    throw new Error("Federated Approval Decision identity is invalid");
  }
  const body = { ...record } as Record<string, unknown>;
  delete body.recordDigest;
  if (sha256Digest(canonicalize(body)) !== record.recordDigest) {
    throw new Error("Federated Approval Decision digest is invalid");
  }
}

function validateApprovalPlan(
  value: unknown,
): asserts value is FederatedApprovalPlan {
  const plan = asRecord(value, "Federated approval plan");
  assertExactKeys(plan, [
    "schemaVersion",
    "approvalId",
    "admissionId",
    "importIdentifier",
    "pendingRecordDigest",
    "decisionRecordDigest",
    "localAgentId",
    "candidateRunId",
    "candidateStateId",
    "phase",
    "createdAt",
    "updatedAt",
  ]);
  if (
    plan.schemaVersion !== 1 ||
    !["decision-published", "candidate-prepared", "completed"].includes(
      String(plan.phase),
    )
  ) {
    throw new Error("Federated approval plan version or phase is invalid");
  }
  validateDigest(plan.approvalId, "approval identity");
  validateDigest(plan.admissionId, "admission identity");
  validateDigest(plan.importIdentifier, "import identity");
  validateDigest(plan.pendingRecordDigest, "pending record digest");
  validateDigest(plan.decisionRecordDigest, "approval decision digest");
  validateIdentifier(plan.localAgentId, "local Agent identity");
  if (
    !(
      plan.candidateRunId === null ||
      (typeof plan.candidateRunId === "string" &&
        IDENTIFIER_PATTERN.test(plan.candidateRunId))
    ) ||
    !(
      plan.candidateStateId === null ||
      (typeof plan.candidateStateId === "string" &&
        IDENTIFIER_PATTERN.test(plan.candidateStateId))
    )
  ) {
    throw new Error("Federated approval Candidate identity is invalid");
  }
  if (
    plan.candidateRunId === null &&
    plan.candidateStateId !== null
  ) {
    throw new Error("Denied approval plan references Candidate State");
  }
  if (
    plan.candidateRunId !== null &&
    ["candidate-prepared", "completed"].includes(String(plan.phase)) &&
    plan.candidateStateId === null
  ) {
    throw new Error("Approved plan is missing Candidate State");
  }
  if (
    plan.candidateRunId === null &&
    plan.phase === "candidate-prepared"
  ) {
    throw new Error("Denied approval plan cannot prepare Candidate State");
  }
  validateTimestamp(plan.createdAt, "approval plan creation time");
  validateTimestamp(plan.updatedAt, "approval plan update time");
}

function phaseIndex(phase: FederatedApprovalPhase): number {
  return ["decision-published", "candidate-prepared", "completed"].indexOf(
    phase,
  );
}

function validateChoice(value: unknown): asserts value is FederatedApprovalChoice {
  if (value !== "approve" && value !== "deny") {
    throw new Error("Federated approval choice is invalid");
  }
}

function validateReason(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > MAXIMUM_REASON_CHARACTERS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Federated approval reason is invalid");
  }
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Federated ${name} is invalid`);
  }
}

function validateDigest(value: unknown, name: string): asserts value is ReceiptDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Federated ${name} is invalid`);
  }
}

function validateTimestamp(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Federated ${name} is invalid`);
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw new Error("Federated approval record has unknown or missing fields");
  }
}

async function publishImmutableJson(target: string, value: unknown): Promise<void> {
  const source = canonicalize(value) + "\n";
  try {
    const existing = await readFile(target, "utf8");
    if (existing !== source) {
      throw new Error("Immutable federated approval conflicts with existing bytes");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(target), `.publish-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await link(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
