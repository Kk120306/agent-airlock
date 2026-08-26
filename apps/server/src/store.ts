import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseResourceVersionReference,
  redactSensitiveText,
} from "@agent-airlock/transactional-resource-sdk";
import { SELECTION_CRITERIA, assertSelectionContract, stableJson } from "./candidate-selection.js";
import { validateCandidateSetInput } from "./candidate-set.js";
import { verifyAssuranceProposalIntegrity } from "./assurance.js";
import {
  createDefaultOutcomeContract,
  createLegacyPhaseOneContract,
  validateOutcomeContractInput,
} from "./outcome-contract.js";
import { EXTERNAL_ACTION_BYPASS_DISCLOSURE } from "./external-actions.js";
import { promotionValidationEvidenceHash } from "./promotion-receipt-evidence.js";
import type { Database } from "./types.js";

const candidateIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/;
const candidateSetPhases = new Set([
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
]);
const competitorStatuses = new Set([
  "pending",
  "running",
  "eligible",
  "ineligible",
  "failed",
  "selected",
  "promoted",
  "retained",
  "discarded",
  "cancelled",
]);
const loserDispositions = new Set([
  "pending",
  "retained",
  "discarded",
  "winner",
]);

const emptyDatabase = (): Database => ({
  version: 10,
  agents: [],
  messages: [],
  runs: [],
  candidateSets: [],
  assuranceProposals: [],
  outcomeContractVersions: [],
});

interface VersionOneDatabase {
  version: 1;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionTwoDatabase {
  version: 2;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionThreeDatabase {
  version: 3;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionFourDatabase {
  version: 4;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionFiveDatabase {
  version: 5;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionSixDatabase {
  version: 6;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionSevenDatabase {
  version: 7;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionEightDatabase {
  version: 8;
  agents: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

interface VersionNineDatabase {
  version: 9;
  agents: Database["agents"];
  messages: Database["messages"];
  runs: Database["runs"];
  candidateSets: Database["candidateSets"];
}

function migrateVersionOne(database: VersionOneDatabase): VersionTwoDatabase {
  return {
    version: 2,
    agents: database.agents.map((agent) => ({
      ...agent,
      canonicalStateId: "",
    })),
    messages: database.messages,
    runs: database.runs.map((run) => ({
      ...run,
      transaction: null,
    })),
  };
}

function migrateVersionTwo(database: VersionTwoDatabase): VersionThreeDatabase {
  return {
    version: 3,
    agents: database.agents.map((agent) => ({
      ...agent,
      outcomeContract: createDefaultOutcomeContract(
        2,
        typeof agent.updatedAt === "string" ? agent.updatedAt : undefined,
      ),
    })),
    messages: database.messages,
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      return {
        ...run,
        transaction: transaction
          ? {
              ...transaction,
              outcomeContract: createLegacyPhaseOneContract(
                typeof run.createdAt === "string" ? run.createdAt : undefined,
              ),
              promotionReceipt: null,
              validations: Array.isArray(transaction.validations)
                ? transaction.validations.map((validation) => ({
                    ...(validation as Record<string, unknown>),
                    required: true,
                  }))
                : [],
            }
          : null,
      };
    }),
  };
}

function migrateVersionThree(database: VersionThreeDatabase): VersionFourDatabase {
  return {
    version: 4,
    agents: database.agents as unknown as VersionEightDatabase["agents"],
    messages: database.messages as unknown as VersionEightDatabase["messages"],
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      if (!transaction) return run;
      return {
        ...run,
        transaction: {
          ...transaction,
          resources: [],
        },
      };
    }),
  };
}

function migrateVersionFour(database: VersionFourDatabase): VersionFiveDatabase {
  return {
    version: 5,
    agents: database.agents,
    messages: database.messages,
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      if (!transaction) return run;
      return {
        ...run,
        transaction: {
          ...transaction,
          sqlite: null,
          externalActions: {
            outboxPath: "Candidate State/outbox/intents.jsonl",
            intents: [],
            deliveredCount: 0,
            bypassDisclosure: EXTERNAL_ACTION_BYPASS_DISCLOSURE,
          },
        },
      };
    }),
  };
}

function migrateVersionFive(database: VersionFiveDatabase): VersionSixDatabase {
  return {
    version: 6,
    agents: database.agents,
    messages: database.messages,
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      if (!transaction) return run;
      const runId = typeof run.id === "string" ? run.id : String(transaction.id ?? "");
      const disposition = transaction.disposition;
      return {
        ...run,
        transaction: {
          ...transaction,
          quarantineAvailable:
            disposition === "quarantined" &&
            typeof transaction.quarantinePath === "string",
          discardedAt: null,
          lineage: {
            rootRunId: runId,
            parentRunId: null,
            depth: 0,
            maxDepth: 2,
          },
          promotionReceipt:
            transaction.promotionReceipt &&
            typeof transaction.promotionReceipt === "object"
              ? {
                  ...(transaction.promotionReceipt as Record<string, unknown>),
                  lineage: {
                    rootRunId: runId,
                    parentRunId: null,
                    depth: 0,
                    maxDepth: 2,
                  },
                }
              : null,
        },
      };
    }),
  };
}

function migrateVersionSix(database: VersionSixDatabase): VersionSevenDatabase {
  return {
    version: 7,
    agents: database.agents as unknown as VersionSevenDatabase["agents"],
    messages: database.messages as unknown as VersionSevenDatabase["messages"],
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      if (!transaction) return run;
      return {
        ...run,
        transaction: {
          ...transaction,
          recovery: {
            journalPhase: null,
            recoveredAfterRestart: false,
            recoveryError: null,
          },
        },
      };
    }) as unknown as VersionSevenDatabase["runs"],
  };
}

function migrateVersionSeven(database: VersionSevenDatabase): VersionEightDatabase {
  return {
    version: 8,
    agents: database.agents as unknown as VersionEightDatabase["agents"],
    messages: database.messages as unknown as VersionEightDatabase["messages"],
    runs: database.runs.map((run) => {
      const transaction =
        run.transaction && typeof run.transaction === "object"
          ? (run.transaction as Record<string, unknown>)
          : null;
      if (!transaction) return run;
      return {
        ...run,
        transaction: {
          ...transaction,
          providerResources: [],
          providerResourceEvents: [],
        },
      };
    }) as unknown as VersionEightDatabase["runs"],
  };
}

function migrateVersionEight(database: VersionEightDatabase): VersionNineDatabase {
  return {
    version: 9,
    agents: database.agents as unknown as Database["agents"],
    messages: database.messages as unknown as Database["messages"],
    runs: database.runs.map((run) => ({
      ...run,
      candidateSetId: null,
      competitorId: null,
    })) as unknown as Database["runs"],
    candidateSets: [],
  };
}

