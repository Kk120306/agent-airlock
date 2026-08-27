import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maximumJournalBytes = 200_000;

export const MAXIMUM_ARCHIVED_RUN_SUMMARIES = 100;
export const MAXIMUM_ARCHIVED_CANDIDATE_SET_SUMMARIES = 50;
export const MAXIMUM_ARCHIVED_PROPOSAL_SUMMARIES = 50;
export const MAXIMUM_ARCHIVED_CONTRACT_VERSION_SUMMARIES = 50;

interface AgentArchiveAuditV1 {
  schemaVersion: 1;
  agentId: string;
  archivedAt: string;
  runs: Array<{
    runId: string;
    status: string;
    candidateSetId: string | null;
    disposition: string | null;
    promotionReceiptDigest: string | null;
  }>;
  candidateSets: Array<{
    candidateSetId: string;
    phase: string;
    winnerRunId: string | null;
    selectionDecisionDigest: string | null;
    winnerSealDigest: string | null;
  }>;
}

interface AgentArchiveAuditV2 {
  schemaVersion: 2;
  agentId: string;
  archivedAt: string;
  runs: AgentArchiveAuditV1["runs"];
  candidateSets: AgentArchiveAuditV1["candidateSets"];
  assuranceProposals: Array<{
    proposalId: string;
    state: string;
    baseContractVersion: number;
    proposalDigest: string;
    decisionAction: string | null;
    decisionDigest: string | null;
    resultingContractVersion: number | null;
  }>;
  outcomeContractVersions: Array<{
    version: number;
    contractHash: string;
    provenance: string;
    sourceProposalId: string | null;
    rollbackFromVersion: number | null;
  }>;
  aggregate: {
    runCount: number;
    candidateSetCount: number;
    assuranceProposalCount: number;
    outcomeContractVersionCount: number;
    evidenceDigest: string;
  };
}

export type AgentArchiveAudit = AgentArchiveAuditV1 | AgentArchiveAuditV2;

