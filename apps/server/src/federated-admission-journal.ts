import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  parseCanonicalJson,
  sha256Digest,
  type FederatedWorkBundle,
  type ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import {
  evaluateFederatedAdmissionPolicy,
  type FederatedAdmissionEvidenceFacts,
  type FederatedAdmissionPolicyDecision,
  type FederatedAdmissionPolicyStore,
} from "./federated-admission-policy.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAXIMUM_RECORD_BYTES = 262_144;

export type FederatedAdmissionPhase =
  | "planned"
  | "record-published"
  | "candidate-prepared"
  | "completed";

export interface FederatedAdmissionPlan {
  schemaVersion: 1;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  transferId: string;
  attemptDigest: ReceiptDigest;
  evidenceDigest: ReceiptDigest;
  producerId: string;
  localAgentId: string;
  candidateRunId: string | null;
  candidateStateId: string | null;
  phase: FederatedAdmissionPhase;
  decision: FederatedAdmissionPolicyDecision;
  createdAt: string;
  updatedAt: string;
}

export interface FederatedAdmissionRecord {
  schema: "agent-airlock/federated-admission-record";
  schemaVersion: 1;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  transferId: string;
  attemptDigest: ReceiptDigest;
  evidenceDigest: ReceiptDigest;
  producerId: string;
  localAgentId: string;
  candidateRunId: string | null;
  decision: FederatedAdmissionPolicyDecision;
  recordedAt: string;
  recordDigest: ReceiptDigest;
}

interface TransferPointer {
  schemaVersion: 1;
  transferId: string;
  importIdentifier: ReceiptDigest;
}

export type FederatedAdmissionFaultBoundary =
  | "plan-published"
  | "candidate-created"
  | "candidate-recorded"
  | "admission-record-published"
  | "commit-completed";

export interface FederatedCandidateAdapter {
  prepare(input: {
    agentId: string;
    runId: string;
    bundle: FederatedWorkBundle;
    provenance: FederatedCandidatePreparationProvenance;
  }): Promise<{ candidateStateId: string }>;
  inspect(input: {
    agentId: string;
    runId: string;
    provenance: FederatedCandidatePreparationProvenance;
  }): Promise<{ candidateStateId: string } | null>;
}

export interface FederatedCandidatePreparationProvenance {
  schemaVersion: 1;
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  producerId: string;
  receiptDigest: ReceiptDigest;
  artifactDigest: ReceiptDigest;
  policyId: string;
  policyGeneration: number;
  policyDigest: ReceiptDigest;
}

