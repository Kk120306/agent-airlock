import {
  assertCanonicalJsonValue,
  canonicalize,
  parseCanonicalJson,
  utf8Bytes,
} from "./canonical.js";
import type {
  PortableEvidenceDisclosure,
  ReceiptDigest,
} from "./types.js";
import {
  assertPortableEvidenceDisclosure,
  isDigest,
} from "./validation.js";

export const MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY =
  "validation:986b8794f3db4d7f917881537aabe43b01fdb3c5139a994bec7d9a25513c398a";

export const MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA =
  "agent-airlock:modelark-execution-profile";

export const MODELARK_EXECUTION_PROFILE_SAFE_PROFILE =
  "airlock-control-plane:modelark:codex-cli:container:responses:generated-output";

export const MODELARK_EXECUTION_PROFILE_PREFLIGHT_MAX_AGE_MS =
  2 * 60 * 60 * 1_000;

export const MODELARK_EXECUTION_PROFILE_PREFLIGHT_FUTURE_TOLERANCE_MS = 60_000;

const MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA_VERSION = 1;
const MODELARK_EXECUTION_PROFILE_SUMMARY_MAXIMUM_BYTES = 500;
const MODELARK_EXECUTION_PROFILE_MAXIMUM_ATTEMPTS = 4;
const MODELARK_EXECUTION_PROFILE_MAXIMUM_REQUESTS = 16;
const MODELARK_EXECUTION_PROFILE_MAXIMUM_RETRY_DELAY_MS = 15_000;

const ATTESTATION_KEYS = [
  "schemaVersion",
  "attestation",
  "inferenceMode",
  "executor",
  "runtimeProvider",
  "providerProtocol",
  "modelCommitment",
  "preflight",
] as const;

const PREFLIGHT_KEYS = [
  "checkedAt",
  "generatedAssistantOutput",
  "endpointOriginCommitment",
  "attemptCount",
  "requestCount",
  "retryDelayMs",
] as const;

const DISCLOSURE_CLAIM_KEYS = [
  "schema",
  "schemaVersion",
  "profile",
  "modelCommitment",
  "checkedAt",
  "endpointOriginCommitment",
  "attemptCount",
  "requestCount",
  "retryDelayMs",
] as const;

export interface ModelArkExecutionProfileDisclosureClaim {
  schema: typeof MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA;
  schemaVersion: 1;
  profile: typeof MODELARK_EXECUTION_PROFILE_SAFE_PROFILE;
  modelCommitment: ReceiptDigest;
  checkedAt: string;
  endpointOriginCommitment: ReceiptDigest;
  attemptCount: number;
  requestCount: number;
  retryDelayMs: number;
}

export function buildModelArkExecutionProfileDisclosureSummary(
  attestationValue: unknown,
): string {
  assertCanonicalJsonValue(attestationValue);
  const attestation = asRecord(
    attestationValue,
    "ModelArk execution-profile attestation",
  );
  assertExactKeys(
    attestation,
    ATTESTATION_KEYS,
    "ModelArk execution-profile attestation",
  );
  if (
    attestation.schemaVersion !== 2 ||
    attestation.attestation !== "airlock-control-plane" ||
    attestation.inferenceMode !== "modelark" ||
    attestation.executor !== "codex-cli" ||
    attestation.runtimeProvider !== "container" ||
    attestation.providerProtocol !== "responses"
  ) {
    throw new Error("ModelArk execution-profile attestation is not the safe profile");
  }

  const preflight = asRecord(
    attestation.preflight,
    "ModelArk execution-profile preflight",
  );
  assertExactKeys(
    preflight,
    PREFLIGHT_KEYS,
    "ModelArk execution-profile preflight",
  );
  if (preflight.generatedAssistantOutput !== true) {
    throw new Error(
      "ModelArk execution-profile preflight did not attest generated assistant output",
    );
  }

  const claim = buildClaim({
    modelCommitment: requireDigest(
      attestation.modelCommitment,
      "ModelArk model commitment",
    ),
    checkedAt: requireCanonicalTimestamp(
      preflight.checkedAt,
      "ModelArk preflight timestamp",
    ),
    endpointOriginCommitment: requireDigest(
      preflight.endpointOriginCommitment,
      "ModelArk endpoint-origin commitment",
    ),
    attemptCount: requireBoundedInteger(
      preflight.attemptCount,
      1,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_ATTEMPTS,
      "ModelArk preflight attempt count",
    ),
    requestCount: requireBoundedInteger(
      preflight.requestCount,
      1,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_REQUESTS,
      "ModelArk preflight request count",
    ),
    retryDelayMs: requireBoundedInteger(
      preflight.retryDelayMs,
      0,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_RETRY_DELAY_MS,
      "ModelArk preflight retry delay",
    ),
  });
  assertRequestCountCoversAttempts(claim);
  const summary = canonicalize(claim);
  if (utf8Bytes(summary).length > MODELARK_EXECUTION_PROFILE_SUMMARY_MAXIMUM_BYTES) {
    throw new Error("ModelArk execution-profile disclosure exceeds the receipt limit");
  }
  return summary;
}

