import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createDefaultOutcomeContract,
  createLegacyPhaseOneContract,
} from "./outcome-contract.js";
import { EXTERNAL_ACTION_BYPASS_DISCLOSURE } from "./external-actions.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 7,
  agents: [],
  messages: [],
  runs: [],
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

function migrateVersionSix(database: VersionSixDatabase): Database {
  return {
    version: 7,
    agents: database.agents as unknown as Database["agents"],
    messages: database.messages as unknown as Database["messages"],
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
    }) as unknown as Database["runs"],
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
        | VersionSixDatabase;
      if (
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.runs)
      ) {
        throw new Error("Unsupported database format");
      }
      if (parsed.version === 1) {
        this.data = migrateVersionSix(
          migrateVersionFive(
            migrateVersionFour(
              migrateVersionThree(migrateVersionTwo(migrateVersionOne(parsed))),
            ),
          ),
        );
        await this.persist();
      } else if (parsed.version === 2) {
        this.data = migrateVersionSix(
          migrateVersionFive(
            migrateVersionFour(migrateVersionThree(migrateVersionTwo(parsed))),
          ),
        );
        await this.persist();
      } else if (parsed.version === 3) {
        this.data = migrateVersionSix(
          migrateVersionFive(migrateVersionFour(migrateVersionThree(parsed))),
        );
        await this.persist();
      } else if (parsed.version === 4) {
        this.data = migrateVersionSix(migrateVersionFive(migrateVersionFour(parsed)));
        await this.persist();
      } else if (parsed.version === 5) {
        this.data = migrateVersionSix(migrateVersionFive(parsed));
        await this.persist();
      } else if (parsed.version === 6) {
        this.data = migrateVersionSix(parsed);
        await this.persist();
      } else if (parsed.version === 7) {
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
