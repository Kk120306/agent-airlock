import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "@agent-airlock/transactional-resource-sdk";
import { stableJson } from "./candidate-selection.js";
import type { AgentRun, CandidateSet, RunTransaction } from "./types.js";

const maximumRecordBytes = 2_000_000;
const maximumDecisionRecordsPerRun = 32;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const temporaryRecordPattern = /^\.authority-[0-9a-f-]{36}\.tmp$/;

export interface PortableDecisionAuthorityRecord {
  schemaVersion: 1;
  authorityDigest: string;
  transactionEvidenceHash: string;
  parentAuthorityDigest: string | null;
  candidateSetAuthorityDigest: string | null;
  runId: string;
  agentId: string;
  disposition: NonNullable<RunTransaction["disposition"]>;
  decidedAt: string;
  transaction: RunTransaction;
}

export class PortableDecisionJournal {
  private rootIdentity: { dev: number; ino: number } | null = null;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stats = await this.assertDirectory(this.root, "root");
    this.rootIdentity = { dev: stats.dev, ino: stats.ino };
  }

  async record(input: {
    run: AgentRun;
    transaction: RunTransaction;
    parentRun: AgentRun | null;
    candidateSet: CandidateSet | null;
  }): Promise<PortableDecisionAuthorityRecord> {
    const { run, transaction, parentRun, candidateSet } = input;
    this.assertIdentifier(run.id, "Run");
    this.assertIdentifier(run.agentId, "Agent");
    if (
      transaction.id !== run.id ||
      !transaction.disposition ||
      !transaction.promotionReceipt ||
      transaction.promotionReceipt.runTransactionId !== run.id ||
      transaction.status !== transaction.disposition ||
      transaction.recovery.recoveryError !== null
    ) {
      throw new Error("Portable decision authority requires a terminal Run decision");
    }
    const parentRunId = transaction.lineage.parentRunId;
    if ((parentRunId === null) !== (parentRun === null)) {
      throw new Error("Portable decision authority has incomplete parent evidence");
    }
    if (
      parentRun &&
      (parentRun.id !== parentRunId ||
        parentRun.agentId !== run.agentId ||
        !parentRun.transaction)
    ) {
      throw new Error("Portable decision authority parent identity is contradictory");
    }
    if (
      candidateSet &&
      (run.candidateSetId !== candidateSet.id ||
        candidateSet.agentId !== run.agentId ||
        !candidateSet.selectionDecision)
    ) {
      throw new Error("Portable decision authority Candidate Set is contradictory");
    }
    const parentAuthority = parentRun?.transaction
      ? await this.readForTransaction(
          parentRun.id,
          parentRun.agentId,
          parentRun.transaction,
        )
      : null;
    const transactionEvidenceHash = portableDecisionTransactionHash(transaction);
    const unsigned = {
      schemaVersion: 1 as const,
      transactionEvidenceHash,
      parentAuthorityDigest: parentAuthority?.authorityDigest ?? null,
      candidateSetAuthorityDigest: candidateSet
        ? portableCandidateSetAuthorityHash(candidateSet)
        : null,
      runId: run.id,
      agentId: run.agentId,
      disposition: transaction.disposition,
      decidedAt: transaction.promotionReceipt.createdAt,
    };
    const record: PortableDecisionAuthorityRecord = {
      ...unsigned,
      authorityDigest: digest(unsigned),
      transaction: structuredClone(transaction),
    };
    this.validateRecord(record);
    const directory = this.runDirectory(run.id);
    await this.ensureRunDirectory(directory);
    await this.cleanupTemporaryRecords(directory);
    const target = this.recordPath(run.id, record.authorityDigest);
    const serialized = JSON.stringify(record) + "\n";
    if (
      Buffer.byteLength(serialized, "utf8") > maximumRecordBytes ||
      redactSensitiveText(serialized) !== serialized
    ) {
      throw new Error("Portable decision authority crossed its evidence boundary");
    }
    const temporary = path.join(directory, `.authority-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.readByDigest(run.id, record.authorityDigest);
        if (stableJson(existing) !== stableJson(record)) {
          throw new Error("Immutable portable decision authority changed");
        }
      }
      await this.syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
      await this.syncDirectory(directory).catch(() => undefined);
    }
    await this.assertPinnedRoot();
    await this.assertDirectory(directory, "Run");
    return structuredClone(record);
  }

  async readForTransaction(
    runId: string,
    agentId: string,
    transaction: RunTransaction,
    candidateSet: CandidateSet | null = null,
  ): Promise<PortableDecisionAuthorityRecord> {
    this.assertIdentifier(runId, "Run");
    this.assertIdentifier(agentId, "Agent");
    const transactionEvidenceHash = portableDecisionTransactionHash(transaction);
    const candidateSetAuthorityDigest = candidateSet
      ? portableCandidateSetAuthorityHash(candidateSet)
      : null;
    const directory = this.runDirectory(runId);
    await this.assertPinnedRoot();
    await this.assertDirectory(directory, "Run");
    await this.cleanupTemporaryRecords(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > maximumDecisionRecordsPerRun) {
      throw new Error("Portable decision authority exceeds its history boundary");
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^sha256-[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error("Portable decision authority filename is unsafe");
      }
      const record = await this.readByDigest(
        runId,
        entry.name.slice(0, -".json".length).replace("sha256-", "sha256:"),
      );
      if (
        record.agentId === agentId &&
        record.transactionEvidenceHash === transactionEvidenceHash &&
        record.candidateSetAuthorityDigest === candidateSetAuthorityDigest
      ) {
        if (stableJson(record.transaction) !== stableJson(transaction)) {
          throw new Error("Portable decision authority hash has contradictory content");
        }
        return record;
      }
    }
    await this.assertPinnedRoot();
    throw new Error("Portable decision authority is missing");
  }

  async readByDigest(
    runId: string,
    authorityDigest: string,
  ): Promise<PortableDecisionAuthorityRecord> {
    this.assertIdentifier(runId, "Run");
    if (!digestPattern.test(authorityDigest)) {
      throw new Error("Portable decision authority digest is invalid");
    }
    await this.assertPinnedRoot();
    await this.assertDirectory(this.runDirectory(runId), "Run");
    const target = this.recordPath(runId, authorityDigest);
    const record = JSON.parse(await this.readRecordFile(target)) as unknown;
    this.validateRecord(record);
    await this.assertPinnedRoot();
    return structuredClone(record);
  }

  private validateRecord(
    value: unknown,
  ): asserts value is PortableDecisionAuthorityRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Portable decision authority must be an object");
    }
    const record = value as Record<string, unknown>;
    const keys = [
      "schemaVersion",
      "authorityDigest",
      "transactionEvidenceHash",
      "parentAuthorityDigest",
      "candidateSetAuthorityDigest",
      "runId",
      "agentId",
      "disposition",
      "decidedAt",
      "transaction",
    ];
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !(key in record)) ||
      record.schemaVersion !== 1 ||
      typeof record.runId !== "string" ||
      typeof record.agentId !== "string" ||
      !safeIdentifierPattern.test(record.runId) ||
      !safeIdentifierPattern.test(record.agentId) ||
      !digestPattern.test(String(record.authorityDigest)) ||
      !digestPattern.test(String(record.transactionEvidenceHash)) ||
      !(
        record.parentAuthorityDigest === null ||
        digestPattern.test(String(record.parentAuthorityDigest))
      ) ||
      !(
        record.candidateSetAuthorityDigest === null ||
        digestPattern.test(String(record.candidateSetAuthorityDigest))
      ) ||
      !["promoted", "quarantined", "discarded", "cancelled"].includes(
        String(record.disposition),
      ) ||
      typeof record.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(record.decidedAt)) ||
      !record.transaction ||
      typeof record.transaction !== "object" ||
      Array.isArray(record.transaction)
    ) {
      throw new Error("Portable decision authority fields are invalid");
    }
    const transaction = record.transaction as RunTransaction;
    const unsigned = {
      schemaVersion: 1 as const,
      transactionEvidenceHash: record.transactionEvidenceHash,
      parentAuthorityDigest: record.parentAuthorityDigest,
      candidateSetAuthorityDigest: record.candidateSetAuthorityDigest,
      runId: record.runId,
      agentId: record.agentId,
      disposition: record.disposition,
      decidedAt: record.decidedAt,
    };
    if (
      transaction.id !== record.runId ||
      transaction.disposition !== record.disposition ||
      transaction.promotionReceipt?.createdAt !== record.decidedAt ||
      portableDecisionTransactionHash(transaction) !==
        record.transactionEvidenceHash ||
      digest(unsigned) !== record.authorityDigest
    ) {
      throw new Error("Portable decision authority content is contradictory");
    }
  }

  private runDirectory(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.root, runId);
  }

  private recordPath(runId: string, authorityDigest: string): string {
    return path.join(
      this.runDirectory(runId),
      authorityDigest.replace("sha256:", "sha256-") + ".json",
    );
  }

  private assertIdentifier(value: string, label: string): void {
    if (!safeIdentifierPattern.test(value)) {
      throw new Error(label + " identifier is not safe");
    }
  }

  private async ensureRunDirectory(directory: string): Promise<void> {
    await this.assertPinnedRoot();
    if (path.dirname(directory) !== path.resolve(this.root)) {
      throw new Error("Portable decision authority Run escaped its root");
    }
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.assertDirectory(directory, "Run");
    await this.assertPinnedRoot();
  }

  private async assertPinnedRoot(): Promise<void> {
    if (!this.rootIdentity) {
      throw new Error("Portable decision authority is not initialized");
    }
    const stats = await this.assertDirectory(this.root, "root");
    if (
      stats.dev !== this.rootIdentity.dev ||
      stats.ino !== this.rootIdentity.ino
    ) {
      throw new Error("Portable decision authority root identity changed");
    }
  }

  private async assertDirectory(directory: string, label: string): Promise<Stats> {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        "Portable decision authority " + label + " must be a regular directory",
      );
    }
    return stats;
  }

  private async cleanupTemporaryRecords(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!temporaryRecordPattern.test(entry.name)) continue;
      const temporary = path.join(directory, entry.name);
      const stats = await lstat(temporary);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Portable decision authority temporary path is unsafe");
      }
      await unlink(temporary);
      removed = true;
    }
    if (removed) await this.syncDirectory(directory);
  }

  private async readRecordFile(target: string): Promise<string> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("Portable decision authority must be a regular file");
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error("Portable decision authority must be a regular file");
      }
      if (before.size < 1 || before.size > maximumRecordBytes) {
        throw new Error("Portable decision authority exceeds its byte boundary");
      }
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== before.size ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error("Portable decision authority changed while being read");
      }
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function portableDecisionTransactionHash(
  transaction: RunTransaction,
): string {
  return digest(transaction);
}

export function portableCandidateSetAuthorityHash(
  candidateSet: CandidateSet,
): string {
  return digest({
    schemaVersion: candidateSet.schemaVersion,
    id: candidateSet.id,
    agentId: candidateSet.agentId,
    source: candidateSet.source,
    outcomeContract: candidateSet.outcomeContract,
    selectionContract: candidateSet.selectionContract,
    competitors: candidateSet.competitors.map((competitor) => ({
      id: competitor.id,
      runId: competitor.runId,
      executorProfileId: competitor.executorProfileId,
      criterionValues: competitor.criterionValues,
      exclusions: competitor.exclusions,
      evaluationDurationMs: competitor.evaluationDurationMs,
      resultThreadId: competitor.resultThreadId,
      seal: competitor.seal,
    })),
    selectionDecision: candidateSet.selectionDecision,
    selectedCompetitorId: candidateSet.selectedCompetitorId,
    winnerRunId: candidateSet.winnerRunId,
    decidedAt: candidateSet.decidedAt,
  });
}

function digest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex");
}
