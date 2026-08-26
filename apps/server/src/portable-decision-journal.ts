import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "@agent-airlock/transactional-resource-sdk";
import { stableJson } from "./candidate-selection.js";
import type { AgentRun, CandidateSet, RunTransaction } from "./types.js";

const maximumRecordBytes = 2_000_000;
const maximumDecisionRecordsPerRun = 32;
const maximumCandidateSetDecisionRecords = 1;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const temporaryRecordPattern = /^\.authority-[0-9a-f-]{36}\.tmp$/;
const candidateSetDirectoryName = ".candidate-sets";

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

export type PortableCandidateSetAuthority = ReturnType<
  typeof portableCandidateSetAuthorityProjection
>;

export interface CandidateSetDecisionAuthorityRecord {
  schemaVersion: 1;
  authorityDigest: string;
  candidateSetAuthorityDigest: string;
  candidateSetId: string;
  agentId: string;
  decidedAt: string;
  candidateSetAuthority: PortableCandidateSetAuthority;
}

export class PortableDecisionJournal {
  private rootIdentity: { dev: number; ino: number } | null = null;
  private candidateSetRootIdentity: { dev: number; ino: number } | null = null;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stats = await this.assertDirectory(this.root, "root");
    this.rootIdentity = { dev: stats.dev, ino: stats.ino };
    await mkdir(this.candidateSetRoot(), { recursive: true, mode: 0o700 });
    const candidateSetStats = await this.assertDirectory(
      this.candidateSetRoot(),
      "Candidate Set root",
    );
    this.candidateSetRootIdentity = {
      dev: candidateSetStats.dev,
      ino: candidateSetStats.ino,
    };
  }

  async recordCandidateSetDecision(
    candidateSet: CandidateSet,
  ): Promise<CandidateSetDecisionAuthorityRecord> {
    this.assertIdentifier(candidateSet.id, "Candidate Set");
    this.assertIdentifier(candidateSet.agentId, "Agent");
    if (
      !candidateSet.selectionDecision ||
      !candidateSet.decidedAt ||
      candidateSet.selectedCompetitorId !==
        candidateSet.selectionDecision.winnerCompetitorId ||
      (candidateSet.selectionDecision.winnerCompetitorId === null) !==
        (candidateSet.winnerRunId === null) ||
      (candidateSet.selectionDecision.winnerCompetitorId !== null &&
        candidateSet.competitors.find(
          (competitor) =>
            competitor.id ===
            candidateSet.selectionDecision!.winnerCompetitorId,
        )?.runId !== candidateSet.winnerRunId)
    ) {
      throw new Error(
        "Candidate Set decision authority requires one complete Selection Decision",
      );
    }
    const candidateSetAuthority =
      portableCandidateSetAuthorityProjection(candidateSet);
    const candidateSetAuthorityDigest = digest(candidateSetAuthority);
    const unsigned = {
      schemaVersion: 1 as const,
      candidateSetAuthorityDigest,
      candidateSetId: candidateSet.id,
      agentId: candidateSet.agentId,
      decidedAt: candidateSet.decidedAt,
    };
    const record: CandidateSetDecisionAuthorityRecord = {
      ...unsigned,
      authorityDigest: digest(unsigned),
      candidateSetAuthority,
    };
    this.validateCandidateSetRecord(record);
    const directory = this.candidateSetDirectory(candidateSet.id);
    await this.ensureCandidateSetDirectory(directory);
    await this.cleanupTemporaryRecords(directory);
    const target = this.candidateSetRecordPath(
      candidateSet.id,
      record.authorityDigest,
    );
    await this.publishRecord(directory, target, record);
    const records = await this.readCandidateSetDecisionRecords(candidateSet.id);
    if (records.length !== 1) {
      throw new Error("Candidate Set decision authority is ambiguous");
    }
    return structuredClone(record);
  }

  async readCandidateSetDecision(
    candidateSet: CandidateSet,
  ): Promise<CandidateSetDecisionAuthorityRecord> {
    const expected = portableCandidateSetAuthorityProjection(candidateSet);
    const expectedDigest = digest(expected);
    const records = await this.readCandidateSetDecisionRecords(candidateSet.id);
    const record = records.find(
      (item) =>
        item.agentId === candidateSet.agentId &&
        item.candidateSetAuthorityDigest === expectedDigest &&
        stableJson(item.candidateSetAuthority) === stableJson(expected),
    );
    if (!record) {
      throw new Error("Candidate Set decision authority is missing");
    }
    return structuredClone(record);
  }

  async readCandidateSetDecisionById(
    candidateSetId: string,
  ): Promise<CandidateSetDecisionAuthorityRecord | null> {
    const directory = this.candidateSetDirectory(candidateSetId);
    try {
      await this.assertCandidateSetRoot();
      await this.assertDirectory(directory, "Candidate Set");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const records = await this.readCandidateSetDecisionRecords(candidateSetId);
    if (records.length !== 1) {
      throw new Error("Candidate Set decision authority is ambiguous");
    }
    return structuredClone(records[0]!);
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
      throw new Error(
        "Portable decision authority requires a terminal Run decision",
      );
    }
    const parentRunId = transaction.lineage.parentRunId;
    if ((parentRunId === null) !== (parentRun === null)) {
      throw new Error(
        "Portable decision authority has incomplete parent evidence",
      );
    }
    if (
      parentRun &&
      (parentRun.id !== parentRunId ||
        parentRun.agentId !== run.agentId ||
        !parentRun.transaction)
    ) {
      throw new Error(
        "Portable decision authority parent identity is contradictory",
      );
    }
    if (
      candidateSet &&
      (run.candidateSetId !== candidateSet.id ||
        candidateSet.agentId !== run.agentId ||
        !candidateSet.selectionDecision)
    ) {
      throw new Error(
        "Portable decision authority Candidate Set is contradictory",
      );
    }
    if (candidateSet) {
      await this.readCandidateSetDecision(candidateSet);
    }
    const directory = this.runDirectory(run.id);
    await this.ensureRunDirectory(directory);
    await this.cleanupTemporaryRecords(directory);
    const latestAuthority = await this.readUnambiguousTerminalAuthority(
      run.id,
      run.agentId,
    );
    const transactionEvidenceHash =
      portableDecisionTransactionHash(transaction);
    if (
      latestAuthority &&
      latestAuthority.transactionEvidenceHash !== transactionEvidenceHash
    ) {
      assertTerminalAuthorityTransition(
        latestAuthority.transaction,
        transaction,
      );
    }
    const parentAuthority = parentRun?.transaction
      ? await this.readForTransaction(
          parentRun.id,
          parentRun.agentId,
          parentRun.transaction,
        )
      : null;
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
    const target = this.recordPath(run.id, record.authorityDigest);
    const serialized = JSON.stringify(record) + "\n";
    if (
      Buffer.byteLength(serialized, "utf8") > maximumRecordBytes ||
      redactSensitiveText(serialized) !== serialized
    ) {
      throw new Error(
        "Portable decision authority crossed its evidence boundary",
      );
    }
    await this.publishRecord(directory, target, record);
    const publishedAuthority = await this.readUnambiguousTerminalAuthority(
      run.id,
      run.agentId,
    );
    if (
      publishedAuthority?.transactionEvidenceHash !== transactionEvidenceHash
    ) {
      throw new Error(
        "Portable terminal decision authority did not converge on the published decision",
      );
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
    const transactionEvidenceHash =
      portableDecisionTransactionHash(transaction);
    const candidateSetAuthorityDigest = candidateSet
      ? portableCandidateSetAuthorityHash(candidateSet)
      : null;
    const directory = this.runDirectory(runId);
    await this.assertPinnedRoot();
    await this.assertDirectory(directory, "Run");
    await this.cleanupTemporaryRecords(directory);
    const latestAuthority = await this.readUnambiguousTerminalAuthority(
      runId,
      agentId,
    );
    if (
      !latestAuthority ||
      latestAuthority.transactionEvidenceHash !== transactionEvidenceHash
    ) {
      throw new Error(
        "Portable decision authority is not the latest terminal decision",
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > maximumDecisionRecordsPerRun) {
      throw new Error(
        "Portable decision authority exceeds its history boundary",
      );
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
          throw new Error(
            "Portable decision authority hash has contradictory content",
          );
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

  async readUnambiguousTerminalAuthority(
    runId: string,
    agentId: string,
  ): Promise<PortableDecisionAuthorityRecord | null> {
    this.assertIdentifier(runId, "Run");
    this.assertIdentifier(agentId, "Agent");
    const directory = this.runDirectory(runId);
    try {
      await this.assertPinnedRoot();
      await this.assertDirectory(directory, "Run");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    await this.cleanupTemporaryRecords(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > maximumDecisionRecordsPerRun) {
      throw new Error(
        "Portable decision authority exceeds its history boundary",
      );
    }
    const records: PortableDecisionAuthorityRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^sha256-[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error("Portable decision authority filename is unsafe");
      }
      const record = await this.readByDigest(
        runId,
        entry.name.slice(0, -".json".length).replace("sha256-", "sha256:"),
      );
      if (record.agentId !== agentId) {
        throw new Error(
          "Portable decision authority Agent identity is contradictory",
        );
      }
      records.push(record);
    }
    const recordsByTransaction = new Map<
      string,
      PortableDecisionAuthorityRecord[]
    >();
    for (const record of records) {
      const group =
        recordsByTransaction.get(record.transactionEvidenceHash) ?? [];
      group.push(record);
      recordsByTransaction.set(record.transactionEvidenceHash, group);
    }
    if (recordsByTransaction.size === 0) return null;
    if (recordsByTransaction.size === 1) {
      return structuredClone(selectContextRichAuthority(records));
    }
    if (recordsByTransaction.size !== 2) {
      throw new Error("Portable terminal decision authority is ambiguous");
    }
    const groups = [...recordsByTransaction.values()];
    const quarantined = groups.find((group) =>
      group.every((record) => record.disposition === "quarantined"),
    );
    const discarded = groups.find((group) =>
      group.every((record) => record.disposition === "discarded"),
    );
    if (quarantined && discarded) {
      assertQuarantineDiscardTransition(
        quarantined[0]!.transaction,
        discarded[0]!.transaction,
      );
      return structuredClone(selectContextRichAuthority(discarded));
    }
    const unrecoveredPromotion = groups.find((group) =>
      group.every(
        (record) =>
          record.disposition === "promoted" &&
          !record.transaction.recovery.recoveredAfterRestart,
      ),
    );
    const recoveredPromotion = groups.find((group) =>
      group.every(
        (record) =>
          record.disposition === "promoted" &&
          record.transaction.recovery.recoveredAfterRestart,
      ),
    );
    if (unrecoveredPromotion && recoveredPromotion) {
      assertPromotedRecoveryTransition(
        unrecoveredPromotion[0]!.transaction,
        recoveredPromotion[0]!.transaction,
      );
      return structuredClone(selectContextRichAuthority(recoveredPromotion));
    }
    throw new Error("Portable terminal decision authority is ambiguous");
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

  private validateCandidateSetRecord(
    value: unknown,
  ): asserts value is CandidateSetDecisionAuthorityRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Candidate Set decision authority must be an object");
    }
    const record = value as Record<string, unknown>;
    const keys = [
      "schemaVersion",
      "authorityDigest",
      "candidateSetAuthorityDigest",
      "candidateSetId",
      "agentId",
      "decidedAt",
      "candidateSetAuthority",
    ];
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !(key in record)) ||
      record.schemaVersion !== 1 ||
      !digestPattern.test(String(record.authorityDigest)) ||
      !digestPattern.test(String(record.candidateSetAuthorityDigest)) ||
      typeof record.candidateSetId !== "string" ||
      typeof record.agentId !== "string" ||
      !safeIdentifierPattern.test(record.candidateSetId) ||
      !safeIdentifierPattern.test(record.agentId) ||
      typeof record.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(record.decidedAt)) ||
      !record.candidateSetAuthority ||
      typeof record.candidateSetAuthority !== "object" ||
      Array.isArray(record.candidateSetAuthority)
    ) {
      throw new Error("Candidate Set decision authority fields are invalid");
    }
    const candidateSetAuthority = record.candidateSetAuthority as Record<
      string,
      unknown
    >;
    const unsigned = {
      schemaVersion: 1 as const,
      candidateSetAuthorityDigest: record.candidateSetAuthorityDigest,
      candidateSetId: record.candidateSetId,
      agentId: record.agentId,
      decidedAt: record.decidedAt,
    };
    if (
      candidateSetAuthority.id !== record.candidateSetId ||
      candidateSetAuthority.agentId !== record.agentId ||
      candidateSetAuthority.decidedAt !== record.decidedAt ||
      digest(candidateSetAuthority) !== record.candidateSetAuthorityDigest ||
      digest(unsigned) !== record.authorityDigest
    ) {
      throw new Error(
        "Candidate Set decision authority content is contradictory",
      );
    }
  }

  private async readCandidateSetDecisionRecords(
    candidateSetId: string,
  ): Promise<CandidateSetDecisionAuthorityRecord[]> {
    this.assertIdentifier(candidateSetId, "Candidate Set");
    const directory = this.candidateSetDirectory(candidateSetId);
    await this.assertCandidateSetRoot();
    await this.assertDirectory(directory, "Candidate Set");
    await this.cleanupTemporaryRecords(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > maximumCandidateSetDecisionRecords) {
      throw new Error(
        "Candidate Set decision authority exceeds its history boundary",
      );
    }
    const records: CandidateSetDecisionAuthorityRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^sha256-[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error("Candidate Set decision authority filename is unsafe");
      }
      const target = path.join(directory, entry.name);
      const record = JSON.parse(await this.readRecordFile(target)) as unknown;
      this.validateCandidateSetRecord(record);
      records.push(structuredClone(record));
    }
    await this.assertCandidateSetRoot();
    return records;
  }

  private async publishRecord(
    directory: string,
    target: string,
    record:
      PortableDecisionAuthorityRecord | CandidateSetDecisionAuthorityRecord,
  ): Promise<void> {
    const serialized = JSON.stringify(record) + "\n";
    if (
      Buffer.byteLength(serialized, "utf8") > maximumRecordBytes ||
      redactSensitiveText(serialized) !== serialized
    ) {
      throw new Error(
        "Portable decision authority crossed its evidence boundary",
      );
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
        const existing = JSON.parse(
          await this.readRecordFile(target),
        ) as unknown;
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
  }

  private runDirectory(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.root, runId);
  }

  private candidateSetRoot(): string {
    return path.join(this.root, candidateSetDirectoryName);
  }

  private candidateSetDirectory(candidateSetId: string): string {
    this.assertIdentifier(candidateSetId, "Candidate Set");
    return path.join(this.candidateSetRoot(), candidateSetId);
  }

  private candidateSetRecordPath(
    candidateSetId: string,
    authorityDigest: string,
  ): string {
    return path.join(
      this.candidateSetDirectory(candidateSetId),
      authorityDigest.replace("sha256:", "sha256-") + ".json",
    );
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

  private async ensureCandidateSetDirectory(directory: string): Promise<void> {
    await this.assertCandidateSetRoot();
    if (path.dirname(directory) !== path.resolve(this.candidateSetRoot())) {
      throw new Error("Candidate Set decision authority escaped its root");
    }
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.assertDirectory(directory, "Candidate Set");
    await this.assertCandidateSetRoot();
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

  private async assertCandidateSetRoot(): Promise<void> {
    await this.assertPinnedRoot();
    if (!this.candidateSetRootIdentity) {
      throw new Error("Candidate Set decision authority is not initialized");
    }
    const stats = await this.assertDirectory(
      this.candidateSetRoot(),
      "Candidate Set root",
    );
    if (
      stats.dev !== this.candidateSetRootIdentity.dev ||
      stats.ino !== this.candidateSetRootIdentity.ino
    ) {
      throw new Error("Candidate Set decision authority root identity changed");
    }
  }

  private async assertDirectory(
    directory: string,
    label: string,
  ): Promise<Stats> {
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
        throw new Error(
          "Portable decision authority exceeds its byte boundary",
        );
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
  return digest(portableCandidateSetAuthorityProjection(candidateSet));
}

export function portableCandidateSetAuthorityProjection(
  candidateSet: CandidateSet,
) {
  return {
    schemaVersion: candidateSet.schemaVersion,
    id: candidateSet.id,
    agentId: candidateSet.agentId,
    source: candidateSet.source,
    outcomeContract: candidateSet.outcomeContract,
    selectionContract: candidateSet.selectionContract,
    loserPolicy: candidateSet.loserPolicy,
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
  };
}

function selectContextRichAuthority(
  records: PortableDecisionAuthorityRecord[],
): PortableDecisionAuthorityRecord {
  const selected = [...records].sort((left, right) => {
    const leftContext = left.candidateSetAuthorityDigest ? 1 : 0;
    const rightContext = right.candidateSetAuthorityDigest ? 1 : 0;
    return (
      rightContext - leftContext ||
      left.authorityDigest.localeCompare(right.authorityDigest)
    );
  })[0];
  if (!selected) {
    throw new Error("Portable terminal decision authority is missing");
  }
  return selected;
}

function assertTerminalAuthorityTransition(
  previous: RunTransaction,
  next: RunTransaction,
): void {
  if (
    previous.disposition === "quarantined" &&
    next.disposition === "discarded"
  ) {
    assertQuarantineDiscardTransition(previous, next);
    return;
  }
  if (previous.disposition === "promoted" && next.disposition === "promoted") {
    assertPromotedRecoveryTransition(previous, next);
    return;
  }
  throwInvalidTerminalTransition("unsupported disposition sequence");
}

function assertPromotedRecoveryTransition(
  promoted: RunTransaction,
  recovered: RunTransaction,
): void {
  if (
    promoted.status !== "promoted" ||
    promoted.disposition !== "promoted" ||
    promoted.recovery.journalPhase !== "completed" ||
    promoted.recovery.recoveredAfterRestart ||
    promoted.recovery.recoveryError !== null ||
    recovered.status !== "promoted" ||
    recovered.disposition !== "promoted" ||
    recovered.recovery.journalPhase !== "completed" ||
    !recovered.recovery.recoveredAfterRestart ||
    recovered.recovery.recoveryError !== null
  ) {
    throwInvalidTerminalTransition("Promotion recovery state");
  }
  const expected = structuredClone(promoted);
  expected.recovery.recoveredAfterRestart = true;
  if (stableJson(expected) !== stableJson(recovered)) {
    throwInvalidTerminalTransition("Promotion recovery evidence");
  }
}

export function assertQuarantineCleanupProgress(
  authoritative: RunTransaction,
  progress: RunTransaction,
): void {
  if (
    authoritative.status !== "quarantined" ||
    authoritative.disposition !== "quarantined" ||
    !authoritative.quarantineAvailable ||
    !authoritative.quarantinePath ||
    authoritative.discardedAt !== null ||
    progress.status !== "quarantined" ||
    progress.disposition !== "quarantined" ||
    !progress.quarantineAvailable ||
    progress.quarantinePath !== authoritative.quarantinePath ||
    progress.discardedAt !== null ||
    stableJson(progress.events) !== stableJson(authoritative.events) ||
    stableJson(progress.promotionReceipt) !==
      stableJson(authoritative.promotionReceipt)
  ) {
    throwInvalidTerminalTransition("Quarantine cleanup state");
  }
  if (
    progress.providerResourceEvents.length <
      authoritative.providerResourceEvents.length ||
    stableJson(
      progress.providerResourceEvents.slice(
        0,
        authoritative.providerResourceEvents.length,
      ),
    ) !== stableJson(authoritative.providerResourceEvents)
  ) {
    throwInvalidTerminalTransition("Quarantine cleanup event history");
  }
  if (
    stableJson(terminalTransitionCore(authoritative)) !==
    stableJson(terminalTransitionCore(progress))
  ) {
    throwInvalidTerminalTransition("Quarantine cleanup immutable core");
  }
  if (
    stableJson(normalizeResourceEvidence(authoritative.resources)) !==
    stableJson(normalizeResourceEvidence(progress.resources))
  ) {
    throwInvalidTerminalTransition("Quarantine cleanup resource evidence");
  }
  if (
    stableJson(normalizeResourceEvidence(authoritative.providerResources)) !==
    stableJson(normalizeResourceEvidence(progress.providerResources))
  ) {
    throwInvalidTerminalTransition("Quarantine cleanup provider evidence");
  }
}

function assertQuarantineDiscardTransition(
  quarantined: RunTransaction,
  discarded: RunTransaction,
): void {
  const quarantineEvents = quarantined.events;
  const discardEvent = discarded.events.at(-1);
  const providerEventPrefix = discarded.providerResourceEvents.slice(
    0,
    quarantined.providerResourceEvents.length,
  );
  if (
    quarantined.status !== "quarantined" ||
    quarantined.disposition !== "quarantined" ||
    !quarantined.quarantineAvailable ||
    !quarantined.quarantinePath ||
    discarded.status !== "discarded" ||
    discarded.disposition !== "discarded" ||
    discarded.quarantineAvailable ||
    discarded.quarantinePath !== null ||
    !discarded.discardedAt ||
    !Number.isFinite(Date.parse(discarded.discardedAt))
  ) {
    throwInvalidTerminalTransition(
      "state " +
        [
          quarantined.status,
          quarantined.disposition,
          quarantined.quarantineAvailable,
          Boolean(quarantined.quarantinePath),
          discarded.status,
          discarded.disposition,
          discarded.quarantineAvailable,
          discarded.quarantinePath === null,
          Boolean(discarded.discardedAt),
        ].join("/"),
    );
  }
  if (
    discarded.events.length !== quarantineEvents.length + 1 ||
    stableJson(discarded.events.slice(0, quarantineEvents.length)) !==
      stableJson(quarantineEvents) ||
    discardEvent?.status !== "discarded" ||
    discardEvent.at !== discarded.discardedAt
  ) {
    throwInvalidTerminalTransition("event history");
  }
  if (
    discarded.providerResourceEvents.length <
      quarantined.providerResourceEvents.length ||
    stableJson(providerEventPrefix) !==
      stableJson(quarantined.providerResourceEvents)
  ) {
    throwInvalidTerminalTransition("provider event history");
  }
  if (
    stableJson(terminalTransitionCore(quarantined)) !==
    stableJson(terminalTransitionCore(discarded))
  ) {
    throwInvalidTerminalTransition("immutable transaction core");
  }
  if (
    stableJson(normalizeResourceEvidence(quarantined.resources)) !==
    stableJson(normalizeResourceEvidence(discarded.resources))
  ) {
    throwInvalidTerminalTransition("resource evidence");
  }
  if (
    stableJson(normalizeResourceEvidence(quarantined.providerResources)) !==
    stableJson(normalizeResourceEvidence(discarded.providerResources))
  ) {
    throwInvalidTerminalTransition("provider evidence");
  }
}

function normalizeResourceEvidence<
  Resource extends { disposition: unknown; summary: unknown },
>(resources: Resource[]) {
  return resources.map(
    ({ disposition: _disposition, summary: _summary, ...resource }) => resource,
  );
}

function throwInvalidTerminalTransition(reason: string): never {
  throw new Error(
    "Portable terminal decision authority has an invalid lifecycle transition: " +
      reason,
  );
}

function terminalTransitionCore(transaction: RunTransaction) {
  return {
    id: transaction.id,
    assuranceEvidenceVersion: transaction.assuranceEvidenceVersion,
    candidateStateId: transaction.candidateStateId,
    canonicalStateIdBefore: transaction.canonicalStateIdBefore,
    canonicalStateIdAfter: transaction.canonicalStateIdAfter,
    canonicalContentHashBefore: transaction.canonicalContentHashBefore,
    canonicalContentHashAfter: transaction.canonicalContentHashAfter,
    outcomeContractVersion: transaction.outcomeContractVersion,
    outcomeContract: transaction.outcomeContract,
    sqlite: transaction.sqlite,
    externalActions: transaction.externalActions,
    changes: transaction.changes,
    validations: transaction.validations,
    lineage: transaction.lineage,
    recovery: transaction.recovery,
  };
}

function digest(value: unknown): string {
  return (
    "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex")
  );
}
