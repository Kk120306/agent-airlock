import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ExternalActionIntentEvidence,
  ValidationEvidence,
} from "./types.js";

const MAX_OUTBOX_BYTES = 64 * 1024;
const MAX_INTENTS = 10;
const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const intentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    type: z.literal("demo.notification.requested"),
    payload: z
      .object({
        destination: z.string().trim().min(1).max(64),
        subject: z.string().trim().min(1).max(120),
        body: z.string().max(1_000),
      })
      .strict(),
  })
  .strict();

export const EXTERNAL_ACTION_BYPASS_DISCLOSURE =
  "POC boundary: unrestricted Runtime networking could bypass this outbox. The supported action path is deferred until Promotion.";

export interface ParsedExternalActionIntent {
  schemaVersion: 1;
  id: string;
  type: "demo.notification.requested";
  payload: {
    destination: string;
    subject: string;
    body: string;
  };
  idempotencyKey: string;
  payloadHash: string;
}

export interface ExternalActionValidationResult {
  evidence: ValidationEvidence;
  intents: ParsedExternalActionIntent[];
}

export interface MockDeliveryReceipt {
  idempotencyKey: string;
  runId: string;
  intentId: string;
  type: "demo.notification.requested";
  destination: string;
  subject: string;
  payloadHash: string;
  deliveredAt: string;
}

interface MockDeliveryDatabase {
  version: 1;
  deliveries: MockDeliveryReceipt[];
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const hash = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");

const boundedError = (error: unknown): string => {
  const detail =
    error instanceof z.ZodError
      ? (error.issues[0]?.message ?? "intent does not match the supported schema")
      : error instanceof Error
        ? error.message
        : "validation failed";
  return detail.slice(0, 240);
};

export class ExternalActionOutbox {
  async validate(
    outboxPath: string,
    runId: string,
  ): Promise<ExternalActionValidationResult> {
    const startedAt = Date.now();
    try {
      const intents = await this.parse(outboxPath, runId);
      return {
        intents,
        evidence: {
          name: "external-action-intents",
          status: "passed",
          required: true,
          summary:
            intents.length === 0
              ? "No external action intent was requested"
              : intents.length +
                " typed external action intent" +
                (intents.length === 1 ? " is" : "s are") +
                " valid and deferred until Promotion",
          durationMs: Date.now() - startedAt,
          output: null,
        },
      };
    } catch (error) {
      return {
        intents: [],
        evidence: {
          name: "external-action-intents",
          status: "failed",
          required: true,
          summary:
            "External action validation failed: " + boundedError(error),
          durationMs: Date.now() - startedAt,
          output: null,
        },
      };
    }
  }

  private async parse(
    outboxPath: string,
    runId: string,
  ): Promise<ParsedExternalActionIntent[]> {
    if (!(await exists(outboxPath))) return [];
    const stats = await lstat(outboxPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("outbox is not a regular file");
    }
    if (stats.size > MAX_OUTBOX_BYTES) {
      throw new Error("outbox exceeds the 64 KiB limit");
    }
    const content = await readFile(outboxPath);
    if (content.byteLength > MAX_OUTBOX_BYTES) {
      throw new Error("outbox exceeds the 64 KiB limit");
    }
    const text = content.toString("utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > MAX_INTENTS) {
      throw new Error("outbox exceeds the 10-intent limit");
    }
    const ids = new Set<string>();
    return lines.map((line, index) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        throw new Error("line " + (index + 1) + " is not valid JSON");
      }
      const intent = intentSchema.parse(decoded);
      if (ids.has(intent.id)) throw new Error("duplicate intent id: " + intent.id);
      ids.add(intent.id);
      const normalizedPayload = JSON.stringify({
        destination: intent.payload.destination,
        subject: intent.payload.subject,
        body: intent.payload.body,
      });
      return {
        ...intent,
        payloadHash: hash(normalizedPayload),
        idempotencyKey: hash(
          [runId, intent.id, intent.type, normalizedPayload].join("\0"),
        ),
      };
    });
  }
}

export class MockExternalActionDispatcher {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!(await exists(this.filePath))) {
      await this.persist({ version: 1, deliveries: [] });
    } else {
      await this.read();
    }
  }

  async dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<MockDeliveryReceipt[]> {
    let receipts: MockDeliveryReceipt[] = [];
    const operation = this.queue.then(async () => {
      const database = await this.read();
      receipts = intents.map((intent) => {
        const existing = database.deliveries.find(
          (delivery) => delivery.idempotencyKey === intent.idempotencyKey,
        );
        if (existing) return existing;
        const receipt: MockDeliveryReceipt = {
          idempotencyKey: intent.idempotencyKey,
          runId,
          intentId: intent.id,
          type: intent.type,
          destination: intent.payload.destination,
          subject: intent.payload.subject,
          payloadHash: intent.payloadHash,
          deliveredAt: new Date().toISOString(),
        };
        database.deliveries.push(receipt);
        return receipt;
      });
      if (intents.length > 0) await this.persist(database);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return structuredClone(receipts);
  }

  async list(): Promise<MockDeliveryReceipt[]> {
    await this.queue;
    return structuredClone((await this.read()).deliveries);
  }

  private async read(): Promise<MockDeliveryDatabase> {
    const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as
      | MockDeliveryDatabase
      | Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      !Array.isArray((parsed as MockDeliveryDatabase).deliveries)
    ) {
      throw new Error("Unsupported mock delivery store format");
    }
    return parsed as MockDeliveryDatabase;
  }

  private async persist(database: MockDeliveryDatabase): Promise<void> {
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

export function intentEvidence(
  intents: ParsedExternalActionIntent[],
  status: ExternalActionIntentEvidence["status"],
  receipts: MockDeliveryReceipt[] = [],
): ExternalActionIntentEvidence[] {
  return intents.map((intent) => {
    const receipt = receipts.find(
      (candidate) => candidate.idempotencyKey === intent.idempotencyKey,
    );
    return {
      id: intent.id,
      type: intent.type,
      destination: intent.payload.destination,
      subject: intent.payload.subject,
      idempotencyKey: intent.idempotencyKey,
      status: receipt ? "delivered" : status,
      deliveredAt: receipt?.deliveredAt ?? null,
    };
  });
}