export class FederatedAdmissionJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.planRoot(), { recursive: true, mode: 0o700 }),
      mkdir(this.recordRoot(), { recursive: true, mode: 0o700 }),
      mkdir(this.transferRoot(), { recursive: true, mode: 0o700 }),
    ]);
    await this.reconcileTransferPointers();
  }

  async begin(input: {
    transferId: string;
    producerId: string;
    localAgentId: string;
    importIdentifier: ReceiptDigest;
    attemptDigest: ReceiptDigest;
    evidenceDigest: ReceiptDigest;
    decision: FederatedAdmissionPolicyDecision;
    now: string;
  }): Promise<FederatedAdmissionPlan> {
    validateIdentifier(input.transferId, "transfer identity");
    validateIdentifier(input.producerId, "producer identity");
    validateIdentifier(input.localAgentId, "local Agent identity");
    validateDigest(input.importIdentifier, "import identity");
    validateDigest(input.attemptDigest, "attempt digest");
    validateDigest(input.evidenceDigest, "evidence digest");
    validateTimestamp(input.now, "admission time");
    let result!: FederatedAdmissionPlan;
    const operation = this.queue.then(async () => {
      const transfer = await this.readTransferOrNull(input.transferId);
      if (transfer && transfer.importIdentifier !== input.importIdentifier) {
        throw new Error("Federated transfer identity conflicts with an earlier import");
      }
      const existing = await this.readPlanOrNull(input.importIdentifier);
      if (existing) {
        if (
          existing.transferId !== input.transferId ||
          existing.producerId !== input.producerId ||
          existing.localAgentId !== input.localAgentId ||
          existing.attemptDigest !== input.attemptDigest ||
          existing.evidenceDigest !== input.evidenceDigest
        ) {
          throw new Error("Federated import identity conflicts with an earlier attempt");
        }
        await this.publishTransferPointer({
          schemaVersion: 1,
          transferId: input.transferId,
          importIdentifier: input.importIdentifier,
        });
        result = existing;
        return;
      }
      const admissionId = sha256Digest(
        `agent-airlock/federated-admission-id/v1\n${input.importIdentifier}\n${input.attemptDigest}`,
      );
      const candidateRunId =
        input.decision.decision === "admit"
          ? `federated-${admissionId.slice("sha256:".length, "sha256:".length + 48)}`
          : null;
      const plan: FederatedAdmissionPlan = {
        schemaVersion: 1,
        admissionId,
        importIdentifier: input.importIdentifier,
        transferId: input.transferId,
        attemptDigest: input.attemptDigest,
        evidenceDigest: input.evidenceDigest,
        producerId: input.producerId,
        localAgentId: input.localAgentId,
        candidateRunId,
        candidateStateId: null,
        phase: "planned",
        decision: structuredClone(input.decision),
        createdAt: input.now,
        updatedAt: input.now,
      };
      validatePlan(plan);
      await this.persistPlan(plan);
      await this.publishTransferPointer({
        schemaVersion: 1,
        transferId: input.transferId,
        importIdentifier: input.importIdentifier,
      });
      result = structuredClone(plan);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async readByTransfer(transferId: string): Promise<FederatedAdmissionPlan | null> {
    validateIdentifier(transferId, "transfer identity");
    const pointer = await this.readTransferOrNull(transferId);
    if (!pointer) return null;
    const plan = await this.readPlanOrNull(pointer.importIdentifier);
    if (!plan || plan.transferId !== transferId) {
      throw new Error("Federated transfer pointer has no matching durable plan");
    }
    return plan;
  }

  async markCandidatePrepared(
    importIdentifier: ReceiptDigest,
    candidateStateId: string,
    now: string,
  ): Promise<FederatedAdmissionPlan> {
    validateIdentifier(candidateStateId, "Candidate State identity");
    return this.advance(importIdentifier, "candidate-prepared", now, candidateStateId);
  }

  async markRecordPublished(
    importIdentifier: ReceiptDigest,
    now: string,
  ): Promise<FederatedAdmissionPlan> {
    return this.advance(importIdentifier, "record-published", now, null);
  }

  async complete(
    importIdentifier: ReceiptDigest,
    now: string,
  ): Promise<FederatedAdmissionPlan> {
    return this.advance(importIdentifier, "completed", now, null);
  }

  async publishRecord(plan: FederatedAdmissionPlan, recordedAt: string): Promise<FederatedAdmissionRecord> {
    validatePlan(plan);
    validateTimestamp(recordedAt, "record time");
    if (plan.decision.decision === "admit" && plan.candidateRunId === null) {
      throw new Error("An admitted record requires an authorized Candidate Run identity");
    }
    if (plan.decision.decision !== "admit" && plan.candidateRunId !== null) {
      throw new Error("A non-admitted record cannot reference Candidate State");
    }
    const recordBody: Omit<FederatedAdmissionRecord, "recordDigest"> = {
      schema: "agent-airlock/federated-admission-record",
      schemaVersion: 1,
      admissionId: plan.admissionId,
      importIdentifier: plan.importIdentifier,
      transferId: plan.transferId,
      attemptDigest: plan.attemptDigest,
      evidenceDigest: plan.evidenceDigest,
      producerId: plan.producerId,
      localAgentId: plan.localAgentId,
      candidateRunId: plan.candidateRunId,
      decision: structuredClone(plan.decision),
      recordedAt,
    };
    const record: FederatedAdmissionRecord = {
      ...recordBody,
      recordDigest: sha256Digest(canonicalize(recordBody)),
    };
    validateRecord(record);
    await publishImmutableJson(this.recordPath(record.importIdentifier), record);
    return structuredClone(record);
  }

  async readRecord(importIdentifier: ReceiptDigest): Promise<FederatedAdmissionRecord | null> {
    validateDigest(importIdentifier, "import identity");
    let source: string;
    try {
      source = await readFile(this.recordPath(importIdentifier), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    validateRecord(parsed);
    if (parsed.importIdentifier !== importIdentifier) {
      throw new Error("Federated Admission Record contradicts its filename");
    }
    return structuredClone(parsed);
  }

  async listRecords(): Promise<FederatedAdmissionRecord[]> {
    const entries = await readdir(this.recordRoot(), { withFileTypes: true });
    const records: FederatedAdmissionRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        continue;
      }
      const importIdentifier = `sha256:${entry.name.slice(0, -5)}` as ReceiptDigest;
      const record = await this.readRecord(importIdentifier);
      if (!record) {
        throw new Error("Federated Admission Record disappeared during scan");
      }
      records.push(record);
    }
    return records;
  }

  private async advance(
    importIdentifier: ReceiptDigest,
    phase: FederatedAdmissionPhase,
    now: string,
    candidateStateId: string | null,
  ): Promise<FederatedAdmissionPlan> {
    validateDigest(importIdentifier, "import identity");
    validateTimestamp(now, "journal update time");
    let result!: FederatedAdmissionPlan;
    const operation = this.queue.then(async () => {
      const current = await this.readPlan(importIdentifier);
      const currentIndex = phaseIndex(current.phase);
      const nextIndex = phaseIndex(phase);
      if (currentIndex > nextIndex) {
        result = current;
        return;
      }
      if (currentIndex === nextIndex) {
        if (candidateStateId !== null && current.candidateStateId !== candidateStateId) {
          throw new Error("Federated journal contradicts the prepared Candidate State");
        }
        result = current;
        return;
      }
      const skipsCandidateForNonAdmission =
        current.phase === "record-published" &&
        phase === "completed" &&
        current.decision.decision !== "admit";
      if (nextIndex !== currentIndex + 1 && !skipsCandidateForNonAdmission) {
        throw new Error("Federated admission phase transition is not contiguous");
      }
      const next: FederatedAdmissionPlan = {
        ...current,
        phase,
        candidateStateId: candidateStateId ?? current.candidateStateId,
        updatedAt: now,
      };
      validatePlan(next);
      await this.persistPlan(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async readPlan(importIdentifier: ReceiptDigest): Promise<FederatedAdmissionPlan> {
    const plan = await this.readPlanOrNull(importIdentifier);
    if (!plan) throw new Error("Federated admission plan does not exist");
    return plan;
  }

  private async readPlanOrNull(importIdentifier: ReceiptDigest): Promise<FederatedAdmissionPlan | null> {
    let source: string;
    try {
      source = await readFile(this.planPath(importIdentifier), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    validatePlan(parsed);
    if (parsed.importIdentifier !== importIdentifier) {
      throw new Error("Federated admission plan contradicts its filename");
    }
    return structuredClone(parsed);
  }

  private async readTransferOrNull(transferId: string): Promise<TransferPointer | null> {
    let source: string;
    try {
      source = await readFile(this.transferPath(transferId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    validateTransferPointer(parsed);
    if (parsed.transferId !== transferId) {
      throw new Error("Federated transfer pointer contradicts its lookup identity");
    }
    return parsed;
  }

  private async persistPlan(plan: FederatedAdmissionPlan): Promise<void> {
    const target = this.planPath(plan.importIdentifier);
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

  private async publishTransferPointer(pointer: TransferPointer): Promise<void> {
    validateTransferPointer(pointer);
    await publishImmutableJson(this.transferPath(pointer.transferId), pointer);
  }

  private async reconcileTransferPointers(): Promise<void> {
    const entries = await readdir(this.planRoot(), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const importIdentifier = `sha256:${entry.name.slice(0, -5)}` as ReceiptDigest;
      validateDigest(importIdentifier, "plan filename");
      const plan = await this.readPlan(importIdentifier);
      await this.publishTransferPointer({
        schemaVersion: 1,
        transferId: plan.transferId,
        importIdentifier,
      });
    }
    const pointers = await readdir(this.transferRoot(), { withFileTypes: true });
    for (const entry of pointers) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const source = await readFile(path.join(this.transferRoot(), entry.name), "utf8");
      const pointer = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
      validateTransferPointer(pointer);
      const plan = await this.readPlanOrNull(pointer.importIdentifier);
      if (!plan || plan.transferId !== pointer.transferId) {
        throw new Error("Federated replay ledger contains an orphaned transfer pointer");
      }
    }
  }

  private planRoot(): string { return path.join(this.root, "plans"); }
  private recordRoot(): string { return path.join(this.root, "records"); }
  private transferRoot(): string { return path.join(this.root, "transfers"); }
  private planPath(digest: ReceiptDigest): string { return path.join(this.planRoot(), `${digest.slice(7)}.json`); }
  private recordPath(digest: ReceiptDigest): string { return path.join(this.recordRoot(), `${digest.slice(7)}.json`); }
  private transferPath(transferId: string): string {
    return path.join(this.transferRoot(), `${sha256Digest(`agent-airlock/transfer-id/v1\n${transferId}`).slice(7)}.json`);
  }
}

export class FederatedAdmissionCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly policyStore: FederatedAdmissionPolicyStore,
    private readonly journal: FederatedAdmissionJournal,
    private readonly candidates: FederatedCandidateAdapter,
    private readonly options: {
      now?: () => string;
      injectFault?: (boundary: FederatedAdmissionFaultBoundary) => void;
    } = {},
  ) {}

  async admit(input: {
    transferId: string;
    producerId: string;
    localAgentId: string;
    bundle: FederatedWorkBundle;
    facts: FederatedAdmissionEvidenceFacts;
  }): Promise<FederatedAdmissionRecord> {
    let result!: FederatedAdmissionRecord;
    const operation = this.queue.then(async () => {
      const importIdentifier = digestImport(input.producerId, input.bundle);
      const evidenceDigest = sha256Digest(
        canonicalize({
          schema: "agent-airlock/federated-admission-evidence-facts",
          schemaVersion: 1,
          facts: input.facts,
        }),
      );
      const previous = await this.journal.readByTransfer(input.transferId);
      let plan: FederatedAdmissionPlan;
      if (previous) {
        if (previous.importIdentifier !== importIdentifier) {
          throw new Error("Federated transfer identity conflicts with an earlier import");
        }
        if (
          previous.localAgentId !== input.localAgentId ||
          previous.evidenceDigest !== evidenceDigest
        ) {
          throw new Error("Federated transfer identity conflicts with changed receiver evidence");
        }
        plan = previous;
      } else {
        const active = await this.policyStore.readActive();
        const decision = evaluateFederatedAdmissionPolicy({
          policy: active.policy,
          producerId: input.producerId,
          bundle: input.bundle,
          facts: input.facts,
        });
        const attemptDigest = sha256Digest(
          canonicalize({
            schema: "agent-airlock/federated-admission-attempt",
            schemaVersion: 1,
            transferId: input.transferId,
            localAgentId: input.localAgentId,
            importIdentifier,
            evidenceDigest,
            decision,
          }),
        );
        plan = await this.journal.begin({
          transferId: input.transferId,
          producerId: input.producerId,
          localAgentId: input.localAgentId,
          importIdentifier,
          attemptDigest,
          evidenceDigest,
          decision,
          now: this.now(),
        });
        this.options.injectFault?.("plan-published");
      }
      const existingRecord = await this.journal.readRecord(plan.importIdentifier);
      if (plan.phase === "completed") {
        if (!existingRecord) throw new Error("Completed federated admission has no immutable record");
        result = existingRecord;
        return;
      }
      let record = existingRecord;
      if (plan.phase === "planned") {
        record = record ?? await this.journal.publishRecord(plan, this.now());
        plan = await this.journal.markRecordPublished(plan.importIdentifier, this.now());
        this.options.injectFault?.("admission-record-published");
      }
      if (!record) {
        throw new Error("Federated journal references a missing immutable record");
      }
      if (plan.decision.decision === "admit" && plan.phase === "record-published") {
        if (!plan.candidateRunId) throw new Error("Admitted plan has no Candidate Run identity");
        const provenance: FederatedCandidatePreparationProvenance = {
          schemaVersion: 1,
          admissionId: record.admissionId,
          importIdentifier: record.importIdentifier,
          producerId: record.producerId,
          receiptDigest: record.decision.receiptDigest,
          artifactDigest: record.decision.artifactDigest,
          policyId: record.decision.policyId,
          policyGeneration: record.decision.policyGeneration,
          policyDigest: record.decision.policyDigest,
        };
        let candidate = await this.candidates.inspect({
          agentId: plan.localAgentId,
          runId: plan.candidateRunId,
          provenance,
        });
        if (!candidate) {
          candidate = await this.candidates.prepare({
            agentId: plan.localAgentId,
            runId: plan.candidateRunId,
            bundle: input.bundle,
            provenance,
          });
          this.options.injectFault?.("candidate-created");
        }
        plan = await this.journal.markCandidatePrepared(
          plan.importIdentifier,
          candidate.candidateStateId,
          this.now(),
        );
        this.options.injectFault?.("candidate-recorded");
      }
      result = record;
      await this.journal.complete(plan.importIdentifier, this.now());
      this.options.injectFault?.("commit-completed");
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}

function digestImport(producerId: string, bundle: FederatedWorkBundle): ReceiptDigest {
  validateIdentifier(producerId, "producer identity");
  return sha256Digest(
    canonicalize({
      schema: "agent-airlock/federated-import-identity",
      schemaVersion: 1,
      producerId,
      receiptDigest: bundle.receipt.receiptDigest,
      artifactDigest: bundle.artifact.artifactDigest,
      artifactSchema: bundle.artifact.artifact.protocol.schema,
      artifactSchemaVersion: bundle.artifact.artifact.protocol.schemaVersion,
    }),
  );
}

async function publishImmutableJson(target: string, value: unknown): Promise<void> {
  const source = canonicalize(value) + "\n";
  try {
    const existing = await readFile(target, "utf8");
    if (existing !== source) throw new Error("Immutable federated record conflicts with existing bytes");
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

function validatePlan(value: unknown): asserts value is FederatedAdmissionPlan {
  const plan = asRecord(value, "Federated admission plan");
  assertExactKeys(plan, ["schemaVersion", "admissionId", "importIdentifier", "transferId", "attemptDigest", "evidenceDigest", "producerId", "localAgentId", "candidateRunId", "candidateStateId", "phase", "decision", "createdAt", "updatedAt"]);
  validateDigest(plan.admissionId, "admission identity");
  validateDigest(plan.importIdentifier, "import identity");
  validateDigest(plan.attemptDigest, "attempt digest");
  validateDigest(plan.evidenceDigest, "evidence digest");
  validateIdentifier(plan.transferId, "transfer identity");
  validateIdentifier(plan.producerId, "producer identity");
  validateIdentifier(plan.localAgentId, "local Agent identity");
  if (plan.schemaVersion !== 1 || !["planned", "candidate-prepared", "record-published", "completed"].includes(String(plan.phase))) throw new Error("Federated admission plan version or phase is invalid");
  if (!(plan.candidateRunId === null || typeof plan.candidateRunId === "string" && IDENTIFIER_PATTERN.test(plan.candidateRunId))) throw new Error("Federated Candidate Run identity is invalid");
  if (!(plan.candidateStateId === null || typeof plan.candidateStateId === "string" && IDENTIFIER_PATTERN.test(plan.candidateStateId))) throw new Error("Federated Candidate State identity is invalid");
  validateTimestamp(plan.createdAt, "plan creation time");
  validateTimestamp(plan.updatedAt, "plan update time");
  validateDecision(plan.decision);
  if (plan.decision.decision === "admit") {
    if (
      plan.candidateRunId === null ||
      (["candidate-prepared", "completed"].includes(String(plan.phase)) &&
        plan.candidateStateId === null)
    ) throw new Error("Admitted plan has an invalid Candidate State reference");
  } else if (plan.candidateRunId !== null || plan.candidateStateId !== null) {
    throw new Error("Non-admitted plan references Candidate State");
  }
}

function validateRecord(value: unknown): asserts value is FederatedAdmissionRecord {
  const record = asRecord(value, "Federated Admission Record");
  assertExactKeys(record, ["schema", "schemaVersion", "admissionId", "importIdentifier", "transferId", "attemptDigest", "evidenceDigest", "producerId", "localAgentId", "candidateRunId", "decision", "recordedAt", "recordDigest"]);
  if (record.schema !== "agent-airlock/federated-admission-record" || record.schemaVersion !== 1) throw new Error("Federated Admission Record protocol is invalid");
  validateDigest(record.admissionId, "admission identity");
  validateDigest(record.importIdentifier, "import identity");
  validateDigest(record.attemptDigest, "attempt digest");
  validateDigest(record.evidenceDigest, "evidence digest");
  validateDigest(record.recordDigest, "record digest");
  validateIdentifier(record.transferId, "transfer identity");
  validateIdentifier(record.producerId, "producer identity");
  validateIdentifier(record.localAgentId, "local Agent identity");
  validateTimestamp(record.recordedAt, "record time");
  validateDecision(record.decision);
  if (!(record.candidateRunId === null || typeof record.candidateRunId === "string" && IDENTIFIER_PATTERN.test(record.candidateRunId))) throw new Error("Federated Candidate Run identity is invalid");
  if ((record.decision.decision === "admit") !== (record.candidateRunId !== null)) throw new Error("Federated Admission Record has a contradictory Candidate Run identity");
  const recordBody = { ...record } as Record<string, unknown>;
  delete recordBody.recordDigest;
  if (sha256Digest(canonicalize(recordBody)) !== record.recordDigest) throw new Error("Federated Admission Record digest is invalid");
}

function validateTransferPointer(value: unknown): asserts value is TransferPointer {
  const pointer = asRecord(value, "Federated transfer pointer");
  assertExactKeys(pointer, ["schemaVersion", "transferId", "importIdentifier"]);
  if (pointer.schemaVersion !== 1) throw new Error("Federated transfer pointer version is invalid");
  validateIdentifier(pointer.transferId, "transfer identity");
  validateDigest(pointer.importIdentifier, "import identity");
}

function validateDecision(value: unknown): asserts value is FederatedAdmissionPolicyDecision {
  const decision = asRecord(value, "Federated policy decision");
  assertExactKeys(decision, ["decision", "reason", "policyId", "policyGeneration", "policyDigest", "producerId", "receiptDigest", "artifactDigest", "evaluatedAt", "detail"]);
  if (!["admit", "reject", "pending"].includes(String(decision.decision)) || typeof decision.reason !== "string" || typeof decision.detail !== "string" || !Number.isSafeInteger(decision.policyGeneration) || (decision.policyGeneration as number) < 1) throw new Error("Federated policy decision is invalid");
  validateIdentifier(decision.policyId, "policy identity");
  validateIdentifier(decision.producerId, "producer identity");
  validateDigest(decision.policyDigest, "policy digest");
  validateDigest(decision.receiptDigest, "receipt digest");
  validateDigest(decision.artifactDigest, "artifact digest");
  validateTimestamp(decision.evaluatedAt, "evaluation time");
}

function phaseIndex(phase: FederatedAdmissionPhase): number {
  return ["planned", "record-published", "candidate-prepared", "completed"].indexOf(phase);
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw new Error(`Federated ${name} is invalid`);
}

function validateDigest(value: unknown, name: string): asserts value is ReceiptDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Federated ${name} is invalid`);
}

function validateTimestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Federated ${name} is invalid`);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error("Federated record has unknown or missing fields");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
