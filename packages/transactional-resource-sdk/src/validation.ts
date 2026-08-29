import { createHash } from "node:crypto";
import type {
  JsonObject,
  JsonValue,
  PreparedResource,
  ResourceCapabilityClaim,
  ResourceCandidateHandle,
  ResourceChangeEvidence,
  ResourceDiscardResult,
  ResourcePromotionPlan,
  ResourceProviderManifest,
  ResourceQuarantineHandle,
  ResourceReconciliationResult,
  ResourceRuntimeBinding,
  ResourceValidationEvidence,
  ResourceVersionReference,
  TransactionalResourceProvider,
} from "./types.js";
import { AIRLOCK_RESOURCE_FAILURE_SEMANTICS } from "./types.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const sensitiveKeyPattern =
  /(?:^|[_-])(?:api[_-]?key|auth(?:entication|orization)?|bearer|connection[_-]?string|cookie|credential|dsn|password|private[_-]?key|secret|session|token|access[_-]?token|refresh[_-]?token)(?:$|[_-])/i;
const sensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bark-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[A-Za-z0-9]{4,}\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
];

const redactionPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bark-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[A-Za-z0-9]{4,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
];

export function redactSensitiveText(input: string): string {
  let output = input;
  output = output.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  for (const pattern of redactionPatterns) {
    output = output.replace(pattern, "[REDACTED]");
  }
  output = output.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    "$1[REDACTED]@",
  );
  output = output.replace(
    /((?:api[_-]?key|authorization|connection[_-]?string|cookie|credential|dsn|password|private[_-]?key|secret|session|token)\s*[=:]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
  return output;
}

const capabilityKeys = [
  "schemaVersion",
  "isolation",
  "promotionVisibility",
  "promotionIdempotency",
  "reconciliation",
  "quarantine",
  "discard",
  "repair",
  "runtimeAccess",
] as const;

const failureSemanticKeys = [
  "schemaVersion",
  "prepare",
  "describe",
  "validate",
  "planPromotion",
  "promote",
  "quarantine",
  "discard",
  "reconcile",
] as const;

const manifestKeys = [
  "sdkSchemaVersion",
  "providerId",
  "resourceKind",
  "label",
  "capabilities",
  "failureSemantics",
  "metadata",
] as const;

const versionReferenceKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "versionId",
  "fingerprint",
  "metadata",
] as const;

const candidateHandleKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "candidateId",
  "sourceVersionId",
  "sourceFingerprint",
  "candidateFingerprint",
  "metadata",
] as const;

const runtimeBindingKeys = ["schemaVersion", "relativePath", "access"] as const;
const preparedResourceKeys = ["schemaVersion", "candidate", "runtimeBinding"] as const;
const changeEvidenceKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "changed",
  "fingerprintBefore",
  "fingerprintCandidate",
  "summary",
  "metadata",
] as const;
const validationEvidenceKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "name",
  "status",
  "required",
  "durationMs",
  "summary",
  "output",
] as const;
const promotionPlanKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "runId",
  "idempotencyKey",
  "sourceVersionId",
  "sourceFingerprint",
  "targetVersionId",
  "targetFingerprint",
  "metadata",
] as const;
const quarantineHandleKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "runId",
  "quarantineId",
  "candidateFingerprint",
  "metadata",
] as const;
const discardResultKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "discarded",
  "alreadyDiscarded",
  "evidenceRetained",
] as const;
const reconciliationResultKeys = [
  "schemaVersion",
  "providerId",
  "resourceKind",
  "status",
  "version",
  "summary",
] as const;

export interface RequiredResourceEligibility {
  eligible: boolean;
  reasons: string[];
}

export function parseResourceProviderManifest(
  input: unknown,
): ResourceProviderManifest {
  const value = expectObject(input, "Resource Provider manifest");
  expectExactKeys(value, manifestKeys, "Resource Provider manifest");
  if (value.sdkSchemaVersion !== 1) {
    throw new Error("Resource Provider manifest schema version must be 1");
  }
  const providerId = expectIdentifier(value.providerId, "providerId");
  const resourceKind = expectIdentifier(value.resourceKind, "resourceKind");
  const label = expectCredentialFreeString(value.label, "label", 1, 80);
  const capabilities = parseCapabilityClaim(value.capabilities);
  const failureSemantics = parseFailureSemantics(value.failureSemantics);
  const metadata = validateMetadata(value.metadata, "manifest metadata");
  const parsed = {
    sdkSchemaVersion: 1,
    providerId,
    resourceKind,
    label,
    capabilities,
    failureSemantics,
    metadata,
  } satisfies ResourceProviderManifest;
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > 32_768) {
    throw new Error("Resource Provider manifest exceeds 32768 bytes");
  }
  return parsed;
}

