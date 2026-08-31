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
import { SensitiveLiteralFilter } from "./sensitive-literals.js";

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

export interface ExternalActionDispatcherScope {
  schemaVersion: 1;
  deliveryMode: ExternalActionDeliveryMode;
  consumerScopeDigest: string;
}

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
  readonly scope: ExternalActionDispatcherScope;
  initialize(): Promise<void>;
  assertOperational(): void;
  dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<ExternalActionDeliveryReceipt[]>;
  list(): Promise<ExternalActionDeliveryReceipt[]>;
}

interface DeliveryDatabase {
  version: 2;
  consumerId: string;
  deliveries: ExternalActionDeliveryReceipt[];
}

interface ParsedDeliveryDatabase {
  version: 1 | 2;
  consumerId: string | null;
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

const externalActionDispatcherScopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryMode: z.enum(["atomic-local-store", "idempotent-http"]),
    consumerScopeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const externalActionConsumerIdentityResponseSchema = z
  .object({
    schema: z.literal("agent-airlock/external-action-consumer-identity"),
    schemaVersion: z.literal(1),
    deliveryMode: z.literal("idempotent-http"),
    consumerId: z.string().uuid(),
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
): ParsedDeliveryDatabase {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Unsupported delivery receipt store format");
  }
  const candidate = value as {
    version?: unknown;
    consumerId?: unknown;
    deliveries?: unknown;
  };
  const expectedKeys =
    candidate.version === 1
      ? "deliveries\0version"
      : "consumerId\0deliveries\0version";
  if (
    (candidate.version !== 1 && candidate.version !== 2) ||
    Object.keys(value).sort().join("\0") !== expectedKeys ||
    !Array.isArray(candidate.deliveries)
  ) {
    throw new Error("Unsupported delivery receipt store format");
  }
  const consumerId =
    candidate.version === 2
      ? z.string().uuid().parse(candidate.consumerId)
      : null;
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
  if (
    new Set(
      deliveries.map(
        (delivery) => delivery.runId + "\0" + delivery.intentId,
      ),
    ).size !== deliveries.length
  ) {
    throw new Error("Delivery receipt store contains duplicate action evidence");
  }
  return { version: candidate.version, consumerId, deliveries };
}

const hash = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");

export function createExternalActionDispatcherScope(
  deliveryMode: ExternalActionDeliveryMode,
  consumerIdentity: string,
): ExternalActionDispatcherScope {
  return {
    schemaVersion: 1,
    deliveryMode,
    consumerScopeDigest: hash(
      [
        "agent-airlock/external-action-consumer-scope",
        "1",
        deliveryMode,
        consumerIdentity,
      ].join("\0"),
    ),
  };
}

export function parseExternalActionDispatcherScope(
  value: unknown,
): ExternalActionDispatcherScope {
  return externalActionDispatcherScopeSchema.parse(value);
}

export function externalActionDispatcherScopesEqual(
  left: ExternalActionDispatcherScope,
  right: ExternalActionDispatcherScope,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.deliveryMode === right.deliveryMode &&
    left.consumerScopeDigest === right.consumerScopeDigest
  );
}

const boundedError = (error: unknown): string => {
  const detail =
    error instanceof z.ZodError
      ? (error.issues[0]?.message ?? "intent does not match the supported schema")
      : error instanceof Error
        ? error.message
        : "validation failed";
  return detail.slice(0, 240);
};

function assertReceiptMatchesIntent(
  receipt: ExternalActionDeliveryReceipt,
  deliveryMode: ExternalActionDeliveryMode,
  runId: string,
  intent: ParsedExternalActionIntent,
): void {
  if (
    receipt.idempotencyKey !== intent.idempotencyKey ||
    receipt.deliveryMode !== deliveryMode ||
    receipt.runId !== runId ||
    receipt.intentId !== intent.id ||
    receipt.type !== intent.type ||
    receipt.destination !== intent.payload.destination ||
    receipt.subject !== intent.payload.subject ||
    receipt.payloadHash !== intent.payloadHash
  ) {
    throw new Error(
      "Stored external action delivery receipt contains contradictory evidence",
    );
  }
}

function findReceiptForIntent(
  deliveries: ExternalActionDeliveryReceipt[],
  runId: string,
  intent: ParsedExternalActionIntent,
): ExternalActionDeliveryReceipt | undefined {
  return deliveries.find(
    (delivery) =>
      delivery.idempotencyKey === intent.idempotencyKey ||
      (delivery.runId === runId && delivery.intentId === intent.id),
  );
}

export class ExternalActionOutbox {
  private readonly sensitiveLiterals: SensitiveLiteralFilter;

  constructor(sensitiveValues: readonly string[] = []) {
    this.sensitiveLiterals = new SensitiveLiteralFilter(sensitiveValues);
  }

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
    if (this.sensitiveLiterals.contains(content)) {
      throw new Error("outbox contained a control-plane sensitive value");
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
  private scopeValue: ExternalActionDispatcherScope | null = null;
  private consumerId: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get scope(): ExternalActionDispatcherScope {
    if (!this.scopeValue) {
      throw new Error("External action dispatcher is not initialized");
    }
    return structuredClone(this.scopeValue);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!(await exists(this.filePath))) {
      const database: DeliveryDatabase = {
        version: 2,
        consumerId: randomUUID(),
        deliveries: [],
      };
      await this.persist(database);
      this.bindConsumer(database.consumerId);
    } else {
      const persisted = await this.readPersisted();
      const database: DeliveryDatabase = {
        version: 2,
        consumerId: persisted.consumerId ?? randomUUID(),
        deliveries: persisted.deliveries,
      };
      if (persisted.version === 1) await this.persist(database);
      this.bindConsumer(database.consumerId);
    }
  }