function migrateVersionNine(
  database: VersionNineDatabase,
  assuranceEvidenceVersion: 0 | 1,
): Database {
  return {
    version: 10,
    agents: database.agents,
    messages: database.messages,
    runs: database.runs.map((run) => {
      const rawRun = run as unknown as Record<string, unknown>;
      const transaction = isRecord(rawRun.transaction)
        ? { ...rawRun.transaction }
        : rawRun.transaction;
      if (isRecord(transaction)) {
        delete transaction.assuranceEvidenceVersion;
        if (assuranceEvidenceVersion === 1) {
          transaction.assuranceEvidenceVersion = 1;
        }
      }
      return {
        ...rawRun,
        agentId:
          typeof rawRun.agentId === "string" &&
          candidateIdentifierPattern.test(rawRun.agentId)
            ? rawRun.agentId
            : "legacy-unattributed",
        transaction,
      } as unknown as Database["runs"][number];
    }),
    candidateSets: database.candidateSets,
    assuranceProposals: [],
    outcomeContractVersions: database.agents.map((agent) => ({
      schemaVersion: 1,
      agentId: agent.id,
      contract: structuredClone(agent.outcomeContract),
      provenance: "migration",
      sourceProposalId: null,
      rollbackFromVersion: null,
    })),
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as
        | Database
        | VersionOneDatabase
        | VersionTwoDatabase
        | VersionThreeDatabase
        | VersionFourDatabase
        | VersionFiveDatabase
        | VersionSixDatabase
        | VersionSevenDatabase
        | VersionEightDatabase
        | VersionNineDatabase;
      const sourceVersion = parsed.version;
      if (
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.runs) ||
        ((parsed.version === 9 || parsed.version === 10) &&
          !Array.isArray(parsed.candidateSets))
      ) {
        throw new Error("Unsupported database format");
      }
      let versionNine: VersionNineDatabase | null = null;
      if (parsed.version === 1) {
        versionNine = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(
              migrateVersionFour(
                migrateVersionThree(migrateVersionTwo(migrateVersionOne(parsed))),
              ),
            ),
          ),
        ));
      } else if (parsed.version === 2) {
        versionNine = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(
              migrateVersionFour(migrateVersionThree(migrateVersionTwo(parsed))),
            ),
          ),
        ));
      } else if (parsed.version === 3) {
        versionNine = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(migrateVersionFour(migrateVersionThree(parsed))),
          ),
        ));
      } else if (parsed.version === 4) {
        versionNine = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(migrateVersionFive(migrateVersionFour(parsed))),
        ));
      } else if (parsed.version === 5) {
        versionNine = migrateVersionEight(
          migrateVersionSeven(migrateVersionSix(migrateVersionFive(parsed))),
        );
      } else if (parsed.version === 6) {
        versionNine = migrateVersionEight(
          migrateVersionSeven(migrateVersionSix(parsed)),
        );
      } else if (parsed.version === 7) {
        versionNine = migrateVersionEight(migrateVersionSeven(parsed));
      } else if (parsed.version === 8) {
        versionNine = migrateVersionEight(parsed);
      } else if (parsed.version === 9) {
        validateVersionNineDatabase(parsed);
        versionNine = parsed;
      } else if (parsed.version === 10) {
        validateVersionTenDatabase(parsed);
        this.data = parsed;
      } else {
        throw new Error("Unsupported database format");
      }
      if (versionNine) {
        this.data = migrateVersionNine(versionNine, sourceVersion === 9 ? 1 : 0);
        validateVersionTenDatabase(this.data);
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      validateVersionTenDatabase(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function validateVersionTenDatabase(database: Database): void {
  assertExactKeys(
    database,
    [
      "version",
      "agents",
      "messages",
      "runs",
      "candidateSets",
      "assuranceProposals",
      "outcomeContractVersions",
    ],
    "Version 10 database",
  );
  if (
    database.version !== 10 ||
    !Array.isArray(database.assuranceProposals) ||
    !Array.isArray(database.outcomeContractVersions)
  ) {
    throw new Error("Version 10 database aggregates are invalid");
  }
  validateVersionNineDatabase({
    version: 9,
    agents: database.agents,
    messages: database.messages,
    runs: database.runs,
    candidateSets: database.candidateSets,
  });
  const agentIds = new Set<string>();
  for (const rawAgent of database.agents) {
    const agent = rawAgent as unknown as Record<string, unknown>;
    assertExactKeys(
      agent,
      [
        "id",
        "name",
        "description",
        "instructions",
        "status",
        "workspacePath",
        "canonicalStateId",
        "outcomeContract",
        "codexThreadId",
        "lastError",
        "createdAt",
        "updatedAt",
      ],
      "Agent",
    );
    if (
      typeof agent.id !== "string" ||
      !candidateIdentifierPattern.test(agent.id) ||
      agentIds.has(agent.id) ||
      !isRecord(agent.outcomeContract)
    ) {
      throw new Error("Agent identity or Outcome Contract is invalid");
    }
    validatePersistedOutcomeContract(agent.outcomeContract);
    agentIds.add(agent.id);
  }
  for (const rawRun of database.runs) {
    validatePersistedAssuranceRunEvidence(rawRun as unknown as Record<string, unknown>);
  }
  const proposalIds = new Set<string>();
  const proposalsById = new Map<string, Database["assuranceProposals"][number]>();
  for (const rawProposal of database.assuranceProposals) {
    validateAssuranceProposal(rawProposal as unknown as Record<string, unknown>);
    if (
      proposalIds.has(rawProposal.id) ||
      !agentIds.has(rawProposal.agentId)
    ) {
      throw new Error("Assurance Proposal identity or Agent reference is invalid");
    }
    proposalIds.add(rawProposal.id);
    proposalsById.set(rawProposal.id, rawProposal);
  }
  const historyKeys = new Set<string>();
  for (const rawHistory of database.outcomeContractVersions) {
    const history = rawHistory as unknown as Record<string, unknown>;
    assertExactKeys(
      history,
      [
        "schemaVersion",
        "agentId",
        "contract",
        "provenance",
        "sourceProposalId",
        "rollbackFromVersion",
      ],
      "Outcome Contract version record",
    );
    if (
      history.schemaVersion !== 1 ||
      typeof history.agentId !== "string" ||
      !agentIds.has(history.agentId) ||
      !isRecord(history.contract) ||
      ![
        "created",
        "manual",
        "assurance-proposal",
        "rollback",
        "migration",
      ].includes(String(history.provenance)) ||
      !isNullableSafeText(history.sourceProposalId, 128) ||
      !isNullableSafeInteger(history.rollbackFromVersion, 1, 1_000_000)
    ) {
      throw new Error("Outcome Contract version record is invalid");
    }
    validatePersistedOutcomeContract(history.contract);
    const provenance = String(history.provenance);
    if (provenance === "assurance-proposal") {
      const source =
        typeof history.sourceProposalId === "string"
          ? proposalsById.get(history.sourceProposalId)
          : null;
      if (
        !source ||
        source.agentId !== history.agentId ||
        source.state !== "accepted" ||
        source.decision?.action !== "accepted" ||
        source.decision.resultingContractVersion !== history.contract.version ||
        history.rollbackFromVersion !== null
      ) {
        throw new Error("Assurance Proposal contract provenance is invalid");
      }
    } else if (provenance === "rollback") {
      if (
        history.sourceProposalId !== null ||
        !Number.isSafeInteger(history.rollbackFromVersion)
      ) {
        throw new Error("Rollback contract provenance is invalid");
      }
    } else if (
      history.sourceProposalId !== null ||
      history.rollbackFromVersion !== null
    ) {
      throw new Error("Outcome Contract provenance contains unexpected authority");
    }
    const key = history.agentId + ":" + String(history.contract.version);
    if (historyKeys.has(key)) {
      throw new Error("Outcome Contract version history is duplicated");
    }
    historyKeys.add(key);
  }
  for (const agent of database.agents) {
    const current = database.outcomeContractVersions.find(
      (record) =>
        record.agentId === agent.id &&
        record.contract.version === agent.outcomeContract.version,
    );
    if (!current || stableJson(current.contract) !== stableJson(agent.outcomeContract)) {
      throw new Error("Agent current Outcome Contract is missing from version history");
    }
  }
  for (const history of database.outcomeContractVersions) {
    if (history.provenance !== "rollback") continue;
    const target = database.outcomeContractVersions.find(
      (candidate) =>
        candidate.agentId === history.agentId &&
        candidate.contract.version === history.rollbackFromVersion,
    );
    if (!target || target.contract.version >= history.contract.version) {
      throw new Error("Rollback target contract history is invalid");
    }
  }
  for (const proposal of database.assuranceProposals) {
    if (proposal.state !== "accepted") continue;
    const history = database.outcomeContractVersions.find(
      (record) => record.sourceProposalId === proposal.id,
    );
    if (
      !history ||
      history.agentId !== proposal.agentId ||
      history.contract.version !== proposal.decision?.resultingContractVersion
    ) {
      throw new Error("Accepted Assurance Proposal history is missing");
    }
  }
}

function validateAssuranceProposal(proposal: Record<string, unknown>): void {
  assertExactKeys(
    proposal,
    [
      "schemaVersion",
      "id",
      "agentId",
      "state",
      "baseContractVersion",
      "baseContractHash",
      "generatorId",
      "generatorVersion",
      "operations",
      "citations",
      "simulation",
      "proposalDigest",
      "decision",
      "createdAt",
      "updatedAt",
    ],
    "Assurance Proposal",
  );
  if (
    proposal.schemaVersion !== 1 ||
    typeof proposal.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(proposal.id) ||
    typeof proposal.agentId !== "string" ||
    !candidateIdentifierPattern.test(proposal.agentId) ||
    !["draft", "ready", "accepted", "rejected", "superseded", "stale"].includes(
      String(proposal.state),
    ) ||
    !Number.isSafeInteger(proposal.baseContractVersion) ||
    (proposal.baseContractVersion as number) < 1 ||
    !isDigest(proposal.baseContractHash) ||
    proposal.generatorId !== "agent-airlock-deterministic-detector" ||
    proposal.generatorVersion !== 1 ||
    !Array.isArray(proposal.operations) ||
    proposal.operations.length < 1 ||
    proposal.operations.length > 10 ||
    !Array.isArray(proposal.citations) ||
    proposal.citations.length > 80 ||
    !isRecord(proposal.simulation) ||
    !isDigest(proposal.proposalDigest) ||
    !isTimestamp(proposal.createdAt) ||
    !isTimestamp(proposal.updatedAt)
  ) {
    throw new Error("Assurance Proposal identity or bounds are invalid");
  }
  for (const operation of proposal.operations) {
    validateAssuranceOperation(operation);
  }
  const derivationRules = new Set([
    "deleted-path-recurrence-v1",
    "changed-file-limit-recurrence-v1",
    "added-byte-limit-recurrence-v1",
    "catalog-secret-recurrence-v1",
    "optional-command-failure-recurrence-v1",
  ]);
  for (const rawCitation of proposal.citations) {
    if (!isRecord(rawCitation)) {
      throw new Error("Assurance citation must be an object");
    }
    assertExactKeys(
      rawCitation,
      [
        "operationKey",
        "runId",
        "rootRunId",
        "evidenceSelector",
        "evidenceHash",
        "derivationRule",
      ],
      "Assurance citation",
    );
    if (
      !isSafeText(rawCitation.operationKey, 1, 500) ||
      !isSafeText(rawCitation.runId, 1, 128) ||
      !isSafeText(rawCitation.rootRunId, 1, 128) ||
      !isSafeText(rawCitation.evidenceSelector, 1, 500) ||
      !isDigest(rawCitation.evidenceHash) ||
      !derivationRules.has(String(rawCitation.derivationRule))
    ) {
      throw new Error("Assurance citation is invalid");
    }
  }
  validateAssuranceSimulation(proposal.simulation);
  if (proposal.decision !== null) {
    if (!isRecord(proposal.decision)) {
      throw new Error("Assurance decision must be an object");
    }
    assertExactKeys(
      proposal.decision,
      ["action", "reason", "decidedAt", "resultingContractVersion"],
      "Assurance decision",
    );
    if (
      (proposal.decision.action !== "accepted" &&
        proposal.decision.action !== "rejected") ||
      !isSafeText(proposal.decision.reason, 0, 500) ||
      !isTimestamp(proposal.decision.decidedAt) ||
      !isNullableSafeInteger(
        proposal.decision.resultingContractVersion,
        1,
        1_000_000,
      )
    ) {
      throw new Error("Assurance decision is invalid");
    }
  }
  if (
    (proposal.state === "accepted" &&
      (!isRecord(proposal.decision) ||
        proposal.decision.action !== "accepted" ||
        proposal.decision.resultingContractVersion === null)) ||
    (proposal.state === "rejected" &&
      (!isRecord(proposal.decision) ||
        proposal.decision.action !== "rejected" ||
        proposal.decision.resultingContractVersion !== null)) ||
    (!["accepted", "rejected"].includes(String(proposal.state)) &&
      proposal.decision !== null)
  ) {
    throw new Error("Assurance Proposal state and decision contradict");
  }
  verifyAssuranceProposalIntegrity(proposal as unknown as Database["assuranceProposals"][number]);
}

function validateAssuranceOperation(value: unknown): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Assurance operation must be an object");
  }
  if (value.kind === "add-required-path" || value.kind === "add-protected-path") {
    assertExactKeys(value, ["kind", "path"], "Assurance path operation");
    if (!isSafeText(value.path, 1, 240)) {
      throw new Error("Assurance path operation is invalid");
    }
  } else if (
    value.kind === "lower-max-changed-files" ||
    value.kind === "lower-max-added-bytes"
  ) {
    assertExactKeys(value, ["kind", "maximum"], "Assurance limit operation");
    const minimum = value.kind === "lower-max-changed-files" ? 1 : 0;
    if (
      !Number.isSafeInteger(value.maximum) ||
      (value.maximum as number) < minimum
    ) {
      throw new Error("Assurance limit operation is invalid");
    }
  } else if (value.kind === "add-catalog-secret") {
    assertExactKeys(
      value,
      ["kind", "catalogId", "catalogVersion", "name", "pattern"],
      "Assurance secret operation",
    );
    if (
      !isSafeText(value.catalogId, 1, 80) ||
      !Number.isSafeInteger(value.catalogVersion) ||
      !isSafeText(value.name, 1, 64) ||
      !isSafeText(value.pattern, 1, 1_000)
    ) {
      throw new Error("Assurance secret operation is invalid");
    }
  } else if (value.kind === "make-command-required") {
    assertExactKeys(
      value,
      ["kind", "name", "commandHash", "timeoutMs"],
      "Assurance existing command operation",
    );
    if (
      !isSafeText(value.name, 1, 64) ||
      !isDigest(value.commandHash) ||
      !Number.isSafeInteger(value.timeoutMs)
    ) {
      throw new Error("Assurance existing command operation is invalid");
    }
  } else {
    throw new Error("Assurance operation kind is invalid");
  }
}