export function parseModelArkExecutionProfileDisclosureSummary(
  summary: string,
): ModelArkExecutionProfileDisclosureClaim {
  if (
    typeof summary !== "string" ||
    !summary ||
    utf8Bytes(summary).length > MODELARK_EXECUTION_PROFILE_SUMMARY_MAXIMUM_BYTES
  ) {
    throw new Error("ModelArk execution-profile disclosure summary is invalid");
  }
  const value = parseCanonicalJson(
    summary,
    MODELARK_EXECUTION_PROFILE_SUMMARY_MAXIMUM_BYTES,
  );
  if (canonicalize(value) !== summary) {
    throw new Error(
      "ModelArk execution-profile disclosure summary is not canonical JSON",
    );
  }

  const claim = asRecord(value, "ModelArk execution-profile disclosure claim");
  assertExactKeys(
    claim,
    DISCLOSURE_CLAIM_KEYS,
    "ModelArk execution-profile disclosure claim",
  );
  if (
    claim.schema !== MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA ||
    claim.schemaVersion !== MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA_VERSION ||
    claim.profile !== MODELARK_EXECUTION_PROFILE_SAFE_PROFILE
  ) {
    throw new Error("ModelArk execution-profile disclosure profile is unsupported");
  }

  const parsed = buildClaim({
    modelCommitment: requireDigest(
      claim.modelCommitment,
      "ModelArk model commitment",
    ),
    checkedAt: requireCanonicalTimestamp(
      claim.checkedAt,
      "ModelArk preflight timestamp",
    ),
    endpointOriginCommitment: requireDigest(
      claim.endpointOriginCommitment,
      "ModelArk endpoint-origin commitment",
    ),
    attemptCount: requireBoundedInteger(
      claim.attemptCount,
      1,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_ATTEMPTS,
      "ModelArk preflight attempt count",
    ),
    requestCount: requireBoundedInteger(
      claim.requestCount,
      1,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_REQUESTS,
      "ModelArk preflight request count",
    ),
    retryDelayMs: requireBoundedInteger(
      claim.retryDelayMs,
      0,
      MODELARK_EXECUTION_PROFILE_MAXIMUM_RETRY_DELAY_MS,
      "ModelArk preflight retry delay",
    ),
  });
  assertRequestCountCoversAttempts(parsed);
  return parsed;
}

export function verifyModelArkExecutionProfileDisclosure(
  disclosureValue: unknown,
  decidedAt: string,
): ModelArkExecutionProfileDisclosureClaim {
  assertPortableEvidenceDisclosure(disclosureValue);
  const disclosure: PortableEvidenceDisclosure = disclosureValue;
  const leaf = disclosure.leaf;
  if (
    leaf.identity !== MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY ||
    leaf.category !== "validation" ||
    leaf.status !== "passed" ||
    leaf.required !== true ||
    leaf.durationMs !== 0
  ) {
    throw new Error(
      "ModelArk execution-profile disclosure leaf does not prove the required safe Validation",
    );
  }
  if (leaf.summary === null) {
    throw new Error("ModelArk execution-profile disclosure summary is missing");
  }
  const claim = parseModelArkExecutionProfileDisclosureSummary(leaf.summary);
  const decisionTime = requireCanonicalTimestamp(
    decidedAt,
    "Portable receipt decision timestamp",
  );
  const ageAtDecisionMs =
    Date.parse(decisionTime) - Date.parse(claim.checkedAt);
  if (
    ageAtDecisionMs <
      -MODELARK_EXECUTION_PROFILE_PREFLIGHT_FUTURE_TOLERANCE_MS ||
    ageAtDecisionMs > MODELARK_EXECUTION_PROFILE_PREFLIGHT_MAX_AGE_MS
  ) {
    throw new Error(
      "ModelArk execution-profile preflight is outside the signed decision-time window",
    );
  }
  return claim;
}

function buildClaim(
  values: Omit<
    ModelArkExecutionProfileDisclosureClaim,
    "schema" | "schemaVersion" | "profile"
  >,
): ModelArkExecutionProfileDisclosureClaim {
  return {
    schema: MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA,
    schemaVersion: MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA_VERSION,
    profile: MODELARK_EXECUTION_PROFILE_SAFE_PROFILE,
    ...values,
  };
}

function assertRequestCountCoversAttempts(
  claim: ModelArkExecutionProfileDisclosureClaim,
): void {
  if (claim.requestCount < claim.attemptCount) {
    throw new Error(
      "ModelArk preflight request count cannot be lower than its attempt count",
    );
  }
}

function requireDigest(value: unknown, name: string): ReceiptDigest {
  if (!isDigest(value)) {
    throw new Error(`${name} must be a SHA-256 commitment`);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length !== 24) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${name} is outside the supported bounds`);
  }
  return value as number;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}
