import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import type {
  PolicyAuthorityRotation,
  SignedPolicyAuthorityRotationEnvelope,
} from "./types.js";
import {
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
} from "./validation.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAXIMUM_ROTATION_BYTES = 32_768;
export const MAXIMUM_SIGNED_AUTHORITY_ROTATION_BYTES = 65_536;

export function parsePolicyAuthorityRotationJson(
  source: string,
  maximumBytes = MAXIMUM_ROTATION_BYTES,
): PolicyAuthorityRotation {
  const value = parseCanonicalJson(source, maximumBytes);
  assertPolicyAuthorityRotation(value);
  return value;
}

export function assertPolicyAuthorityRotation(
  value: unknown,
): asserts value is PolicyAuthorityRotation {
  const rotation = asRecord(value, "Policy-authority rotation");
  assertExactKeys(
    rotation,
    [
      "schema",
      "schemaVersion",
      "rotationId",
      "issuedAt",
      "effectiveAt",
      "expiresAt",
      "previousAuthorityKeyId",
      "nextAuthorityKeyId",
      "nextAuthorityPublicJwk",
    ],
    "Policy-authority rotation",
  );
  if (
    rotation.schema !== "agent-airlock/policy-authority-rotation" ||
    rotation.schemaVersion !== 1 ||
    typeof rotation.rotationId !== "string" ||
    !IDENTIFIER_PATTERN.test(rotation.rotationId) ||
    !isTimestamp(rotation.issuedAt) ||
    !isTimestamp(rotation.effectiveAt) ||
    !isNullableTimestamp(rotation.expiresAt) ||
    !isDigest(rotation.previousAuthorityKeyId) ||
    !isDigest(rotation.nextAuthorityKeyId) ||
    rotation.previousAuthorityKeyId === rotation.nextAuthorityKeyId
  ) {
    throw new Error("Policy-authority rotation identity or bounds are invalid");
  }
  if (Date.parse(rotation.effectiveAt) < Date.parse(rotation.issuedAt)) {
    throw new Error("Policy-authority rotation cannot take effect before issuance");
  }
  if (
    rotation.expiresAt !== null &&
    Date.parse(rotation.expiresAt) <= Date.parse(rotation.effectiveAt)
  ) {
    throw new Error("Policy-authority rotation expiry must follow its effective time");
  }
  assertPortablePublicJwk(rotation.nextAuthorityPublicJwk);
  if (utf8Bytes(canonicalize(rotation)).length > MAXIMUM_ROTATION_BYTES) {
    throw new Error("Policy-authority rotation exceeds the byte limit");
  }
}

export function parseSignedPolicyAuthorityRotationEnvelopeJson(
  source: string,
  maximumBytes = MAXIMUM_SIGNED_AUTHORITY_ROTATION_BYTES,
): SignedPolicyAuthorityRotationEnvelope {
  const value = parseCanonicalJson(source, maximumBytes);
  assertSignedPolicyAuthorityRotationEnvelope(value);
  return value;
}

export function assertSignedPolicyAuthorityRotationEnvelope(
  value: unknown,
): asserts value is SignedPolicyAuthorityRotationEnvelope {
  const envelope = asRecord(value, "Signed policy-authority rotation");
  assertExactKeys(
    envelope,
    [
      "schema",
      "schemaVersion",
      "rotation",
      "rotationDigest",
      "signatureAlgorithm",
      "signature",
      "previousAuthorityPublicJwk",
    ],
    "Signed policy-authority rotation",
  );
  if (
    envelope.schema !== "agent-airlock/signed-policy-authority-rotation" ||
    envelope.schemaVersion !== 1 ||
    !isDigest(envelope.rotationDigest) ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    typeof envelope.signature !== "string" ||
    decodeCanonicalBase64Url(envelope.signature, 64).length !== 64
  ) {
    throw new Error("Signed policy-authority rotation identity is invalid");
  }
  assertPolicyAuthorityRotation(envelope.rotation);
  assertPortablePublicJwk(envelope.previousAuthorityPublicJwk);
  if (utf8Bytes(canonicalize(envelope)).length > MAXIMUM_SIGNED_AUTHORITY_ROTATION_BYTES) {
    throw new Error("Signed policy-authority rotation exceeds the byte limit");
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} contains missing or unsupported fields`);
  }
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}