export interface AgentDeletionRecord {
  schemaVersion: 1;
  agentId: string;
  phase: "prepared" | "workspace-archived";
  audit: AgentArchiveAudit;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDeletionScan {
  records: AgentDeletionRecord[];
  errors: Array<{ agentId: string | null; message: string }>;
}

export class AgentDeletionJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async begin(
    agentId: string,
    audit: AgentArchiveAudit,
  ): Promise<AgentDeletionRecord> {
    this.assertIdentifier(agentId);
    let result!: AgentDeletionRecord;
    const operation = this.queue.then(async () => {
      const existing = await this.read(agentId).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (JSON.stringify(existing.audit) !== JSON.stringify(audit)) {
          throw new Error("Agent deletion journal contradicts its prepared audit");
        }
        result = existing;
        return;
      }
      const timestamp = new Date().toISOString();
      const record: AgentDeletionRecord = {
        schemaVersion: 1,
        agentId,
        phase: "prepared",
        audit: structuredClone(audit),
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

  async markWorkspaceArchived(agentId: string): Promise<AgentDeletionRecord> {
    let result!: AgentDeletionRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(agentId);
      if (current.phase === "workspace-archived") {
        result = current;
        return;
      }
      const next: AgentDeletionRecord = {
        ...current,
        phase: "workspace-archived",
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

  async complete(agentId: string): Promise<void> {
    this.assertIdentifier(agentId);
    const operation = this.queue.then(async () => {
      await unlink(this.filePath(agentId)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  async read(agentId: string): Promise<AgentDeletionRecord> {
    this.assertIdentifier(agentId);
    const raw = await readFile(this.filePath(agentId), "utf8");
    if (Buffer.byteLength(raw, "utf8") > maximumJournalBytes) {
      throw new Error("Agent deletion journal exceeds 200000 bytes");
    }
    const parsed = JSON.parse(raw) as unknown;
    this.validateRecord(parsed);
    return structuredClone(parsed);
  }

  async scan(): Promise<AgentDeletionScan> {
    await this.queue;
    const records: AgentDeletionRecord[] = [];
    const errors: AgentDeletionScan["errors"] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const agentId = entry.name.slice(0, -5);
      if (!safeIdentifierPattern.test(agentId)) {
        errors.push({ agentId: null, message: "Unsafe Agent deletion filename" });
        continue;
      }
      try {
        records.push(await this.read(agentId));
      } catch (error) {
        errors.push({
          agentId,
          message:
            "Agent deletion journal is corrupt: " +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return { records, errors };
  }

  private async persist(record: AgentDeletionRecord): Promise<void> {
    const destination = this.filePath(record.agentId);
    const temporary = destination + ".tmp";
    const serialized = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > maximumJournalBytes) {
      throw new Error("Agent deletion journal exceeds 200000 bytes");
    }
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  private validateRecord(value: unknown): asserts value is AgentDeletionRecord {
    if (!isRecord(value)) throw new Error("Agent deletion journal must be an object");
    assertExactKeys(
      value,
      [
        "schemaVersion",
        "agentId",
        "phase",
        "audit",
        "createdAt",
        "updatedAt",
      ],
      "Agent deletion journal",
    );
    if (
      value.schemaVersion !== 1 ||
      typeof value.agentId !== "string" ||
      !safeIdentifierPattern.test(value.agentId) ||
      (value.phase !== "prepared" && value.phase !== "workspace-archived") ||
      !isTimestamp(value.createdAt) ||
      !isTimestamp(value.updatedAt)
    ) {
      throw new Error("Agent deletion journal identity or phase is invalid");
    }
    if (!isRecord(value.audit) || value.audit.schemaVersion !== 2) {
      throw new Error("Agent deletion journal requires archive audit schema 2");
    }
    validateArchiveAudit(value.audit, value.agentId);
  }

  private assertIdentifier(agentId: string): void {
    if (!safeIdentifierPattern.test(agentId)) {
      throw new Error("Agent deletion journal Agent identifier is invalid");
    }
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, agentId + ".json");
  }
}

function validateArchiveAudit(value: unknown, agentId: string): void {
  if (!isRecord(value)) throw new Error("Agent archive audit must be an object");
  const schemaVersion = value.schemaVersion;
  assertExactKeys(
    value,
    schemaVersion === 2
      ? [
          "schemaVersion",
          "agentId",
          "archivedAt",
          "runs",
          "candidateSets",
          "assuranceProposals",
          "outcomeContractVersions",
          "aggregate",
        ]
      : ["schemaVersion", "agentId", "archivedAt", "runs", "candidateSets"],
    "Agent archive audit",
  );
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    value.agentId !== agentId ||
    !isTimestamp(value.archivedAt) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 10_000 ||
    !Array.isArray(value.candidateSets) ||
    value.candidateSets.length > 1_000
  ) {
    throw new Error("Agent archive audit identity or bounds are invalid");
  }
  const runIds = new Set<string>();
  for (const run of value.runs) {
    if (!isRecord(run)) throw new Error("Agent archive Run must be an object");
    assertExactKeys(
      run,
      [
        "runId",
        "status",
        "candidateSetId",
        "disposition",
        "promotionReceiptDigest",
      ],
      "Agent archive Run",
    );
    if (
      typeof run.runId !== "string" ||
      !safeIdentifierPattern.test(run.runId) ||
      runIds.has(run.runId) ||
      !isEnum(run.status, ["queued", "running", "completed", "failed", "cancelled"]) ||
      !isNullableIdentifier(run.candidateSetId) ||
      !isNullableEnum(run.disposition, [
        "promoted",
        "quarantined",
        "discarded",
        "cancelled",
      ]) ||
      !isNullableDigest(run.promotionReceiptDigest)
    ) {
      throw new Error("Agent archive Run is invalid");
    }
    runIds.add(run.runId);
  }
  const candidateSetIds = new Set<string>();
  for (const candidateSet of value.candidateSets) {
    if (!isRecord(candidateSet)) {
      throw new Error("Agent archive Candidate Set must be an object");
    }
    assertExactKeys(
      candidateSet,
      [
        "candidateSetId",
        "phase",
        "winnerRunId",
        "selectionDecisionDigest",
        "winnerSealDigest",
      ],
      "Agent archive Candidate Set",
    );
    if (
      typeof candidateSet.candidateSetId !== "string" ||
      !safeIdentifierPattern.test(candidateSet.candidateSetId) ||
      candidateSetIds.has(candidateSet.candidateSetId) ||
      !isEnum(candidateSet.phase, [
        "admitted",
        "evaluating",
        "evaluated",
        "selected",
        "promoting",
        "promoted",
        "cleaning-losers",
        "completed",
        "no-winner",
        "stale",
        "recovery-error",
      ]) ||
      !isNullableIdentifier(candidateSet.winnerRunId) ||
      !isNullableDigest(candidateSet.selectionDecisionDigest) ||
      !isNullableDigest(candidateSet.winnerSealDigest)
    ) {
      throw new Error("Agent archive Candidate Set is invalid");
    }
    candidateSetIds.add(candidateSet.candidateSetId);
  }
  if (schemaVersion !== 2) return;
  if (
    !Array.isArray(value.assuranceProposals) ||
    value.assuranceProposals.length > MAXIMUM_ARCHIVED_PROPOSAL_SUMMARIES ||
    !Array.isArray(value.outcomeContractVersions) ||
    value.outcomeContractVersions.length >
      MAXIMUM_ARCHIVED_CONTRACT_VERSION_SUMMARIES ||
    value.runs.length > MAXIMUM_ARCHIVED_RUN_SUMMARIES ||
    value.candidateSets.length > MAXIMUM_ARCHIVED_CANDIDATE_SET_SUMMARIES ||
    !isRecord(value.aggregate)
  ) {
    throw new Error("Agent archive assurance evidence exceeds its bounds");
  }
  assertExactKeys(
    value.aggregate,
    [
      "runCount",
      "candidateSetCount",
      "assuranceProposalCount",
      "outcomeContractVersionCount",
      "evidenceDigest",
    ],
    "Agent archive aggregate",
  );
  if (
    !isNonNegativeSafeInteger(value.aggregate.runCount) ||
    !isNonNegativeSafeInteger(value.aggregate.candidateSetCount) ||
    !isNonNegativeSafeInteger(value.aggregate.assuranceProposalCount) ||
    !isNonNegativeSafeInteger(value.aggregate.outcomeContractVersionCount) ||
    (value.aggregate.runCount as number) < value.runs.length ||
    (value.aggregate.candidateSetCount as number) < value.candidateSets.length ||
    (value.aggregate.assuranceProposalCount as number) <
      value.assuranceProposals.length ||
    (value.aggregate.outcomeContractVersionCount as number) <
      value.outcomeContractVersions.length ||
    typeof value.aggregate.evidenceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.aggregate.evidenceDigest)
  ) {
    throw new Error("Agent archive aggregate is invalid");
  }
  const proposalIds = new Set<string>();
  for (const proposal of value.assuranceProposals) {
    if (!isRecord(proposal)) {
      throw new Error("Agent archive Assurance Proposal must be an object");
    }
    assertExactKeys(
      proposal,
      [
        "proposalId",
        "state",
        "baseContractVersion",
        "proposalDigest",
        "decisionAction",
        "decisionDigest",
        "resultingContractVersion",
      ],
      "Agent archive Assurance Proposal",
    );
    if (
      typeof proposal.proposalId !== "string" ||
      !digestPattern.test(proposal.proposalId) ||
      proposalIds.has(proposal.proposalId) ||
      !isEnum(proposal.state, [
        "draft",
        "ready",
        "accepted",
        "rejected",
        "superseded",
        "stale",
      ]) ||
      !Number.isSafeInteger(proposal.baseContractVersion) ||
      (proposal.baseContractVersion as number) < 1 ||
      !isRequiredDigest(proposal.proposalDigest) ||
      !isNullableEnum(proposal.decisionAction, ["accepted", "rejected"]) ||
      !isNullableDigest(proposal.decisionDigest) ||
      !isNullablePositiveInteger(proposal.resultingContractVersion) ||
      !hasConsistentProposalDecision(proposal)
    ) {
      throw new Error("Agent archive Assurance Proposal is invalid");
    }
    proposalIds.add(proposal.proposalId);
  }
  const contractVersions = new Set<number>();
  for (const contract of value.outcomeContractVersions) {
    if (!isRecord(contract)) {
      throw new Error("Agent archive Outcome Contract version must be an object");
    }
    assertExactKeys(
      contract,
      [
        "version",
        "contractHash",
        "provenance",
        "sourceProposalId",
        "rollbackFromVersion",
      ],
      "Agent archive Outcome Contract version",
    );
    if (
      !Number.isSafeInteger(contract.version) ||
      (contract.version as number) < 1 ||
      contractVersions.has(contract.version as number) ||
      !isRequiredDigest(contract.contractHash) ||
      !isEnum(contract.provenance, [
        "created",
        "manual",
        "assurance-proposal",
        "rollback",
        "migration",
      ]) ||
      !isNullableBoundedText(contract.sourceProposalId, 128) ||
      !isNullablePositiveInteger(contract.rollbackFromVersion) ||
      !hasConsistentContractProvenance(contract)
    ) {
      throw new Error("Agent archive Outcome Contract version is invalid");
    }
    contractVersions.add(contract.version as number);
  }
}

function hasConsistentProposalDecision(
  proposal: Record<string, unknown>,
): boolean {
  if (proposal.state === "accepted") {
    return (
      proposal.decisionAction === "accepted" &&
      isRequiredDigest(proposal.decisionDigest) &&
      Number.isSafeInteger(proposal.resultingContractVersion) &&
      proposal.resultingContractVersion ===
        (proposal.baseContractVersion as number) + 1
    );
  }
  if (proposal.state === "rejected") {
    return (
      proposal.decisionAction === "rejected" &&
      isRequiredDigest(proposal.decisionDigest) &&
      proposal.resultingContractVersion === null
    );
  }
  return (
    proposal.decisionAction === null &&
    proposal.decisionDigest === null &&
    proposal.resultingContractVersion === null
  );
}

function hasConsistentContractProvenance(
  contract: Record<string, unknown>,
): boolean {
  if (contract.provenance === "assurance-proposal") {
    return (
      typeof contract.sourceProposalId === "string" &&
      digestPattern.test(contract.sourceProposalId) &&
      contract.rollbackFromVersion === null
    );
  }
  if (contract.provenance === "rollback") {
    return (
      contract.sourceProposalId === null &&
      Number.isSafeInteger(contract.rollbackFromVersion) &&
      (contract.rollbackFromVersion as number) >= 1 &&
      (contract.rollbackFromVersion as number) < (contract.version as number)
    );
  }
  return contract.sourceProposalId === null && contract.rollbackFromVersion === null;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(label + " contains unknown or missing fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNullableIdentifier(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && safeIdentifierPattern.test(value))
  );
}

function isNullableBoundedText(
  value: unknown,
  maximumBytes: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes)
  );
}

function isNullableDigest(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      (/^sha256:[a-f0-9]{64}$/.test(value) || digestPattern.test(value)))
  );
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 1);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRequiredDigest(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isEnum(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isNullableEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === null || isEnum(value, allowed);
}