function validateAssuranceSimulation(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    ["engineId", "engineVersion", "results", "digest"],
    "Assurance simulation",
  );
  if (
    value.engineId !== "agent-airlock-historical-simulator" ||
    value.engineVersion !== 1 ||
    !Array.isArray(value.results) ||
    value.results.length > 2_000 ||
    !isDigest(value.digest)
  ) {
    throw new Error("Assurance simulation identity or bounds are invalid");
  }
  for (const rawResult of value.results) {
    if (!isRecord(rawResult)) {
      throw new Error("Assurance simulation result must be an object");
    }
    assertExactKeys(
      rawResult,
      [
        "operationKey",
        "runId",
        "classification",
        "priorDisposition",
        "counterfactualDisposition",
        "missingInputs",
        "resultHash",
      ],
      "Assurance simulation result",
    );
    if (
      !isSafeText(rawResult.operationKey, 1, 500) ||
      !isSafeText(rawResult.runId, 1, 128) ||
      !["exact", "conservative", "unknown"].includes(
        String(rawResult.classification),
      ) ||
      !isNullableDisposition(rawResult.priorDisposition) ||
      !isNullableDisposition(rawResult.counterfactualDisposition) ||
      !Array.isArray(rawResult.missingInputs) ||
      rawResult.missingInputs.length > 10 ||
      !rawResult.missingInputs.every((item) => isSafeText(item, 1, 240)) ||
      !isDigest(rawResult.resultHash)
    ) {
      throw new Error("Assurance simulation result is invalid");
    }
  }
}

