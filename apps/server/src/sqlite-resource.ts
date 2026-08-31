import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SecretPattern,
  SqliteSnapshot,
  ValidationEvidence,
} from "./types.js";
import { SensitiveLiteralFilter } from "./sensitive-literals.js";

export const SQLITE_RELATIVE_PATH = ".airlock/demo.sqlite" as const;

const MAX_DATABASE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 100;
const MAX_FIELD_BYTES = 4_096;
const INITIAL_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export interface SqliteValidationResult {
  evidence: ValidationEvidence;
  snapshot: SqliteSnapshot | null;
}

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

export class SqliteResource {
  private readonly sensitiveLiterals: SensitiveLiteralFilter;

  constructor(sensitiveValues: readonly string[] = []) {
    this.sensitiveLiterals = new SensitiveLiteralFilter(sensitiveValues);
  }

  pathFor(workspacePath: string): string {
    return path.join(workspacePath, SQLITE_RELATIVE_PATH);
  }

  async seed(workspacePath: string): Promise<void> {
    const databasePath = this.pathFor(workspacePath);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS inventory (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      database
        .prepare(
          "INSERT OR IGNORE INTO inventory (id, value, updated_at) VALUES (?, ?, ?)",
        )
        .run("demo", "ready", INITIAL_TIMESTAMP);
    } finally {
      database.close();
    }
  }

  async validate(
    workspacePath: string,
    secretPatterns: SecretPattern[] = [],
  ): Promise<SqliteValidationResult> {
    const startedAt = Date.now();
    try {
      const snapshot = await this.inspect(workspacePath);
      const normalizedRows = JSON.stringify(snapshot.rows);
      if (this.sensitiveLiterals.contains(normalizedRows)) {
        throw new Error("inventory row data contained a control-plane sensitive value");
      }
      const secretMatch = secretPatterns.find((secretPattern) =>
        new RegExp(secretPattern.pattern, "i").test(normalizedRows),
      );
      if (secretMatch) {
        throw new Error(
          "inventory row data matched configured secret pattern " + secretMatch.name,
        );
      }
      return {
        snapshot,
        evidence: {
          name: "sqlite-resource",
          status: "passed",
          required: true,
          summary:
            "SQLite passed integrity, schema, size, and bounded-row checks with " +
            snapshot.rowCount +
            " inventory row" +
            (snapshot.rowCount === 1 ? "" : "s"),
          durationMs: Date.now() - startedAt,
          output: null,
        },
      };
    } catch (error) {
      return {
        snapshot: null,
        evidence: {
          name: "sqlite-resource",
          status: "failed",
          required: true,
          summary:
            error instanceof Error
              ? "SQLite validation failed: " + error.message
              : "SQLite validation failed",
          durationMs: Date.now() - startedAt,
          output: null,
        },
      };
    }
  }

  async inspect(workspacePath: string): Promise<SqliteSnapshot> {
    const databasePath = this.pathFor(workspacePath);
    const stats = await lstat(databasePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("database is not a regular file");
    }
    if (stats.size > MAX_DATABASE_BYTES) {
      throw new Error("database exceeds the 8 MiB limit");
    }

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA integrity_check").get() as
        | { integrity_check?: unknown }
        | undefined;
      if (integrity?.integrity_check !== "ok") {
        throw new Error("integrity_check did not return ok");
      }

      const schema = database
        .prepare(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<Record<string, unknown>>;
      if (
        schema.length !== 1 ||
        schema[0]?.type !== "table" ||
        schema[0]?.name !== "inventory" ||
        schema[0]?.tableName !== "inventory"
      ) {
        throw new Error("schema contains objects outside the inventory allowlist");
      }

      const columns = database.prepare("PRAGMA table_info(inventory)").all() as Array<
        Record<string, unknown>
      >;
      const columnShape = columns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull,
        primaryKey: column.pk,
      }));
      const expectedShape = [
        { name: "id", type: "TEXT", notNull: 0, primaryKey: 1 },
        { name: "value", type: "TEXT", notNull: 1, primaryKey: 0 },
        { name: "updated_at", type: "TEXT", notNull: 1, primaryKey: 0 },
      ];
      if (JSON.stringify(columnShape) !== JSON.stringify(expectedShape)) {
        throw new Error("inventory table does not match the approved schema");
      }

      const count = database.prepare("SELECT COUNT(*) AS count FROM inventory").get() as
        | { count?: unknown }
        | undefined;
      const rowCount = Number(count?.count);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > MAX_ROWS) {
        throw new Error("inventory row count exceeds the 100-row limit");
      }
      const rawRows = database
        .prepare(
          "SELECT id, value, updated_at AS updatedAt FROM inventory ORDER BY id LIMIT ?",
        )
        .all(MAX_ROWS) as Array<Record<string, unknown>>;
      const rows = rawRows.map((row) => {
        if (
          typeof row.id !== "string" ||
          typeof row.value !== "string" ||
          typeof row.updatedAt !== "string"
        ) {
          throw new Error("inventory contains a non-text field");
        }
        if (
          bytes(row.id) > MAX_FIELD_BYTES ||
          bytes(row.value) > MAX_FIELD_BYTES ||
          bytes(row.updatedAt) > MAX_FIELD_BYTES
        ) {
          throw new Error("inventory contains a field over 4096 bytes");
        }
        return { id: row.id, value: row.value, updatedAt: row.updatedAt };
      });
      const normalized = JSON.stringify(rows);
      return {
        contentHash:
          "sha256:" + createHash("sha256").update(normalized).digest("hex"),
        rowCount,
        rows,
      };
    } finally {
      database.close();
    }
  }
}
