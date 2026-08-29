import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  createResourcePromotionIdempotencyKey,
  ResourceLifecycleError,
  type JsonObject,
  type JsonValue,
  type ResourceCandidateContext,
  type ResourceDiscardContext,
  type ResourcePrepareContext,
  type ResourcePromotionContext,
  type ResourceProviderManifest,
  type ResourceQuarantineContext,
  type ResourceReconcileContext,
  type ResourceVersionReference,
  type TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";
import { BoundedHttpClient } from "./http-client.js";

const providerId = "http-object";
const resourceKind = "versioned-http-object";
const candidateFilename = "object.json";

export interface HttpObjectResourceProviderOptions {
  baseUrl: string;
  socketPath?: string;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  maximumObjectBytes?: number;
  fetcher?: typeof fetch;
}

interface RemoteObjectRecord {
  id: string;
  fingerprint: string;
  value: JsonValue;
}

interface FoundResponse {
  schemaVersion: 1;
  found: boolean;
  record: RemoteObjectRecord | null;
}

interface CandidateResponse {
  schemaVersion: 1;
  candidateId: string;
  fingerprint: string;
}

interface VersionResponse {
  schemaVersion: 1;
  version: ResourceVersionReference;
}

interface QuarantineResponse {
  schemaVersion: 1;
  quarantineId: string;
  fingerprint: string;
}

interface DiscardResponse {
  schemaVersion: 1;
  discarded: boolean;
  alreadyDiscarded: boolean;
  evidenceRetained: boolean;
}

export class HttpObjectResourceProvider implements TransactionalResourceProvider {
  readonly manifest: ResourceProviderManifest = {
    sdkSchemaVersion: 1,
    providerId,
    resourceKind,
    label: "Remote versioned object",
    capabilities: {
      schemaVersion: 1,
      isolation: "provider-branch",
      promotionVisibility: "canonical-manifest",
      promotionIdempotency: "run-keyed",
      reconciliation: "forward",
      quarantine: "retained",
      discard: "idempotent",
      repair: "fork",
      runtimeAccess: "read-write",
    },
    failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
    metadata: {
      protocol: "agent-airlock-http-object-v1",
      nativeMutablePointerAtomicity: false,
      distributedAtomicCommit: false,
      paidRequest: false,
    },
  };

  private readonly client: BoundedHttpClient;
  private readonly maximumObjectBytes: number;

  constructor(options: HttpObjectResourceProviderOptions) {
    this.maximumObjectBytes = options.maximumObjectBytes ?? 65_536;
    if (
      !Number.isInteger(this.maximumObjectBytes) ||
      this.maximumObjectBytes < 256
    ) {
      throw new Error("HTTP object provider object limit must be at least 256 bytes");
    }
    this.client = new BoundedHttpClient({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs ?? 2_000,
      maximumResponseBytes: options.maximumResponseBytes ?? 131_072,
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  }

  async prepare(context: ResourcePrepareContext) {
    const source = context.repairSource
      ? await this.requireRemoteObject(
          "prepare",
          "/v1/quarantines/" + encodeURIComponent(context.repairSource.quarantineId),
          context.repairSource.candidateFingerprint,
        )
      : await this.requireRemoteObject(
          "prepare",
          "/v1/versions/" + encodeURIComponent(context.source.versionId),
          context.source.fingerprint,
        );
    this.assertRuntimeObject(source.value, "prepare");
    const candidate = await this.client.request<CandidateResponse>(
      "prepare",
      "/v1/candidates",
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          agentId: context.agentId,
          runId: context.runId,
          candidateStateId: context.candidateStateId,
          sourceVersionId: context.source.versionId,
          sourceFingerprint: context.source.fingerprint,
          value: source.value,
        }),
      },
    );
    assertExactKeys(candidate, ["schemaVersion", "candidateId", "fingerprint"]);
    if (
      candidate.schemaVersion !== 1 ||
      !isOpaqueId(candidate.candidateId) ||
      candidate.fingerprint !== fingerprint(source.value)
    ) {
      throw contractError("prepare", "Remote Candidate response contradicted its source");
    }
    await writeFile(
      path.join(context.candidateResourcePath, candidateFilename),
      stableJson(source.value) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    return {
      schemaVersion: 1 as const,
      candidate: {
        schemaVersion: 1 as const,
        providerId,
        resourceKind,
        candidateId: candidate.candidateId,
        sourceVersionId: context.source.versionId,
        sourceFingerprint: context.source.fingerprint,
        candidateFingerprint: candidate.fingerprint,
        metadata: {},
      },
      runtimeBinding: {
        schemaVersion: 1 as const,
        relativePath: candidateFilename,
        access: "read-write" as const,
      },
    };
  }