export function validateTransactionalResourceProvider(
  provider: TransactionalResourceProvider,
): ResourceProviderManifest {
  if (!provider || typeof provider !== "object") {
    throw new Error("Resource Provider must be an object");
  }
  const manifest = parseResourceProviderManifest(provider.manifest);
  const hooks = [
    "prepare",
    "describe",
    "validate",
    "planPromotion",
    "promote",
    "quarantine",
    "discard",
    "reconcile",
  ] as const;
  for (const hook of hooks) {
    if (typeof provider[hook] !== "function") {
      throw new Error("Resource Provider is missing lifecycle hook " + hook);
    }
  }
  const runtimeAccess = manifest.capabilities.runtimeAccess;
  if (runtimeAccess === "read-write" && manifest.capabilities.isolation === "deferred-intent") {
    throw new Error(
      "A deferred-intent Resource Provider cannot claim a read-write Runtime binding",
    );
  }
  return manifest;
}

export function parseResourceVersionReference(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceVersionReference {
  const value = expectLifecycleObject(
    input,
    versionReferenceKeys,
    "Resource version reference",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    versionId: expectOpaqueIdentifier(value.versionId, "versionId"),
    fingerprint: assertResourceFingerprint(value.fingerprint, "fingerprint"),
    metadata: validateMetadata(value.metadata, "version metadata"),
  } satisfies ResourceVersionReference;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parseResourceCandidateHandle(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceCandidateHandle {
  const value = expectLifecycleObject(
    input,
    candidateHandleKeys,
    "Resource candidate handle",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    candidateId: expectOpaqueIdentifier(value.candidateId, "candidateId"),
    sourceVersionId: expectOpaqueIdentifier(value.sourceVersionId, "sourceVersionId"),
    sourceFingerprint: assertResourceFingerprint(
      value.sourceFingerprint,
      "sourceFingerprint",
    ),
    candidateFingerprint: assertResourceFingerprint(
      value.candidateFingerprint,
      "candidateFingerprint",
    ),
    metadata: validateMetadata(value.metadata, "candidate metadata"),
  } satisfies ResourceCandidateHandle;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parsePreparedResource(
  input: unknown,
  manifest: ResourceProviderManifest,
): PreparedResource {
  const value = expectLifecycleObject(input, preparedResourceKeys, "Prepared resource");
  const candidate = parseResourceCandidateHandle(value.candidate, manifest);
  const runtimeBinding =
    value.runtimeBinding === null
      ? null
      : parseRuntimeBinding(value.runtimeBinding, manifest);
  if (manifest.capabilities.runtimeAccess === "none" && runtimeBinding) {
    throw new Error("Resource Provider with no Runtime access returned a binding");
  }
  if (manifest.capabilities.runtimeAccess !== "none" && !runtimeBinding) {
    throw new Error("Resource Provider omitted its declared Runtime binding");
  }
  return { schemaVersion: 1, candidate, runtimeBinding };
}

export function parseResourceChangeEvidence(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceChangeEvidence {
  const value = expectLifecycleObject(
    input,
    changeEvidenceKeys,
    "Resource change evidence",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    changed: expectBoolean(value.changed, "changed"),
    fingerprintBefore: assertResourceFingerprint(
      value.fingerprintBefore,
      "fingerprintBefore",
    ),
    fingerprintCandidate: assertResourceFingerprint(
      value.fingerprintCandidate,
      "fingerprintCandidate",
    ),
    summary: expectCredentialFreeString(value.summary, "summary", 1, 512),
    metadata: validateMetadata(value.metadata, "change metadata"),
  } satisfies ResourceChangeEvidence;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parseResourceValidationEvidence(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceValidationEvidence {
  const value = expectLifecycleObject(
    input,
    validationEvidenceKeys,
    "Resource Validation evidence",
  );
  const output =
    value.output === null
      ? null
      : expectCredentialFreeString(value.output, "output", 0, 16_384);
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    name: expectIdentifier(value.name, "Validation name"),
    status: expectEnum(value.status, ["passed", "failed", "error"], "status"),
    required: expectBoolean(value.required, "required"),
    durationMs: expectInteger(value.durationMs, "durationMs", 0, 300_000),
    summary: expectCredentialFreeString(value.summary, "summary", 1, 512),
    output,
  } satisfies ResourceValidationEvidence;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parseResourcePromotionPlan(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourcePromotionPlan {
  const value = expectLifecycleObject(
    input,
    promotionPlanKeys,
    "Resource Promotion plan",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    runId: expectOpaqueIdentifier(value.runId, "runId"),
    idempotencyKey: expectOpaqueIdentifier(value.idempotencyKey, "idempotencyKey", 256),
    sourceVersionId: expectOpaqueIdentifier(value.sourceVersionId, "sourceVersionId"),
    sourceFingerprint: assertResourceFingerprint(
      value.sourceFingerprint,
      "sourceFingerprint",
    ),
    targetVersionId: expectOpaqueIdentifier(value.targetVersionId, "targetVersionId"),
    targetFingerprint: assertResourceFingerprint(
      value.targetFingerprint,
      "targetFingerprint",
    ),
    metadata: validateMetadata(value.metadata, "Promotion plan metadata"),
  } satisfies ResourcePromotionPlan;
  assertManifestIdentity(result, manifest);
  return result;
}

export function assertResourcePromotionPlanMatchesCandidate(input: {
  plan: ResourcePromotionPlan;
  candidate: ResourceCandidateHandle;
  runId: string;
  candidateFingerprint: string;
}): void {
  const { plan, candidate, runId, candidateFingerprint } = input;
  if (
    plan.runId !== runId ||
    plan.sourceVersionId !== candidate.sourceVersionId ||
    plan.sourceFingerprint !== candidate.sourceFingerprint ||
    plan.targetFingerprint !== candidateFingerprint ||
    (plan.targetVersionId === plan.sourceVersionId &&
      plan.targetFingerprint !== plan.sourceFingerprint) ||
    plan.idempotencyKey !==
      createResourcePromotionIdempotencyKey({
        runId,
        providerId: plan.providerId,
        resourceKind: plan.resourceKind,
      })
  ) {
    throw new Error(
      "Resource Promotion plan contradicts the prepared Candidate or stable idempotency key",
    );
  }
}

export function parseResourceQuarantineHandle(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceQuarantineHandle {
  const value = expectLifecycleObject(
    input,
    quarantineHandleKeys,
    "Resource Quarantine handle",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    runId: expectOpaqueIdentifier(value.runId, "runId"),
    quarantineId: expectOpaqueIdentifier(value.quarantineId, "quarantineId"),
    candidateFingerprint: assertResourceFingerprint(
      value.candidateFingerprint,
      "candidateFingerprint",
    ),
    metadata: validateMetadata(value.metadata, "Quarantine metadata"),
  } satisfies ResourceQuarantineHandle;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parseResourceDiscardResult(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceDiscardResult {
  const value = expectLifecycleObject(
    input,
    discardResultKeys,
    "Resource Discard result",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    discarded: expectBoolean(value.discarded, "discarded"),
    alreadyDiscarded: expectBoolean(value.alreadyDiscarded, "alreadyDiscarded"),
    evidenceRetained: expectBoolean(value.evidenceRetained, "evidenceRetained"),
  } satisfies ResourceDiscardResult;
  assertManifestIdentity(result, manifest);
  return result;
}

export function parseResourceReconciliationResult(
  input: unknown,
  manifest?: ResourceProviderManifest,
): ResourceReconciliationResult {
  const value = expectLifecycleObject(
    input,
    reconciliationResultKeys,
    "Resource reconciliation result",
  );
  const result = {
    schemaVersion: 1,
    providerId: expectIdentifier(value.providerId, "providerId"),
    resourceKind: expectIdentifier(value.resourceKind, "resourceKind"),
    status: expectEnum(
      value.status,
      ["not-installed", "installed", "canonical", "contradiction"],
      "status",
    ),
    version:
      value.version === null
        ? null
        : parseResourceVersionReference(value.version, manifest),
    summary: expectCredentialFreeString(value.summary, "summary", 1, 512),
  } satisfies ResourceReconciliationResult;
  assertManifestIdentity(result, manifest);
  if (
    (result.status === "installed" || result.status === "canonical") &&
    !result.version
  ) {
    throw new Error("Installed reconciliation result must include a version");
  }
  if (
    (result.status === "not-installed" || result.status === "contradiction") &&
    result.version
  ) {
    throw new Error(result.status + " reconciliation result cannot include a version");
  }
  return result;
}

export function assessRequiredResourceEligibility(
  claim: ResourceCapabilityClaim,
): RequiredResourceEligibility {
  const reasons: string[] = [];
  if (claim.promotionVisibility !== "canonical-manifest") {
    reasons.push(
      "Required all-or-nothing resources must use canonical-manifest Promotion visibility",
    );
  }
  if (claim.promotionIdempotency !== "run-keyed") {
    reasons.push("Promotion is not run-keyed and idempotent");
  }
  if (claim.reconciliation !== "forward") {
    reasons.push("Forward reconciliation is not supported");
  }
  if (claim.quarantine !== "retained") {
    reasons.push("Mutable Quarantine is not retained");
  }
  if (claim.discard !== "idempotent") {
    reasons.push("Discard is not idempotent");
  }
  if (claim.repair !== "fork") {
    reasons.push("Repair cannot fork the retained resource candidate");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function validateMetadata(input: unknown, name: string): JsonObject {
  const root = expectObject(input, name);
  const stats = { entries: 0 };
  const value = validateJsonObject(root, name, 0, stats);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 16_384) throw new Error(name + " exceeds 16384 bytes");
  return value;
}

export function assertResourceFingerprint(value: unknown, name: string): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new Error(name + " must be a lowercase SHA-256 fingerprint");
  }
  return value;
}

export function createResourcePromotionIdempotencyKey(input: {
  runId: string;
  providerId: string;
  resourceKind: string;
}): string {
  const runId = expectOpaqueIdentifier(input.runId, "runId");
  const providerId = expectIdentifier(input.providerId, "providerId");
  const resourceKind = expectIdentifier(input.resourceKind, "resourceKind");
  return (
    "airlock:v1:" +
    createHash("sha256")
      .update(JSON.stringify({ providerId, resourceKind, runId }))
      .digest("hex")
  );
}

function parseCapabilityClaim(input: unknown): ResourceCapabilityClaim {
  const value = expectObject(input, "Capability Claim");
  expectExactKeys(value, capabilityKeys, "Capability Claim");
  if (value.schemaVersion !== 1) {
    throw new Error("Capability Claim schema version must be 1");
  }
  return {
    schemaVersion: 1,
    isolation: expectEnum(
      value.isolation,
      ["candidate-copy", "provider-branch", "deferred-intent"],
      "isolation",
    ),
    promotionVisibility: expectEnum(
      value.promotionVisibility,
      ["canonical-manifest", "post-promotion-reconciled", "best-effort"],
      "promotionVisibility",
    ),
    promotionIdempotency: expectEnum(
      value.promotionIdempotency,
      ["run-keyed", "none"],
      "promotionIdempotency",
    ),
    reconciliation: expectEnum(
      value.reconciliation,
      ["forward", "observe-only", "none"],
      "reconciliation",
    ),
    quarantine: expectEnum(
      value.quarantine,
      ["retained", "evidence-only"],
      "quarantine",
    ),
    discard: expectEnum(
      value.discard,
      ["idempotent", "best-effort"],
      "discard",
    ),
    repair: expectEnum(value.repair, ["fork", "unsupported"], "repair"),
    runtimeAccess: expectEnum(
      value.runtimeAccess,
      ["none", "read-only", "read-write"],
      "runtimeAccess",
    ),
  };
}

function parseFailureSemantics(input: unknown) {
  const value = expectObject(input, "Resource failure semantics");
  expectExactKeys(value, failureSemanticKeys, "Resource failure semantics");
  for (const [key, expected] of Object.entries(
    AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  )) {
    if (value[key] !== expected) {
      throw new Error(
        "Resource failure semantics " + key + " must be " + String(expected),
      );
    }
  }
  return structuredClone(AIRLOCK_RESOURCE_FAILURE_SEMANTICS);
}

function validateJsonObject(
  input: Record<string, unknown>,
  name: string,
  depth: number,
  stats: { entries: number },
): JsonObject {
  if (depth > 8) throw new Error(name + " exceeds maximum JSON depth 8");
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    stats.entries += 1;
    if (stats.entries > 128) throw new Error(name + " exceeds 128 entries");
    if (key.length === 0 || key.length > 80) {
      throw new Error(name + " contains an invalid key length");
    }
    const normalizedKey = key.replace(/[A-Z]/g, (character) => "_" + character.toLowerCase());
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      sensitiveKeyPattern.test(normalizedKey)
    ) {
      throw new Error(name + " contains sensitive key " + key);
    }
    result[key] = validateJsonValue(value, name + "." + key, depth + 1, stats);
  }
  return result;
}

function parseRuntimeBinding(
  input: unknown,
  manifest: ResourceProviderManifest,
): ResourceRuntimeBinding {
  const value = expectLifecycleObject(
    input,
    runtimeBindingKeys,
    "Resource Runtime binding",
  );
  const relativePath = expectCredentialFreeString(
    value.relativePath,
    "relativePath",
    1,
    256,
  );
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Resource Runtime binding must be a safe relative POSIX path");
  }
  const access = expectEnum(value.access, ["read-only", "read-write"], "access");
  if (access !== manifest.capabilities.runtimeAccess) {
    throw new Error("Resource Runtime binding contradicts its Capability Claim");
  }
  return { schemaVersion: 1, relativePath, access };
}

function expectLifecycleObject(
  input: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const value = expectObject(input, name);
  expectExactKeys(value, keys, name);
  if (value.schemaVersion !== 1) throw new Error(name + " schema version must be 1");
  return value;
}

function assertManifestIdentity(
  value: { providerId: string; resourceKind: string },
  manifest?: ResourceProviderManifest,
): void {
  if (!manifest) return;
  if (
    value.providerId !== manifest.providerId ||
    value.resourceKind !== manifest.resourceKind
  ) {
    throw new Error("Resource lifecycle value contradicts its provider identity");
  }
}

function validateJsonValue(
  input: unknown,
  name: string,
  depth: number,
  stats: { entries: number },
): JsonValue {
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(name + " must be finite");
    return input;
  }
  if (typeof input === "string") {
    if (input.length > 4096) throw new Error(name + " exceeds 4096 characters");
    if (sensitiveValuePatterns.some((pattern) => pattern.test(input))) {
      throw new Error(name + " contains a credential-like value");
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (depth > 8) throw new Error(name + " exceeds maximum JSON depth 8");
    if (input.length > 128) throw new Error(name + " exceeds 128 array items");
    return input.map((item, index) => {
      stats.entries += 1;
      if (stats.entries > 128) throw new Error(name + " exceeds 128 entries");
      return validateJsonValue(item, name + "[" + index + "]", depth + 1, stats);
    });
  }
  if (isPlainObject(input)) {
    return validateJsonObject(input, name, depth, stats);
  }
  throw new Error(name + " must contain only JSON-safe values");
}

function expectObject(input: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(input)) throw new Error(name + " must be a plain object");
  return input;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function expectExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) throw new Error(name + " has unknown field " + key);
  }
  for (const key of keys) {
    if (!(key in input)) throw new Error(name + " is missing field " + key);
  }
}

function expectIdentifier(input: unknown, name: string): string {
  if (
    typeof input !== "string" ||
    input.length > 64 ||
    !identifierPattern.test(input)
  ) {
    throw new Error(name + " must be a safe lowercase identifier");
  }
  assertCredentialFree(input, name);
  return input;
}

function expectOpaqueIdentifier(
  input: unknown,
  name: string,
  maximum = 128,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
  ) {
    throw new Error(name + " must be a bounded opaque identifier");
  }
  assertCredentialFree(input, name);
  return input;
}

function expectBoolean(input: unknown, name: string): boolean {
  if (typeof input !== "boolean") throw new Error(name + " must be a boolean");
  return input;
}

function expectInteger(
  input: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw new Error(
      name + " must be an integer between " + minimum + " and " + maximum,
    );
  }
  return input;
}

function expectString(
  input: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof input !== "string" ||
    input.length < minimum ||
    input.length > maximum
  ) {
    throw new Error(
      name + " must contain between " + minimum + " and " + maximum + " characters",
    );
  }
  return input;
}

function expectCredentialFreeString(
  input: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  const value = expectString(input, name, minimum, maximum);
  assertCredentialFree(value, name);
  return value;
}

function assertCredentialFree(value: string, name: string): void {
  if (
    sensitiveValuePatterns.some((pattern) => pattern.test(value)) ||
    redactSensitiveText(value) !== value
  ) {
    throw new Error(name + " contains a credential-like value");
  }
}

function expectEnum<const T extends readonly string[]>(
  input: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw new Error(name + " must be one of " + values.join(", "));
  }
  return input;
}