  assertOperational(): void {
    this.requireConsumerId();
  }

  async dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<MockDeliveryReceipt[]> {
    let receipts: MockDeliveryReceipt[] = [];
    const operation = this.queue.then(async () => {
      const database = await this.read();
      receipts = intents.map((intent) => {
        const existing = findReceiptForIntent(
          database.deliveries,
          runId,
          intent,
        );
        if (existing) {
          assertReceiptMatchesIntent(
            existing,
            this.deliveryMode,
            runId,
            intent,
          );
          return existing;
        }
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
    const database = await this.readPersisted();
    if (
      database.version !== 2 ||
      database.consumerId !== this.requireConsumerId()
    ) {
      throw new Error("External action consumer identity changed");
    }
    return database as DeliveryDatabase;
  }

  private async readPersisted(): Promise<ParsedDeliveryDatabase> {
    return parseDeliveryDatabase(
      JSON.parse(await readFile(this.filePath, "utf8")),
      this.deliveryMode,
      true,
    );
  }

  private bindConsumer(consumerId: string): void {
    this.consumerId = consumerId;
    this.scopeValue = createExternalActionDispatcherScope(
      this.deliveryMode,
      consumerId,
    );
  }

  private requireConsumerId(): string {
    if (!this.consumerId) {
      throw new Error("External action dispatcher is not initialized");
    }
    return this.consumerId;
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
  private scopeValue: ExternalActionDispatcherScope | null = null;
  private consumerId: string | null = null;
  private operationalError: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly filePath: string,
    private readonly allowedDestination = "demo-console",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get scope(): ExternalActionDispatcherScope {
    if (!this.scopeValue) {
      throw new Error("External action dispatcher is not initialized");
    }
    return structuredClone(this.scopeValue);
  }

  async initialize(): Promise<void> {
    this.consumerId = null;
    this.scopeValue = null;
    this.operationalError =
      "External action dispatcher initialization did not complete";
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const persisted = (await exists(this.filePath))
      ? await this.readPersisted()
      : null;
    const consumerId = await this.fetchConsumerIdentity();
    this.consumerId = consumerId;
    this.scopeValue = createExternalActionDispatcherScope(
      this.deliveryMode,
      consumerId + "\0" + this.allowedDestination,
    );
    if (
      persisted?.version === 2 &&
      persisted.consumerId !== consumerId
    ) {
      this.operationalError =
        "Trusted external action receiver identity does not match the local receipt store";
      return;
    }
    if (!persisted || persisted.version === 1) {
      await this.persist({
        version: 2,
        consumerId,
        deliveries: persisted?.deliveries ?? [],
      });
    }
    this.operationalError = null;
  }

  assertOperational(): void {
    if (!this.consumerId || !this.scopeValue) {
      throw new Error("External action dispatcher is not initialized");
    }
    if (this.operationalError) {
      throw new Error(this.operationalError);
    }
  }

  async dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<ExternalActionDeliveryReceipt[]> {
    this.assertOperational();
    let receipts: ExternalActionDeliveryReceipt[] = [];
    const operation = this.queue.then(async () => {
      const database = await this.read();
      for (const intent of intents) {
        const existing = findReceiptForIntent(
          database.deliveries,
          runId,
          intent,
        );
        if (existing) {
          assertReceiptMatchesIntent(
            existing,
            this.deliveryMode,
            runId,
            intent,
          );
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
    this.assertOperational();
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
          "x-agent-airlock-consumer-id": this.requireConsumerId(),
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
    const database = await this.readPersisted();
    if (
      database.version !== 2 ||
      database.consumerId !== this.requireConsumerId()
    ) {
      throw new Error("External action consumer identity changed");
    }
    return database as DeliveryDatabase;
  }

  private async readPersisted(): Promise<ParsedDeliveryDatabase> {
    return parseDeliveryDatabase(
      JSON.parse(await readFile(this.filePath, "utf8")),
      this.deliveryMode,
      false,
    );
  }

  private async fetchConsumerIdentity(): Promise<string> {
    const identityEndpoint = new URL(this.endpoint);
    identityEndpoint.pathname = identityEndpoint.pathname.replace(/\/$/, "") +
      "/identity";
    identityEndpoint.search = "";
    identityEndpoint.hash = "";
    let response: Response;
    try {
      response = await this.fetchImpl(identityEndpoint, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("Trusted external action receiver identity is unavailable");
    }
    if (!response.ok) {
      throw new Error(
        "Trusted external action receiver identity request failed with HTTP " +
          response.status,
      );
    }
    const source = await readBoundedResponse(response);
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      throw new Error(
        "Trusted external action receiver identity returned invalid JSON",
      );
    }
    const parsed = externalActionConsumerIdentityResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(
        "Trusted external action receiver returned invalid consumer identity",
      );
    }
    return parsed.data.consumerId;
  }

  private requireConsumerId(): string {
    if (!this.consumerId) {
      throw new Error("External action dispatcher is not initialized");
    }
    return this.consumerId;
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