  async describe(context: ResourceCandidateContext) {
    const value = await this.readCandidate(context, "describe");
    const candidateFingerprint = fingerprint(value);
    return {
      schemaVersion: 1 as const,
      providerId,
      resourceKind,
      changed: candidateFingerprint !== context.candidate.sourceFingerprint,
      fingerprintBefore: context.candidate.sourceFingerprint,
      fingerprintCandidate: candidateFingerprint,
      summary: "Candidate JSON object was compared with its immutable source",
      metadata: {},
    };
  }

  async validate(context: ResourceCandidateContext) {
    const started = performance.now();
    try {
      const value = await this.readCandidate(context, "validate");
      const valid = isJsonObject(value);
      return [
        {
          schemaVersion: 1 as const,
          providerId,
          resourceKind,
          name: "bounded-json-object",
          status: valid ? ("passed" as const) : ("failed" as const),
          required: true,
          durationMs: Math.round(performance.now() - started),
          summary: valid
            ? "Candidate is a bounded JSON object"
            : "Candidate must be a non-null JSON object",
          output: null,
        },
      ];
    } catch (error) {
      return [
        {
          schemaVersion: 1 as const,
          providerId,
          resourceKind,
          name: "bounded-json-object",
          status: "error" as const,
          required: true,
          durationMs: Math.round(performance.now() - started),
          summary:
            error instanceof ResourceLifecycleError
              ? error.safeSummary
              : "Candidate JSON object could not be validated",
          output: null,
        },
      ];
    }
  }

  async planPromotion(context: ResourceCandidateContext) {
    const value = await this.readCandidate(context, "plan-promotion");
    const idempotencyKey = createResourcePromotionIdempotencyKey({
      runId: context.runId,
      providerId,
      resourceKind,
    });
    return {
      schemaVersion: 1 as const,
      providerId,
      resourceKind,
      runId: context.runId,
      idempotencyKey,
      sourceVersionId: context.candidate.sourceVersionId,
      sourceFingerprint: context.candidate.sourceFingerprint,
      targetVersionId:
        "version-" + createHash("sha256").update(idempotencyKey).digest("hex"),
      targetFingerprint: fingerprint(value),
      metadata: {},
    };
  }