function isNullableDisposition(value: unknown): boolean {
  return (
    value === null ||
    value === "promoted" ||
    value === "quarantined" ||
    value === "discarded" ||
    value === "cancelled"
  );
}

function validateVersionNineDatabase(database: VersionNineDatabase): void {
  assertExactKeys(
    database,
    ["version", "agents", "messages", "runs", "candidateSets"],
    "Version 9 database",
  );
  if (
    !Array.isArray(database.agents) ||
    !Array.isArray(database.messages) ||
    !Array.isArray(database.runs) ||
    !Array.isArray(database.candidateSets)
  ) {
    throw new Error("Version 9 database aggregates must be arrays");
  }
  const runs = new Map<string, Record<string, unknown>>();
  for (const rawRun of database.runs) {
    const run = rawRun as unknown as Record<string, unknown>;
    if (
      typeof run.id !== "string" ||
      runs.has(run.id) ||
      typeof run.agentId !== "string"
    ) {
      throw new Error("Version 9 database Run identity is invalid");
    }
    runs.set(run.id, run);
  }
  const candidateSetIds = new Set<string>();
  for (const rawCandidateSet of database.candidateSets) {
    const candidateSet = rawCandidateSet as unknown as Record<string, unknown>;
    assertExactKeys(
      candidateSet,
      [
        "schemaVersion",
        "id",
        "agentId",
        "objective",
        "source",
        "outcomeContract",
        "selectionContract",
        "competitors",
        "maxConcurrency",
        "budget",
        "loserPolicy",
        "phase",
        "selectionDecision",
        "selectedCompetitorId",
        "winnerRunId",
        "cancellationRequested",
        "recoveryError",
        "createdAt",
        "updatedAt",
        "decidedAt",
        "completedAt",
      ],
      "Candidate Set",
    );
    if (
      candidateSet.schemaVersion !== 1 ||
      typeof candidateSet.id !== "string" ||
      !candidateIdentifierPattern.test(candidateSet.id) ||
      candidateSetIds.has(candidateSet.id) ||
      typeof candidateSet.agentId !== "string" ||
      !candidateIdentifierPattern.test(candidateSet.agentId) ||
      !Array.isArray(candidateSet.competitors) ||
      candidateSet.competitors.length < 2 ||
      candidateSet.competitors.length > 8
    ) {
      throw new Error("Candidate Set identity or bounds are invalid");
    }
    candidateSetIds.add(candidateSet.id);
    validateCandidateSetAggregateFields(candidateSet);
    const competitorIds = new Set<string>();
    const competitorRunIds = new Set<string>();
    const competitorRunById = new Map<string, string>();
    for (const rawCompetitor of candidateSet.competitors) {
      if (!isRecord(rawCompetitor)) {
        throw new Error("Candidate Set competitor must be an object");
      }
      assertExactKeys(
        rawCompetitor,
        [
          "id",
          "runId",
          "executorProfileId",
          "strategyInstruction",
          "status",
          "criterionValues",
          "exclusions",
          "evaluationDurationMs",
          "resultThreadId",
          "seal",
          "loserDisposition",
          "error",
          "startedAt",
          "completedAt",
        ],
        "Candidate Set competitor",
      );
      if (
        typeof rawCompetitor.id !== "string" ||
        !candidateIdentifierPattern.test(rawCompetitor.id) ||
        competitorIds.has(rawCompetitor.id) ||
        typeof rawCompetitor.runId !== "string" ||
        !candidateIdentifierPattern.test(rawCompetitor.runId) ||
        competitorRunIds.has(rawCompetitor.runId)
      ) {
        throw new Error("Candidate Set competitor identity is invalid");
      }
      competitorIds.add(rawCompetitor.id);
      competitorRunIds.add(rawCompetitor.runId);
      competitorRunById.set(rawCompetitor.id, rawCompetitor.runId);
      validateCandidateSetCompetitorFields(rawCompetitor);
      const run = runs.get(rawCompetitor.runId);
      if (
        !run ||
        run.agentId !== candidateSet.agentId ||
        run.candidateSetId !== candidateSet.id ||
        run.competitorId !== rawCompetitor.id
      ) {
        throw new Error("Candidate Set Run cross-reference is invalid");
      }
      if (rawCompetitor.seal !== null) {
        validateCandidateSeal(
          rawCompetitor.seal,
          candidateSet,
          rawCompetitor,
        );
      }
    }
    validateCandidateSetAdmissionSnapshot(candidateSet);
    validateCandidateDecision(candidateSet, competitorIds, competitorRunById);
  }
}

