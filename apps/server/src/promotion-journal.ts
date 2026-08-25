import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalStateReference,
  PromotionJournalPhase,
  RunTransaction,
  RunnerResult,
} from "./types.js";
import type { PromotionPlan } from "./workspace.js";

const phaseOrder: PromotionJournalPhase[] = [
  "validated",
  "version-installed",
  "canonical-advanced",
  "effects-delivered",
  "completed",
];
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const recoveryOutput =
  "Agent Airlock recovered this approved Promotion after a server restart. The original Runtime response was not duplicated into the Promotion journal.";

export interface PromotionJournalRecord {
  schemaVersion: 1;
  runId: string;
  agentId: string;
  phase: PromotionJournalPhase;
  plan: PromotionPlan;
  targetCanonical: CanonicalStateReference | null;
  transaction: RunTransaction;
  recoveryResult: RunnerResult;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionJournalScanError {
  runId: string | null;
  message: string;
}

export interface PromotionJournalScan {
  records: PromotionJournalRecord[];
  errors: PromotionJournalScanError[];
}

export class PromotionJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async begin(input: {
    plan: PromotionPlan;
    transaction: RunTransaction;
    result: RunnerResult;
  }): Promise<PromotionJournalRecord> {
    this.assertIdentifier(input.plan.runId, "Run");
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const target = this.filePath(input.plan.runId);
      try {
        await readFile(target, "utf8");
        throw new Error(
          "Promotion journal already exists for Run " + input.plan.runId,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const timestamp = new Date().toISOString();
      const transaction = structuredClone(input.transaction);
      transaction.recovery = {
        journalPhase: "validated",
        recoveredAfterRestart: false,
        recoveryError: null,
      };
      const record: PromotionJournalRecord = {
        schemaVersion: 1,
        runId: input.plan.runId,
        agentId: input.plan.agentId,
        phase: "validated",
        plan: structuredClone(input.plan),
        targetCanonical: null,
        transaction,
        recoveryResult: {
          output: recoveryOutput,
          threadId: input.result.threadId,
          usage: input.result.usage ? structuredClone(input.result.usage) : null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validateRecord(record);
      await this.persist(record);
      result = structuredClone(record);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async advance(
    runId: string,
    phase: PromotionJournalPhase,
    updates: {
      transaction: RunTransaction;
      targetCanonical?: CanonicalStateReference | null;
    },
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const currentIndex = phaseOrder.indexOf(current.phase);
      const nextIndex = phaseOrder.indexOf(phase);
      if (nextIndex === currentIndex) {
        result = structuredClone(current);
        return;
      }
      if (nextIndex !== currentIndex + 1) {
        throw new Error(
          "Promotion journal cannot advance from " + current.phase + " to " + phase,
        );
      }
      const transaction = structuredClone(updates.transaction);
      transaction.recovery = {
        ...transaction.recovery,
        journalPhase: phase,
        recoveryError: null,
      };
      const next: PromotionJournalRecord = {
        ...current,
        phase,
        transaction,
        targetCanonical:
          updates.targetCanonical === undefined
            ? current.targetCanonical
            : updates.targetCanonical
              ? structuredClone(updates.targetCanonical)
              : null,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async recordRecoveryError(
    runId: string,
    transaction: RunTransaction,
    message: string,
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const nextTransaction = structuredClone(transaction);
      nextTransaction.status = "recovery-error";
      nextTransaction.recovery = {
        ...nextTransaction.recovery,
        journalPhase: current.phase,
        recoveredAfterRestart: true,
        recoveryError: message.slice(0, 500),
      };
      const next = {
        ...current,
        transaction: nextTransaction,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async updateTransaction(
    runId: string,
    transaction: RunTransaction,
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const nextTransaction = structuredClone(transaction);
      nextTransaction.recovery.journalPhase = current.phase;
      const next = {
        ...current,
        transaction: nextTransaction,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async read(runId: string): Promise<PromotionJournalRecord> {
    this.assertIdentifier(runId, "Run");
    const parsed = JSON.parse(await readFile(this.filePath(runId), "utf8")) as unknown;
    this.validateRecord(parsed);
    return structuredClone(parsed);
  }

  async scan(): Promise<PromotionJournalScan> {
    await this.queue;
    const records: PromotionJournalRecord[] = [];
    const errors: PromotionJournalScanError[] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -5);
      if (!safeIdentifierPattern.test(runId)) {
        errors.push({ runId: null, message: "Unsafe Promotion journal filename" });
        continue;
      }
      try {
        const record = await this.read(runId);
        records.push(record);
      } catch (error) {
        errors.push({
          runId,
          message:
            "Promotion journal is corrupt: " +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return { records, errors };
  }

  private validateRecord(value: unknown): asserts value is PromotionJournalRecord {
    if (!value || typeof value !== "object") {
      throw new Error("Promotion journal must be an object");
    }
    const record = value as PromotionJournalRecord;
    if (
      record.schemaVersion !== 1 ||
      !safeIdentifierPattern.test(record.runId) ||
      !safeIdentifierPattern.test(record.agentId) ||
      !phaseOrder.includes(record.phase) ||
      !record.plan ||
      record.plan.runId !== record.runId ||
      record.plan.agentId !== record.agentId ||
      !safeIdentifierPattern.test(record.plan.targetStateId) ||
      !safeIdentifierPattern.test(record.plan.sourceStateId) ||
      !record.transaction ||
      record.transaction.id !== record.runId ||
      !record.recoveryResult ||
      record.recoveryResult.output !== recoveryOutput ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error("Promotion journal identity or schema is invalid");
    }
    const phaseIndex = phaseOrder.indexOf(record.phase);
    if (phaseIndex >= 1 && !record.targetCanonical) {
      throw new Error("Installed Promotion journal phase requires target fingerprints");
    }
    if (
      record.targetCanonical &&
      record.targetCanonical.stateId !== record.plan.targetStateId
    ) {
      throw new Error("Promotion journal target does not match its plan");
    }
  }

  private async persist(record: PromotionJournalRecord): Promise<void> {
    const target = this.filePath(record.runId);
    const temporary = target + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  private filePath(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.directory, runId + ".json");
  }

  private assertIdentifier(value: string, label: string): void {
    if (!safeIdentifierPattern.test(value)) {
      throw new Error(label + " identifier is not safe");
    }
  }
}