  async promote(context: ResourcePromotionContext) {
    const value = await this.readCandidate(context, "promote");
    if (fingerprint(value) !== context.plan.targetFingerprint) {
      throw contractError("promote", "Candidate changed after Promotion planning");
    }
    const response = await this.client.request<VersionResponse>(
      "promote",
      "/v1/versions/" + encodeURIComponent(context.plan.targetVersionId),
      {
        method: "PUT",
        headers: { "idempotency-key": context.plan.idempotencyKey },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: context.runId,
          candidateId: context.candidate.candidateId,
          sourceVersionId: context.plan.sourceVersionId,
          sourceFingerprint: context.plan.sourceFingerprint,
          targetFingerprint: context.plan.targetFingerprint,
          value,
        }),
      },
    );
    return this.acceptVersionResponse(response, context.plan.targetVersionId);
  }

  async quarantine(context: ResourceQuarantineContext) {
    const value = await this.readCandidate(context, "quarantine");
    const candidateFingerprint = fingerprint(value);
    const quarantineId = "quarantine-" + context.runId;
    const response = await this.client.request<QuarantineResponse>(
      "quarantine",
      "/v1/quarantines/" + encodeURIComponent(quarantineId),
      {
        method: "PUT",
        body: JSON.stringify({
          schemaVersion: 1,
          runId: context.runId,
          candidateId: context.candidate.candidateId,
          candidateFingerprint,
          value,
        }),
      },
    );
    assertExactKeys(response, [
      "schemaVersion",
      "quarantineId",
      "fingerprint",
    ]);
    if (
      response.schemaVersion !== 1 ||
      response.quarantineId !== quarantineId ||
      response.fingerprint !== candidateFingerprint
    ) {
      throw contractError("quarantine", "Remote Quarantine response contradicted Candidate");
    }
    return {
      schemaVersion: 1 as const,
      providerId,
      resourceKind,
      runId: context.runId,
      quarantineId,
      candidateFingerprint,
      metadata: {},
    };
  }

  async discard(context: ResourceDiscardContext) {
    const response = await this.client.request<DiscardResponse>(
      "discard",
      "/v1/discards/" + encodeURIComponent(context.runId),
      {
        method: "PUT",
        body: JSON.stringify({
          schemaVersion: 1,
          candidateId: context.candidate?.candidateId ?? null,
          quarantineId: context.quarantine?.quarantineId ?? null,
        }),
      },
    );
    assertExactKeys(response, [
      "schemaVersion",
      "discarded",
      "alreadyDiscarded",
      "evidenceRetained",
    ]);
    if (
      response.schemaVersion !== 1 ||
      response.discarded !== true ||
      response.evidenceRetained !== true ||
      typeof response.alreadyDiscarded !== "boolean"
    ) {
      throw contractError("discard", "Remote Discard response was incomplete");
    }
    return {
      schemaVersion: 1 as const,
      providerId,
      resourceKind,
      discarded: true,
      alreadyDiscarded: response.alreadyDiscarded,
      evidenceRetained: true,
    };
  }

  async reconcile(context: ResourceReconcileContext) {
    const response = await this.readRemoteObject(
      "reconcile",
      "/v1/versions/" + encodeURIComponent(context.plan.targetVersionId),
    );
    if (!response.found || !response.record) {
      return {
        schemaVersion: 1 as const,
        providerId,
        resourceKind,
        status: "not-installed" as const,
        version: null,
        summary: "Planned immutable remote version is not installed",
      };
    }
    const version = versionReference(response.record.id, response.record.fingerprint);
    const expected = context.expectedVersion;
    if (
      version.versionId !== context.plan.targetVersionId ||
      version.fingerprint !== context.plan.targetFingerprint ||
      (expected &&
        (version.versionId !== expected.versionId ||
          version.fingerprint !== expected.fingerprint))
    ) {
      return {
        schemaVersion: 1 as const,
        providerId,
        resourceKind,
        status: "contradiction" as const,
        version: null,
        summary: "Installed remote version contradicts durable Promotion evidence",
      };
    }
    return {
      schemaVersion: 1 as const,
      providerId,
      resourceKind,
      status: "installed" as const,
      version,
      summary: "Installed remote version matches durable Promotion evidence",
    };
  }

  async readVersion(reference: ResourceVersionReference): Promise<JsonValue> {
    return (
      await this.requireRemoteObject(
        "reconcile",
        "/v1/versions/" + encodeURIComponent(reference.versionId),
        reference.fingerprint,
      )
    ).value;
  }

  async candidateExists(candidateId: string): Promise<boolean> {
    return (
      await this.readRemoteObject(
        "reconcile",
        "/v1/candidates/" + encodeURIComponent(candidateId),
      )
    ).found;
  }

  async quarantineExists(quarantineId: string): Promise<boolean> {
    return (
      await this.readRemoteObject(
        "reconcile",
        "/v1/quarantines/" + encodeURIComponent(quarantineId),
      )
    ).found;
  }

  private async readCandidate(
    context: ResourceCandidateContext,
    stage: ResourceLifecycleError["stage"],
  ): Promise<JsonValue> {
    let raw: string;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        path.join(context.candidateResourcePath, candidateFilename),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const details = await handle.stat();
      if (!details.isFile()) {
        throw new ResourceLifecycleError({
          stage,
          code: "candidate-corrupt",
          retryable: false,
          safeSummary: "HTTP object Candidate is not a regular file",
        });
      }
      if (details.size > this.maximumObjectBytes) {
        throw new ResourceLifecycleError({
          stage,
          code: "response-too-large",
          retryable: false,
          safeSummary: "HTTP object Candidate exceeds its byte limit",
        });
      }
      raw = await handle.readFile("utf8");
    } catch (error) {
      if (error instanceof ResourceLifecycleError) throw error;
      throw new ResourceLifecycleError({
        stage,
        code: "candidate-missing",
        retryable: false,
        safeSummary: "HTTP object Candidate file is unavailable",
        cause: error,
      });
    } finally {
      await handle?.close();
    }
    if (Buffer.byteLength(raw, "utf8") > this.maximumObjectBytes) {
      throw new ResourceLifecycleError({
        stage,
        code: "response-too-large",
        retryable: false,
        safeSummary: "HTTP object Candidate exceeds its byte limit",
      });
    }
    try {
      return validateJsonValue(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new ResourceLifecycleError({
        stage,
        code: "candidate-corrupt",
        retryable: false,
        safeSummary: "HTTP object Candidate is not bounded JSON",
        cause: error,
      });
    }
  }

  private assertRuntimeObject(
    value: JsonValue,
    stage: ResourceLifecycleError["stage"],
  ): void {
    if (!isJsonObject(value)) {
      throw new ResourceLifecycleError({
        stage,
        code: "invalid-input",
        retryable: false,
        safeSummary: "HTTP object source is not a JSON object",
      });
    }
    if (Buffer.byteLength(stableJson(value), "utf8") > this.maximumObjectBytes) {
      throw new ResourceLifecycleError({
        stage,
        code: "response-too-large",
        retryable: false,
        safeSummary: "HTTP object source exceeds its byte limit",
      });
    }
  }

  private async readRemoteObject(
    stage: ResourceLifecycleError["stage"],
    route: string,
  ): Promise<FoundResponse> {
    const response = await this.client.request<FoundResponse>(stage, route);
    assertExactKeys(response, ["schemaVersion", "found", "record"]);
    if (
      response.schemaVersion !== 1 ||
      typeof response.found !== "boolean" ||
      (response.found && !response.record) ||
      (!response.found && response.record !== null)
    ) {
      throw contractError(stage, "Remote object lookup response was invalid");
    }
    if (response.record) {
      assertExactKeys(response.record, ["id", "fingerprint", "value"]);
      if (
        !isOpaqueId(response.record.id) ||
        !/^[a-f0-9]{64}$/.test(response.record.fingerprint)
      ) {
        throw contractError(stage, "Remote object identity was invalid");
      }
      response.record.value = validateJsonValue(response.record.value);
      if (fingerprint(response.record.value) !== response.record.fingerprint) {
        throw contractError(stage, "Remote object fingerprint did not match its value");
      }
    }
    return response;
  }

  private async requireRemoteObject(
    stage: ResourceLifecycleError["stage"],
    route: string,
    expectedFingerprint: string,
  ): Promise<RemoteObjectRecord> {
    const response = await this.readRemoteObject(stage, route);
    if (!response.found || !response.record) {
      throw new ResourceLifecycleError({
        stage,
        code: "source-mismatch",
        retryable: false,
        safeSummary: "Required remote object version is unavailable",
      });
    }
    if (response.record.fingerprint !== expectedFingerprint) {
      throw new ResourceLifecycleError({
        stage,
        code: "source-mismatch",
        retryable: false,
        safeSummary: "Remote object fingerprint contradicted expected version",
      });
    }
    return response.record;
  }

  private acceptVersionResponse(
    response: VersionResponse,
    expectedVersionId: string,
  ): ResourceVersionReference {
    assertExactKeys(response, ["schemaVersion", "version"]);
    if (response.schemaVersion !== 1) {
      throw contractError("promote", "Remote version response schema was invalid");
    }
    const version = response.version;
    assertExactKeys(version, [
      "schemaVersion",
      "providerId",
      "resourceKind",
      "versionId",
      "fingerprint",
      "metadata",
    ]);
    if (
      version.schemaVersion !== 1 ||
      version.providerId !== providerId ||
      version.resourceKind !== resourceKind ||
      version.versionId !== expectedVersionId ||
      !/^[a-f0-9]{64}$/.test(version.fingerprint) ||
      !isJsonObject(version.metadata)
    ) {
      throw contractError("promote", "Remote version response contradicted Promotion plan");
    }
    return structuredClone(version);
  }
}

export function versionReference(
  versionId: string,
  versionFingerprint: string,
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId,
    resourceKind,
    versionId,
    fingerprint: versionFingerprint,
    metadata: {},
  };
}

export function fingerprint(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function validateJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new Error("JSON nesting exceeds 32 levels");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error("JSON array exceeds 1024 items");
    return value.map((item) => validateJsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1024) throw new Error("JSON object exceeds 1024 keys");
    const result: JsonObject = {};
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > 256) throw new Error("JSON key is invalid");
      result[key] = validateJsonValue(item, depth + 1);
    }
    return result;
  }
  throw new Error("Value is not JSON serializable");
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HTTP object provider response must be an object");
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("HTTP object provider response has unknown or missing fields");
  }
}

function contractError(
  stage: ResourceLifecycleError["stage"],
  summary: string,
): ResourceLifecycleError {
  return new ResourceLifecycleError({
    stage,
    code: "capability-mismatch",
    retryable: false,
    safeSummary: summary,
  });
}
