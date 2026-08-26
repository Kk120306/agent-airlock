import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseResourceVersionReference,
  redactSensitiveText,
} from "@agent-airlock/transactional-resource-sdk";
import { SELECTION_CRITERIA, assertSelectionContract, stableJson } from "./candidate-selection.js";
import { validateCandidateSetInput } from "./candidate-set.js";
import {
  createDefaultOutcomeContract,
  createLegacyPhaseOneContract,
  validateOutcomeContractInput,
} from "./outcome-contract.js";
import { EXTERNAL_ACTION_BYPASS_DISCLOSURE } from "./external-actions.js";
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
  version: 9,
  agents: [],
  messages: [],
  runs: [],
  candidateSets: [],
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

function migrateVersionEight(database: VersionEightDatabase): Database {
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
        | VersionEightDatabase;
      if (
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.runs) ||
        (parsed.version === 9 && !Array.isArray(parsed.candidateSets))
      ) {
        throw new Error("Unsupported database format");
      }
      if (parsed.version === 1) {
        this.data = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(
              migrateVersionFour(
                migrateVersionThree(migrateVersionTwo(migrateVersionOne(parsed))),
              ),
            ),
          ),
        ));
        await this.persist();
      } else if (parsed.version === 2) {
        this.data = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(
              migrateVersionFour(migrateVersionThree(migrateVersionTwo(parsed))),
            ),
          ),
        ));
        await this.persist();
      } else if (parsed.version === 3) {
        this.data = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(
            migrateVersionFive(migrateVersionFour(migrateVersionThree(parsed))),
          ),
        ));
        await this.persist();
      } else if (parsed.version === 4) {
        this.data = migrateVersionEight(migrateVersionSeven(
          migrateVersionSix(migrateVersionFive(migrateVersionFour(parsed))),
        ));
        await this.persist();
      } else if (parsed.version === 5) {
        this.data = migrateVersionEight(
          migrateVersionSeven(migrateVersionSix(migrateVersionFive(parsed))),
        );
        await this.persist();
      } else if (parsed.version === 6) {
        this.data = migrateVersionEight(migrateVersionSeven(migrateVersionSix(parsed)));
        await this.persist();
      } else if (parsed.version === 7) {
        this.data = migrateVersionEight(migrateVersionSeven(parsed));
        await this.persist();
      } else if (parsed.version === 8) {
        this.data = migrateVersionEight(parsed);
        await this.persist();
      } else if (parsed.version === 9) {
        validateVersionNineDatabase(parsed);
        this.data = parsed;
      } else {
        throw new Error("Unsupported database format");
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

function validateVersionNineDatabase(database: Database): void {
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