function validatePersistedAssuranceRunEvidence(
  run: Record<string, unknown>,
): void {
  assertAllowedKeys(
    run,
    [
      "id",
      "agentId",
      "candidateSetId",
      "competitorId",
      "status",
      "prompt",
      "output",
      "error",
      "usage",
      "transaction",
      "startedAt",
      "completedAt",
      "createdAt",
    ],
    "Persisted Run",
  );
  if (
    typeof run.id !== "string" ||
    !candidateIdentifierPattern.test(run.id) ||
    (run.agentId !== undefined &&
      (typeof run.agentId !== "string" ||
        !candidateIdentifierPattern.test(run.agentId))) ||
    (run.status !== undefined &&
      !["queued", "running", "completed", "failed", "cancelled"].includes(
        String(run.status),
      )) ||
    (run.prompt !== undefined && !isSafeText(run.prompt, 0, 50_000)) ||
    (run.output !== undefined && !isNullableSafeText(run.output, 2_097_152)) ||
    (run.error !== undefined && !isNullableSafeText(run.error, 2_000)) ||
    (run.startedAt !== undefined && !isNullableTimestamp(run.startedAt)) ||
    (run.completedAt !== undefined && !isNullableTimestamp(run.completedAt)) ||
    (run.createdAt !== undefined && !isTimestamp(run.createdAt))
  ) {
    throw new Error("Persisted Run fields are invalid");
  }
  if (run.usage !== undefined && run.usage !== null) {
    const usage = run.usage;
    if (!isRecord(usage)) throw new Error("Persisted Run usage must be an object");
    assertAllowedKeys(
      usage,
      ["inputTokens", "cachedInputTokens", "outputTokens"],
      "Persisted Run usage",
    );
    if (
      Object.values(usage).some(
        (value) => !Number.isSafeInteger(value) || (value as number) < 0,
      )
    ) {
      throw new Error("Persisted Run usage is invalid");
    }
  }
  if (run.transaction === undefined || run.transaction === null) return;
  const transaction = run.transaction;
  if (!isRecord(transaction)) {
    throw new Error("Persisted Run Transaction must be an object");
  }
  assertAllowedKeys(
    transaction,
    [
      "id",
      "assuranceEvidenceVersion",
      "status",
      "disposition",
      "candidateStateId",
      "canonicalStateIdBefore",
      "canonicalStateIdAfter",
      "canonicalContentHashBefore",
      "canonicalContentHashAfter",
      "outcomeContractVersion",
      "outcomeContract",
      "resources",
      "providerResources",
      "providerResourceEvents",
      "sqlite",
      "externalActions",
      "changes",
      "validations",
      "events",
      "quarantinePath",
      "quarantineAvailable",
      "discardedAt",
      "lineage",
      "recovery",
      "promotionReceipt",
    ],
    "Persisted Run Transaction",
  );
  if (
    (transaction.id !== undefined && transaction.id !== run.id) ||
    (transaction.assuranceEvidenceVersion !== undefined &&
      transaction.assuranceEvidenceVersion !== 1) ||
    (transaction.status !== undefined &&
      ![
        "preparing",
        "executing",
        "validating",
        "sealed",
        "promoting",
        "promoted",
        "quarantined",
        "discarded",
        "recovery-error",
        "cancelled",
      ].includes(String(transaction.status))) ||
    (transaction.disposition !== undefined &&
      transaction.disposition !== null &&
      !["promoted", "quarantined", "discarded", "cancelled"].includes(
        String(transaction.disposition),
      ))
  ) {
    throw new Error("Persisted Run Transaction identity or disposition is invalid");
  }
  const hasTrustedAssuranceEnvelope =
    transaction.assuranceEvidenceVersion === 1;

  if (transaction.outcomeContract !== undefined) {
    if (!isRecord(transaction.outcomeContract)) {
      throw new Error("Persisted Run Outcome Contract must be an object");
    }
    validatePersistedOutcomeContract(transaction.outcomeContract);
    if (
      transaction.outcomeContractVersion !== undefined &&
      transaction.outcomeContractVersion !== transaction.outcomeContract.version
    ) {
      throw new Error("Persisted Run Outcome Contract version contradicts its snapshot");
    }
  } else if (transaction.outcomeContractVersion !== undefined) {
    if (
      !Number.isSafeInteger(transaction.outcomeContractVersion) ||
      (transaction.outcomeContractVersion as number) < 1
    ) {
      throw new Error("Persisted Run Outcome Contract version is invalid");
    }
  }

  let hasLineage = false;
  if (transaction.lineage !== undefined) {
    const lineage = transaction.lineage;
    if (!isRecord(lineage)) throw new Error("Persisted Run lineage must be an object");
    assertExactKeys(
      lineage,
      ["rootRunId", "parentRunId", "depth", "maxDepth"],
      "Persisted Run lineage",
    );
    if (
      typeof lineage.rootRunId !== "string" ||
      !candidateIdentifierPattern.test(lineage.rootRunId) ||
      !(
        lineage.parentRunId === null ||
        (typeof lineage.parentRunId === "string" &&
          candidateIdentifierPattern.test(lineage.parentRunId))
      ) ||
      !Number.isSafeInteger(lineage.depth) ||
      (lineage.depth as number) < 0 ||
      !Number.isSafeInteger(lineage.maxDepth) ||
      (lineage.maxDepth as number) < (lineage.depth as number) ||
      ((lineage.depth as number) === 0 &&
        (lineage.parentRunId !== null || lineage.rootRunId !== run.id)) ||
      ((lineage.depth as number) > 0 && lineage.parentRunId === null)
    ) {
      throw new Error("Persisted Run lineage is invalid");
    }
    hasLineage = true;
  }

  let hasChanges = false;
  if (transaction.changes !== undefined && transaction.changes !== null) {
    const changes = transaction.changes;
    if (!isRecord(changes)) throw new Error("Persisted Run changes must be an object");
    assertExactKeys(
      changes,
      ["files", "totalChangedFiles", "totalAddedBytes", "truncated"],
      "Persisted Run changes",
    );
    if (
      !Array.isArray(changes.files) ||
      changes.files.length > 10_000 ||
      !Number.isSafeInteger(changes.totalChangedFiles) ||
      (changes.totalChangedFiles as number) < changes.files.length ||
      !Number.isSafeInteger(changes.totalAddedBytes) ||
      (changes.totalAddedBytes as number) < 0 ||
      typeof changes.truncated !== "boolean" ||
      (!changes.truncated && changes.totalChangedFiles !== changes.files.length)
    ) {
      throw new Error("Persisted Run changes aggregate is invalid");
    }
    const paths = new Set<string>();
    let visibleAddedBytes = 0;
    for (const rawChange of changes.files) {
      if (!isRecord(rawChange)) {
        throw new Error("Persisted Run change must be an object");
      }
      assertExactKeys(
        rawChange,
        ["path", "kind", "addedBytes"],
        "Persisted Run change",
      );
      if (
        !isSafeText(rawChange.path, 1, 240) ||
        (rawChange.path as string).startsWith("/") ||
        (rawChange.path as string).includes("\\") ||
        (rawChange.path as string).split("/").includes("..") ||
        paths.has(rawChange.path as string) ||
        !["added", "modified", "deleted"].includes(String(rawChange.kind)) ||
        !Number.isSafeInteger(rawChange.addedBytes) ||
        (rawChange.addedBytes as number) < 0
      ) {
        throw new Error("Persisted Run change evidence is invalid");
      }
      paths.add(rawChange.path as string);
      visibleAddedBytes += rawChange.addedBytes as number;
      if (!Number.isSafeInteger(visibleAddedBytes)) {
        throw new Error("Persisted Run visible added bytes overflowed");
      }
    }
    if ((changes.totalAddedBytes as number) < visibleAddedBytes) {
      throw new Error("Persisted Run added-byte aggregate contradicts its files");
    }
    hasChanges = true;
  }

  let hasValidations = false;
  if (transaction.validations !== undefined) {
    if (
      !Array.isArray(transaction.validations) ||
      transaction.validations.length > 100
    ) {
      throw new Error("Persisted Run Validation evidence exceeds its bounds");
    }
    const validationNames = new Set<string>();
    for (const rawValidation of transaction.validations) {
      if (!isRecord(rawValidation)) {
        throw new Error("Persisted Run Validation evidence must be an object");
      }
      if (hasTrustedAssuranceEnvelope) {
        assertExactKeys(
          rawValidation,
          ["name", "status", "required", "summary", "durationMs", "output"],
          "Persisted Run Validation evidence",
        );
      } else {
        assertAllowedKeys(
          rawValidation,
          ["name", "status", "required", "summary", "durationMs", "output"],
          "Legacy Run Validation evidence",
        );
      }
      if (
        typeof rawValidation.name !== "string" ||
        Buffer.byteLength(rawValidation.name, "utf8") < 1 ||
        Buffer.byteLength(rawValidation.name, "utf8") > 160 ||
        validationNames.has(rawValidation.name) ||
        !["passed", "failed", "error"].includes(String(rawValidation.status)) ||
        (hasTrustedAssuranceEnvelope
          ? typeof rawValidation.required !== "boolean" ||
            !isSafeText(rawValidation.summary, 0, 1_000) ||
            !Number.isSafeInteger(rawValidation.durationMs) ||
            (rawValidation.durationMs as number) < 0 ||
            (rawValidation.durationMs as number) > 3_600_000 ||
            !isNullableSafeText(rawValidation.output, 16_384)
          : (rawValidation.required !== undefined &&
              typeof rawValidation.required !== "boolean") ||
            (rawValidation.summary !== undefined &&
              !isSafeText(rawValidation.summary, 0, 1_000)) ||
            (rawValidation.durationMs !== undefined &&
              (!Number.isSafeInteger(rawValidation.durationMs) ||
                (rawValidation.durationMs as number) < 0 ||
                (rawValidation.durationMs as number) > 3_600_000)) ||
            (rawValidation.output !== undefined &&
              !isNullableSafeText(rawValidation.output, 16_384)))
      ) {
        throw new Error("Persisted Run Validation evidence is invalid");
      }
      validationNames.add(rawValidation.name);
    }
    hasValidations = transaction.validations.length > 0;
  }
  if (hasTrustedAssuranceEnvelope && (hasChanges || hasValidations) && !hasLineage) {
    throw new Error("Persisted Run assurance evidence requires exact lineage");
  }
  if (
    hasTrustedAssuranceEnvelope &&
    transaction.promotionReceipt !== undefined &&
    transaction.promotionReceipt !== null
  ) {
    validatePersistedPromotionReceipt(transaction, run.id as string);
  }
  if (
    hasTrustedAssuranceEnvelope &&
    Array.isArray(transaction.validations) &&
    transaction.validations.some(
      (validation) =>
        isRecord(validation) &&
        typeof validation.name === "string" &&
        (validation.name === "change-limits" ||
          validation.name.startsWith("command:")),
    ) &&
    transaction.outcomeContract === undefined
  ) {
    throw new Error("Persisted Run assurance evidence requires its Outcome Contract");
  }
}

