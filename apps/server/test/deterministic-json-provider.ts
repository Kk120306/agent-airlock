import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  createResourcePromotionIdempotencyKey,
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

interface CandidateRecord {
  filePath: string;
  source: ResourceVersionReference;
}

export class DeterministicJsonProvider implements TransactionalResourceProvider {
  readonly manifest: ResourceProviderManifest = {
    sdkSchemaVersion: 1,
    providerId: "portable-json",
    resourceKind: "json-object",
    label: "Portable JSON object",
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
    metadata: {},
  };

  readonly versions = new Map<string, JsonValue>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly quarantines = new Map<string, JsonValue>();
  private readonly discardedRuns = new Set<string>();

  async prepare(context: ResourcePrepareContext) {
    const sourceValue = context.repairSource
      ? this.quarantines.get(context.repairSource.quarantineId)
      : this.versions.get(context.source.versionId);
    if (sourceValue === undefined) throw new Error("Source JSON object is unavailable");
    const candidateId = "candidate-" + context.runId;
    const filePath = path.join(context.candidateResourcePath, "object.json");
    await writeFile(filePath, JSON.stringify(sourceValue) + "\n", "utf8");
    this.candidates.set(candidateId, {
      filePath,
      source: structuredClone(context.source),
    });
    return {
      schemaVersion: 1 as const,
      candidate: {
        schemaVersion: 1 as const,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
        candidateId,
        sourceVersionId: context.source.versionId,
        sourceFingerprint: context.source.fingerprint,
        candidateFingerprint: jsonFingerprint(sourceValue),
        metadata: {},
      },
      runtimeBinding: {
        schemaVersion: 1 as const,
        relativePath: "object.json",
        access: "read-write" as const,
      },
    };
  }

  async describe(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const candidateFingerprint = await fileFingerprint(candidate.filePath);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      changed: candidateFingerprint !== candidate.source.fingerprint,
      fingerprintBefore: candidate.source.fingerprint,
      fingerprintCandidate: candidateFingerprint,
      summary: "Candidate JSON object was compared with its Canonical version",
      metadata: {},
    };
  }

  async validate(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const value = JSON.parse(await readFile(candidate.filePath, "utf8")) as unknown;
    const valid =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).release === "string";
    return [
      {
        schemaVersion: 1 as const,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
        name: "object-shape",
        status: valid ? ("passed" as const) : ("failed" as const),
        required: true,
        durationMs: 1,
        summary: valid
          ? "Candidate object has a release label"
          : "Candidate object is missing a release label",
        output: null,
      },
    ];
  }

  async planPromotion(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      runId: context.runId,
      idempotencyKey: createResourcePromotionIdempotencyKey({
        runId: context.runId,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
      }),
      sourceVersionId: candidate.source.versionId,
      sourceFingerprint: candidate.source.fingerprint,
      targetVersionId: "version-" + context.runId,
      targetFingerprint: await fileFingerprint(candidate.filePath),
      metadata: {},
    };
  }

  async promote(context: ResourcePromotionContext) {
    this.requireCandidate(context.candidate.candidateId);
    const value = JSON.parse(
      await readFile(path.join(context.candidateResourcePath, "object.json"), "utf8"),
    ) as JsonValue;
    const existing = this.versions.get(context.plan.targetVersionId);
    if (
      existing !== undefined &&
      stableJson(existing) !== stableJson(value)
    ) {
      throw new Error("Promotion replay contradicted the installed JSON object");
    }
    this.versions.set(context.plan.targetVersionId, value);
    return jsonVersionReference(context.plan.targetVersionId, value);
  }

  async quarantine(context: ResourceQuarantineContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const value = JSON.parse(await readFile(candidate.filePath, "utf8")) as JsonValue;
    const quarantineId = "quarantine-" + context.runId;
    this.quarantines.set(quarantineId, value);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      runId: context.runId,
      quarantineId,
      candidateFingerprint: jsonFingerprint(value),
      metadata: {},
    };
  }

  async discard(context: ResourceDiscardContext) {
    const alreadyDiscarded = this.discardedRuns.has(context.runId);
    if (context.candidate) this.candidates.delete(context.candidate.candidateId);
    if (context.quarantine) this.quarantines.delete(context.quarantine.quarantineId);
    this.discardedRuns.add(context.runId);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      discarded: true,
      alreadyDiscarded,
      evidenceRetained: true,
    };
  }

  async reconcile(context: ResourceReconcileContext) {
    const value = this.versions.get(context.plan.targetVersionId);
    return value === undefined
      ? {
          schemaVersion: 1 as const,
          providerId: this.manifest.providerId,
          resourceKind: this.manifest.resourceKind,
          status: "not-installed" as const,
          version: null,
          summary: "Immutable JSON object version is not installed",
        }
      : {
          schemaVersion: 1 as const,
          providerId: this.manifest.providerId,
          resourceKind: this.manifest.resourceKind,
          status: "installed" as const,
          version: jsonVersionReference(context.plan.targetVersionId, value),
          summary: "Immutable JSON object version is installed",
        };
  }

  private requireCandidate(candidateId: string): CandidateRecord {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error("Candidate JSON object is unavailable");
    return candidate;
  }
}

export function jsonVersionReference(
  versionId: string,
  value: JsonValue,
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId: "portable-json",
    resourceKind: "json-object",
    versionId,
    fingerprint: jsonFingerprint(value),
    metadata: {},
  };
}

export function jsonFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function fileFingerprint(filePath: string): Promise<string> {
  return jsonFingerprint(JSON.parse(await readFile(filePath, "utf8")));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
