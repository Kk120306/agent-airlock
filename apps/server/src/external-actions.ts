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

export type ExternalActionDeliveryMode =
  | "atomic-local-store"
  | "idempotent-http";

export interface ExternalActionDeliveryReceipt {
  idempotencyKey: string;
  runId: string;
  intentId: string;
  type: "demo.notification.requested";
  destination: string;
  subject: string;
  payloadHash: string;
  deliveredAt: string;
  deliveryMode: ExternalActionDeliveryMode;
}

export type MockDeliveryReceipt = ExternalActionDeliveryReceipt;

export interface ExternalActionDispatcher {
  readonly deliveryMode: ExternalActionDeliveryMode;
  initialize(): Promise<void>;
  dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<ExternalActionDeliveryReceipt[]>;
  list(): Promise<ExternalActionDeliveryReceipt[]>;
}

interface DeliveryDatabase {
  version: 1;
  deliveries: ExternalActionDeliveryReceipt[];
}

const httpDeliveryResponseSchema = z
  .object({
    schema: z.literal("agent-airlock/external-action-delivery-receipt"),
    schemaVersion: z.literal(1),
    accepted: z.literal(true),
    receipt: z
      .object({
        idempotencyKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        runId: idSchema,
        intentId: idSchema,
        type: z.literal("demo.notification.requested"),
        destination: z.string().trim().min(1).max(64),
        subject: z.string().trim().min(1).max(120),
        payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        deliveredAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

const deliveryReceiptSchema = z
  .object({
    idempotencyKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runId: idSchema,
    intentId: idSchema,
    type: z.literal("demo.notification.requested"),
    destination: z.string().trim().min(1).max(64),
    subject: z.string().trim().min(1).max(120),
    payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    deliveredAt: z.string().datetime({ offset: true }),
    deliveryMode: z.enum(["atomic-local-store", "idempotent-http"]),
  })
  .strict();

const MAXIMUM_DELIVERY_RESPONSE_BYTES = 16 * 1024;

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

function parseDeliveryDatabase(
  value: unknown,
  expectedMode: ExternalActionDeliveryMode,
  allowLegacyMode: boolean,
): DeliveryDatabase {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "deliveries\0version"
  ) {
    throw new Error("Unsupported delivery receipt store format");
  }
  const candidate = value as { version?: unknown; deliveries?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.deliveries)) {
    throw new Error("Unsupported delivery receipt store format");
  }
  const deliveries = candidate.deliveries.map((raw) => {
    const normalized =
      allowLegacyMode &&
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      !("deliveryMode" in raw)
        ? { ...raw, deliveryMode: expectedMode }
        : raw;
    const parsed = deliveryReceiptSchema.safeParse(normalized);
    if (!parsed.success || parsed.data.deliveryMode !== expectedMode) {
      throw new Error("Unsupported delivery receipt store format");
    }
    return parsed.data;
  });
  if (
    new Set(deliveries.map((delivery) => delivery.idempotencyKey)).size !==
    deliveries.length
  ) {
    throw new Error("Delivery receipt store contains duplicate evidence");
  }
  return { version: 1, deliveries };
}

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

export class MockExternalActionDispatcher implements ExternalActionDispatcher {
  readonly deliveryMode = "atomic-local-store" as const;
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
          deliveryMode: this.deliveryMode,
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

  private async read(): Promise<DeliveryDatabase> {
    return parseDeliveryDatabase(
      JSON.parse(await readFile(this.filePath, "utf8")),
      this.deliveryMode,
      true,
    );
  }

  private async persist(database: DeliveryDatabase): Promise<void> {
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

export class HttpExternalActionDispatcher
  implements ExternalActionDispatcher
{
  readonly deliveryMode = "idempotent-http" as const;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly filePath: string,
    private readonly allowedDestination = "demo-console",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
  ): Promise<ExternalActionDeliveryReceipt[]> {
    let receipts: ExternalActionDeliveryReceipt[] = [];
    const operation = this.queue.then(async () => {
      const database = await this.read();
      for (const intent of intents) {
        const existing = database.deliveries.find(
          (delivery) => delivery.idempotencyKey === intent.idempotencyKey,
        );
        if (existing) {
          receipts.push(existing);
          continue;
        }
        if (intent.payload.destination !== this.allowedDestination) {
          throw new Error(
            "External action destination is not mapped to a trusted receiver",
          );
        }
        const receipt = await this.deliver(runId, intent);
        database.deliveries.push(receipt);
        await this.persist(database);
        receipts.push(receipt);
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return structuredClone(receipts);
  }

  async list(): Promise<ExternalActionDeliveryReceipt[]> {
    await this.queue;
    return structuredClone((await this.read()).deliveries);
  }

  private async deliver(
    runId: string,
    intent: ParsedExternalActionIntent,
  ): Promise<ExternalActionDeliveryReceipt> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.idempotencyKey,
        },
        body: JSON.stringify({
          schema: "agent-airlock/external-action-delivery-request",
          schemaVersion: 1,
          runId,
          intent: {
            id: intent.id,
            type: intent.type,
            destination: intent.payload.destination,
            subject: intent.payload.subject,
            body: intent.payload.body,
            payloadHash: intent.payloadHash,
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("Trusted external action receiver is unavailable");
    }
    if (!response.ok) {
      throw new Error(
        "Trusted external action receiver rejected delivery with HTTP " +
          response.status,
      );
    }
    const source = await readBoundedResponse(response);
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      throw new Error("Trusted external action receiver returned invalid JSON");
    }
    const parsed = httpDeliveryResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error("Trusted external action receiver returned invalid evidence");
    }
    const receipt = parsed.data.receipt;
    if (
      receipt.idempotencyKey !== intent.idempotencyKey ||
      receipt.runId !== runId ||
      receipt.intentId !== intent.id ||
      receipt.type !== intent.type ||
      receipt.destination !== intent.payload.destination ||
      receipt.subject !== intent.payload.subject ||
      receipt.payloadHash !== intent.payloadHash
    ) {
      throw new Error(
        "Trusted external action receiver returned contradictory evidence",
      );
    }
    return { ...receipt, deliveryMode: this.deliveryMode };
  }

  private async read(): Promise<DeliveryDatabase> {
    return parseDeliveryDatabase(
      JSON.parse(await readFile(this.filePath, "utf8")),
      this.deliveryMode,
      false,
    );
  }

  private async persist(database: DeliveryDatabase): Promise<void> {
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAXIMUM_DELIVERY_RESPONSE_BYTES) {
        throw new Error("Trusted external action receiver response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function intentEvidence(
  intents: ParsedExternalActionIntent[],
  status: ExternalActionIntentEvidence["status"],
  receipts: ExternalActionDeliveryReceipt[] = [],
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