function validatePersistedPromotionReceipt(
  transaction: Record<string, unknown>,
  runId: string,
): void {
  const receipt = transaction.promotionReceipt;
  if (!isRecord(receipt)) {
    throw new Error("Persisted Promotion Receipt must be an object");
  }
  assertExactKeys(
    receipt,
    [
      "runTransactionId",
      "disposition",
      "outcomeContractVersion",
      "canonicalStateIdBefore",
      "canonicalStateIdAfter",
      "canonicalContentHashBefore",
      "canonicalContentHashAfter",
      "validationEvidenceHash",
      "lineage",
      "createdAt",
    ],
    "Persisted Promotion Receipt",
  );
  if (
    receipt.runTransactionId !== runId ||
    receipt.runTransactionId !== transaction.id ||
    receipt.disposition !== transaction.disposition ||
    receipt.outcomeContractVersion !== transaction.outcomeContractVersion ||
    receipt.canonicalStateIdBefore !== transaction.canonicalStateIdBefore ||
    receipt.canonicalStateIdAfter !== transaction.canonicalStateIdAfter ||
    receipt.canonicalContentHashBefore !== transaction.canonicalContentHashBefore ||
    receipt.canonicalContentHashAfter !== transaction.canonicalContentHashAfter ||
    !isTimestamp(receipt.createdAt) ||
    !isRecord(receipt.lineage) ||
    !isRecord(transaction.lineage) ||
    stableJson(receipt.lineage) !== stableJson(transaction.lineage) ||
    !Array.isArray(transaction.validations) ||
    !Array.isArray(transaction.providerResources)
  ) {
    throw new Error("Persisted Promotion Receipt contradicts its Run Transaction");
  }
  const expectedValidationEvidenceHash = promotionValidationEvidenceHash(
    transaction as unknown as Parameters<typeof promotionValidationEvidenceHash>[0],
  );
  if (receipt.validationEvidenceHash !== expectedValidationEvidenceHash) {
    throw new Error("Persisted Promotion Receipt contradicts Validation evidence");
  }
  if (
    transaction.disposition !== "promoted" &&
    (transaction.canonicalStateIdAfter !== transaction.canonicalStateIdBefore ||
      transaction.canonicalContentHashAfter !==
        transaction.canonicalContentHashBefore)
  ) {
    throw new Error("Persisted non-Promotion receipt changes Canonical State");
  }
}

function validateCandidateSetAggregateFields(
  candidateSet: Record<string, unknown>,
): void {
  if (
    typeof candidateSet.objective !== "string" ||
    !isRecord(candidateSet.source) ||
    !isRecord(candidateSet.outcomeContract) ||
    !isRecord(candidateSet.selectionContract) ||
    !isRecord(candidateSet.budget) ||
    !Number.isSafeInteger(candidateSet.maxConcurrency) ||
    (candidateSet.loserPolicy !== "retain" &&
      candidateSet.loserPolicy !== "discard") ||
    !candidateSetPhases.has(String(candidateSet.phase)) ||
    typeof candidateSet.cancellationRequested !== "boolean" ||
    !isNullableSafeText(candidateSet.recoveryError, 500) ||
    !isTimestamp(candidateSet.createdAt) ||
    !isTimestamp(candidateSet.updatedAt) ||
    !isNullableTimestamp(candidateSet.decidedAt) ||
    !isNullableTimestamp(candidateSet.completedAt)
  ) {
    throw new Error("Candidate Set aggregate fields are invalid");
  }
  validateCandidateSetSource(candidateSet.source);
  validatePersistedOutcomeContract(candidateSet.outcomeContract);
  assertExactKeys(
    candidateSet.budget,
    ["maxDurationMsPerCompetitor", "maxTotalTokens", "maxTotalChangedBytes"],
    "Candidate Set budget",
  );
  assertExactKeys(
    candidateSet.selectionContract,
    ["schemaVersion", "criteria"],
    "Candidate Set Selection Contract",
  );
  assertSelectionContract(
    candidateSet.selectionContract as unknown as Parameters<
      typeof assertSelectionContract
    >[0],
  );
}

function validateCandidateSetAdmissionSnapshot(
  candidateSet: Record<string, unknown>,
): void {
  const competitors = candidateSet.competitors as Record<string, unknown>[];
  validateCandidateSetInput({
    objective: candidateSet.objective as string,
    competitors: competitors.map((competitor) => ({
      id: competitor.id as string,
      executorProfileId: competitor.executorProfileId as string,
      strategyInstruction: competitor.strategyInstruction as string,
    })),
    selectionContract: candidateSet.selectionContract as never,
    maxConcurrency: candidateSet.maxConcurrency as number,
    budget: candidateSet.budget as never,
    loserPolicy: candidateSet.loserPolicy as "retain" | "discard",
  });
}

function validateCandidateSetSource(source: Record<string, unknown>): void {
  assertExactKeys(
    source,
    [
      "stateId",
      "contentHash",
      "workspaceContentHash",
      "sessionContentHash",
      "sqliteContentHash",
      "outboxContentHash",
      "codexThreadId",
      "providerVersions",
    ],
    "Candidate Set source",
  );
  if (
    typeof source.stateId !== "string" ||
    !candidateIdentifierPattern.test(source.stateId) ||
    !isDigest(source.contentHash) ||
    !isDigest(source.workspaceContentHash) ||
    !isDigest(source.sessionContentHash) ||
    !isDigest(source.sqliteContentHash) ||
    !isDigest(source.outboxContentHash) ||
    !isNullableSafeText(source.codexThreadId, 256) ||
    !Array.isArray(source.providerVersions) ||
    source.providerVersions.length > 32
  ) {
    throw new Error("Candidate Set source is invalid");
  }
  const providerIds = new Set<string>();
  for (const rawVersion of source.providerVersions) {
    const version = parseResourceVersionReference(rawVersion);
    if (providerIds.has(version.providerId)) {
      throw new Error("Candidate Set source contains duplicate providers");
    }
    providerIds.add(version.providerId);
  }
}

function validatePersistedOutcomeContract(
  contract: Record<string, unknown>,
): void {
  assertExactKeys(
    contract,
    [
      "schemaVersion",
      "version",
      "requiredPaths",
      "protectedPaths",
      "maxChangedFiles",
      "maxAddedBytes",
      "secretPatterns",
      "validationCommands",
      "createdAt",
    ],
    "Candidate Set Outcome Contract",
  );
  if (
    contract.schemaVersion !== 1 ||
    !Number.isSafeInteger(contract.version) ||
    (contract.version as number) < 1 ||
    !Array.isArray(contract.requiredPaths) ||
    !contract.requiredPaths.every((value) => typeof value === "string") ||
    !Array.isArray(contract.protectedPaths) ||
    !contract.protectedPaths.every((value) => typeof value === "string") ||
    !Array.isArray(contract.secretPatterns) ||
    !Array.isArray(contract.validationCommands) ||
    !isTimestamp(contract.createdAt)
  ) {
    throw new Error("Candidate Set Outcome Contract is invalid");
  }
  for (const rule of contract.secretPatterns) {
    if (!isRecord(rule)) {
      throw new Error("Outcome Contract secret rule must be an object");
    }
    assertExactKeys(rule, ["name", "pattern"], "Outcome Contract secret rule");
    if (typeof rule.name !== "string" || typeof rule.pattern !== "string") {
      throw new Error("Outcome Contract secret rule is invalid");
    }
  }
  for (const command of contract.validationCommands) {
    if (!isRecord(command)) {
      throw new Error("Outcome Contract Validation command must be an object");
    }
    assertExactKeys(
      command,
      ["name", "command", "required", "timeoutMs"],
      "Outcome Contract Validation command",
    );
    if (
      typeof command.name !== "string" ||
      typeof command.command !== "string" ||
      typeof command.required !== "boolean" ||
      !Number.isSafeInteger(command.timeoutMs)
    ) {
      throw new Error("Outcome Contract Validation command is invalid");
    }
  }
  validateOutcomeContractInput({
    requiredPaths: contract.requiredPaths as string[],
    protectedPaths: contract.protectedPaths as string[],
    maxChangedFiles: contract.maxChangedFiles as number,
    maxAddedBytes: contract.maxAddedBytes as number,
    secretPatterns: contract.secretPatterns as never,
    validationCommands: contract.validationCommands as never,
  });
}

function validateCandidateSetCompetitorFields(
  competitor: Record<string, unknown>,
): void {
  if (
    typeof competitor.executorProfileId !== "string" ||
    typeof competitor.strategyInstruction !== "string" ||
    !competitorStatuses.has(String(competitor.status)) ||
    !isRecord(competitor.criterionValues) ||
    !Array.isArray(competitor.exclusions) ||
    competitor.exclusions.length > 64 ||
    !competitor.exclusions.every(
      (value) => isSafeText(value, 1, 240),
    ) ||
    !isNullableSafeInteger(competitor.evaluationDurationMs, 0, 3_600_000) ||
    !isNullableSafeText(competitor.resultThreadId, 256) ||
    !loserDispositions.has(String(competitor.loserDisposition)) ||
    !isNullableSafeText(competitor.error, 500) ||
    !isNullableTimestamp(competitor.startedAt) ||
    !isNullableTimestamp(competitor.completedAt)
  ) {
    throw new Error("Candidate Set competitor fields are invalid");
  }
  for (const [kind, rawValue] of Object.entries(competitor.criterionValues)) {
    const criterion = SELECTION_CRITERIA[kind as keyof typeof SELECTION_CRITERIA];
    if (
      !criterion ||
      !Number.isSafeInteger(rawValue) ||
      (rawValue as number) < 0 ||
      (rawValue as number) > criterion.maximum
    ) {
      throw new Error("Candidate Set competitor criterion is invalid");
    }
  }
}

function validateCandidateDecision(
  candidateSet: Record<string, unknown>,
  competitorIds: ReadonlySet<string>,
  competitorRunById: ReadonlyMap<string, string>,
): void {
  const decision = candidateSet.selectionDecision;
  if (decision === null) {
    if (
      candidateSet.selectedCompetitorId !== null ||
      candidateSet.winnerRunId !== null
    ) {
      throw new Error("Candidate Set winner exists without a Selection Decision");
    }
    return;
  }
  if (!isRecord(decision)) {
    throw new Error("Candidate Set Selection Decision must be an object");
  }
  assertExactKeys(
    decision,
    [
      "schemaVersion",
      "candidateSetId",
      "sourceStateId",
      "orderedCompetitorIds",
      "winnerCompetitorId",
      "scorecard",
      "tieBreak",
      "decisionDigest",
    ],
    "Candidate Set Selection Decision",
  );
  const source = isRecord(candidateSet.source) ? candidateSet.source : null;
  if (
    decision.schemaVersion !== 1 ||
    decision.candidateSetId !== candidateSet.id ||
    decision.sourceStateId !== source?.stateId ||
    !Array.isArray(decision.orderedCompetitorIds) ||
    !Array.isArray(decision.scorecard) ||
    decision.tieBreak !== "competitor-id-ascending-byte-order" ||
    typeof decision.decisionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(decision.decisionDigest)
  ) {
    throw new Error("Candidate Set Selection Decision identity is invalid");
  }
  const orderedIds = decision.orderedCompetitorIds;
  if (
    orderedIds.some(
      (value) => typeof value !== "string" || !competitorIds.has(value),
    ) ||
    new Set(orderedIds).size !== orderedIds.length ||
    decision.scorecard.length !== competitorIds.size
  ) {
    throw new Error("Candidate Set Selection Decision ordering is invalid");
  }
  const scorecardIds = new Set<string>();
  for (const rawEntry of decision.scorecard) {
    validateCandidateScorecardEntry(rawEntry, competitorIds, scorecardIds);
  }
  if (scorecardIds.size !== competitorIds.size) {
    throw new Error("Candidate Set Selection Decision scorecard is incomplete");
  }
  const { decisionDigest, ...unsignedDecision } = decision;
  const expectedDigest = createHash("sha256")
    .update(stableJson(unsignedDecision))
    .digest("hex");
  if (decisionDigest !== expectedDigest) {
    throw new Error("Candidate Set Selection Decision digest is invalid");
  }
  if (decision.winnerCompetitorId === null) {
    if (
      candidateSet.selectedCompetitorId !== null ||
      candidateSet.winnerRunId !== null
    ) {
      throw new Error("No-winner Selection Decision contradicts winner links");
    }
    return;
  }
  if (
    typeof decision.winnerCompetitorId !== "string" ||
    !competitorIds.has(decision.winnerCompetitorId) ||
    orderedIds[0] !== decision.winnerCompetitorId ||
    typeof candidateSet.selectedCompetitorId !== "string" ||
    candidateSet.selectedCompetitorId !== decision.winnerCompetitorId ||
    typeof candidateSet.winnerRunId !== "string" ||
    candidateSet.winnerRunId !==
      competitorRunById.get(decision.winnerCompetitorId)
  ) {
    throw new Error("Candidate Set Selection Decision contradicts winner links");
  }
}

function validateCandidateScorecardEntry(
  rawEntry: unknown,
  competitorIds: ReadonlySet<string>,
  seenIds: Set<string>,
): void {
  if (!isRecord(rawEntry)) {
    throw new Error("Candidate scorecard entry must be an object");
  }
  assertExactKeys(
    rawEntry,
    ["competitorId", "eligible", "exclusions", "components", "rank"],
    "Candidate scorecard entry",
  );
  if (
    typeof rawEntry.competitorId !== "string" ||
    !competitorIds.has(rawEntry.competitorId) ||
    seenIds.has(rawEntry.competitorId) ||
    typeof rawEntry.eligible !== "boolean" ||
    !Array.isArray(rawEntry.exclusions) ||
    rawEntry.exclusions.length > 64 ||
    !rawEntry.exclusions.every((value) => isSafeText(value, 1, 240)) ||
    !Array.isArray(rawEntry.components) ||
    rawEntry.components.length > 5 ||
    !(
      rawEntry.rank === null ||
      (Number.isSafeInteger(rawEntry.rank) && (rawEntry.rank as number) >= 1)
    ) ||
    (rawEntry.eligible &&
      (rawEntry.exclusions.length !== 0 || rawEntry.rank === null)) ||
    (!rawEntry.eligible && rawEntry.rank !== null)
  ) {
    throw new Error("Candidate scorecard entry is invalid");
  }
  seenIds.add(rawEntry.competitorId);
  const componentKinds = new Set<string>();
  for (const rawComponent of rawEntry.components) {
    if (!isRecord(rawComponent)) {
      throw new Error("Candidate score component must be an object");
    }
    assertExactKeys(
      rawComponent,
      [
        "kind",
        "source",
        "evaluatorVersion",
        "direction",
        "maximum",
        "rawValue",
        "normalizedValue",
      ],
      "Candidate score component",
    );
    const expected =
      typeof rawComponent.kind === "string"
        ? SELECTION_CRITERIA[
            rawComponent.kind as keyof typeof SELECTION_CRITERIA
          ]
        : undefined;
    if (
      !expected ||
      componentKinds.has(expected.kind) ||
      rawComponent.source !== expected.source ||
      rawComponent.evaluatorVersion !== expected.evaluatorVersion ||
      rawComponent.direction !== expected.direction ||
      rawComponent.maximum !== expected.maximum ||
      !Number.isSafeInteger(rawComponent.rawValue) ||
      (rawComponent.rawValue as number) < 0 ||
      (rawComponent.rawValue as number) > expected.maximum ||
      rawComponent.normalizedValue !==
        (expected.direction === "maximize"
          ? rawComponent.rawValue
          : expected.maximum - (rawComponent.rawValue as number))
    ) {
      throw new Error("Candidate score component is invalid");
    }
    componentKinds.add(expected.kind);
  }
}

function validateCandidateSeal(
  rawSeal: unknown,
  candidateSet: Record<string, unknown>,
  competitor: Record<string, unknown>,
): void {
  if (!isRecord(rawSeal)) throw new Error("Candidate seal must be an object");
  assertExactKeys(
    rawSeal,
    [
      "schemaVersion",
      "candidateSetId",
      "competitorId",
      "runId",
      "candidateStateId",
      "sourceStateId",
      "sourceContentHash",
      "outcomeContractVersion",
      "transactionEvidenceHash",
      "runtimeResultHash",
      "sealDigest",
      "sealedAt",
    ],
    "Candidate seal",
  );
  const source = isRecord(candidateSet.source) ? candidateSet.source : null;
  if (
    rawSeal.schemaVersion !== 1 ||
    rawSeal.candidateSetId !== candidateSet.id ||
    rawSeal.competitorId !== competitor.id ||
    rawSeal.runId !== competitor.runId ||
    typeof rawSeal.candidateStateId !== "string" ||
    !candidateIdentifierPattern.test(rawSeal.candidateStateId) ||
    rawSeal.sourceStateId !== source?.stateId ||
    typeof rawSeal.sourceContentHash !== "string" ||
    !digestPattern.test(rawSeal.sourceContentHash) ||
    typeof rawSeal.transactionEvidenceHash !== "string" ||
    !digestPattern.test(rawSeal.transactionEvidenceHash) ||
    typeof rawSeal.runtimeResultHash !== "string" ||
    !digestPattern.test(rawSeal.runtimeResultHash) ||
    typeof rawSeal.sealDigest !== "string" ||
    !digestPattern.test(rawSeal.sealDigest) ||
    !Number.isSafeInteger(rawSeal.outcomeContractVersion) ||
    (rawSeal.outcomeContractVersion as number) < 1 ||
    rawSeal.outcomeContractVersion !==
      (isRecord(candidateSet.outcomeContract)
        ? candidateSet.outcomeContract.version
        : undefined) ||
    !isTimestamp(rawSeal.sealedAt)
  ) {
    throw new Error("Candidate seal identity or digest is invalid");
  }
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

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(label + " contains unknown fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isSafeText(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes >= minimumBytes &&
    bytes <= maximumBytes &&
    redactSensitiveText(value) === value
  );
}

function isNullableSafeText(
  value: unknown,
  maximumBytes: number,
): value is string | null {
  return value === null || isSafeText(value, 0, maximumBytes);
}

function isNullableSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      (value as number) >= minimum &&
      (value as number) <= maximum)
  );
}
