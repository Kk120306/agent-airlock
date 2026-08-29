import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import type {
  OrganizationalTrustReport,
  PortableDisposition,
  PortablePromotionEnvelope,
  SigningKeyTrustPolicy,
  SigningKeyTrustRule,
  SignedSigningKeyTrustPolicyEnvelope,
} from "./types.js";
import {
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
} from "./validation.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAXIMUM_POLICY_BYTES = 65_536;
export const MAXIMUM_SIGNED_TRUST_POLICY_BYTES = 131_072;
const DISPOSITIONS: PortableDisposition[] = [
  "promoted",
  "quarantined",
  "discarded",
  "cancelled",
];

export function parseSigningKeyTrustPolicyJson(
  source: string,
  maximumBytes = MAXIMUM_POLICY_BYTES,
): SigningKeyTrustPolicy {
  const value = parseCanonicalJson(source, maximumBytes);
  assertSigningKeyTrustPolicy(value);
  return value;
}

export function assertSigningKeyTrustPolicy(
  value: unknown,
): asserts value is SigningKeyTrustPolicy {
  const policy = asRecord(value, "Signing-key trust policy");
  assertExactKeys(
    policy,
    ["schema", "schemaVersion", "policyId", "issuedAt", "expiresAt", "keys"],
    "Signing-key trust policy",
  );
  if (
    policy.schema !== "agent-airlock/signing-key-trust-policy" ||
    policy.schemaVersion !== 1 ||
    !isIdentifier(policy.policyId) ||
    !isTimestamp(policy.issuedAt) ||
    !isNullableTimestamp(policy.expiresAt) ||
    !Array.isArray(policy.keys) ||
    policy.keys.length > 256
  ) {
    throw new Error("Signing-key trust policy identity or bounds are invalid");
  }
  if (
    policy.expiresAt !== null &&
    Date.parse(String(policy.expiresAt)) <= Date.parse(String(policy.issuedAt))
  ) {
    throw new Error("Signing-key trust policy expiry must follow issuance");
  }

  let previousKeyId = "";
  for (const value of policy.keys) {
    const rule = validateRule(value);
    if (rule.keyId <= previousKeyId) {
      throw new Error("Signing-key trust rules must be unique and sorted by keyId");
    }
    previousKeyId = rule.keyId;
  }
  if (utf8Bytes(JSON.stringify(policy)).length > MAXIMUM_POLICY_BYTES) {
    throw new Error("Signing-key trust policy exceeds the byte limit");
  }
}

export function parseSignedSigningKeyTrustPolicyEnvelopeJson(
  source: string,
  maximumBytes = MAXIMUM_SIGNED_TRUST_POLICY_BYTES,
): SignedSigningKeyTrustPolicyEnvelope {
  const value = parseCanonicalJson(source, maximumBytes);
  assertSignedSigningKeyTrustPolicyEnvelope(value);
  return value;
}

export function assertSignedSigningKeyTrustPolicyEnvelope(
  value: unknown,
): asserts value is SignedSigningKeyTrustPolicyEnvelope {
  const envelope = asRecord(value, "Signed signing-key trust policy");
  assertExactKeys(
    envelope,
    [
      "schema",
      "schemaVersion",
      "policy",
      "policyDigest",
      "signatureAlgorithm",
      "signature",
      "authorityKeyId",
      "authorityPublicJwk",
    ],
    "Signed signing-key trust policy",
  );
  if (
    envelope.schema !== "agent-airlock/signed-signing-key-trust-policy" ||
    envelope.schemaVersion !== 1 ||
    !isDigest(envelope.policyDigest) ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    typeof envelope.signature !== "string" ||
    decodeCanonicalBase64Url(envelope.signature, 64).length !== 64 ||
    !isDigest(envelope.authorityKeyId)
  ) {
    throw new Error("Signed signing-key trust policy identity is invalid");
  }
  assertSigningKeyTrustPolicy(envelope.policy);
  assertPortablePublicJwk(envelope.authorityPublicJwk);
  if (utf8Bytes(canonicalize(envelope)).length > MAXIMUM_SIGNED_TRUST_POLICY_BYTES) {
    throw new Error("Signed signing-key trust policy exceeds the byte limit");
  }
}

export function evaluateSigningKeyTrust(
  envelope: PortablePromotionEnvelope,
  policy: SigningKeyTrustPolicy,
  options: { cryptographicValid: boolean; evaluatedAt?: string },
): OrganizationalTrustReport {
  const base = {
    policyId: policy.policyId,
    keyId: envelope.keyId,
  };
  if (!options.cryptographicValid) {
    return {
      ...base,
      trusted: false,
      status: "cryptographic-proof-invalid",
      detail: "Organizational trust cannot pass because the receipt proof is invalid.",
    };
  }

  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  if (!isTimestamp(evaluatedAt)) {
    throw new Error("Trust-policy evaluation time is invalid");
  }
  if (Date.parse(evaluatedAt) < Date.parse(policy.issuedAt)) {
    return {
      ...base,
      trusted: false,
      status: "policy-not-yet-effective",
      detail: `Trust policy ${policy.policyId} is not yet effective.`,
    };
  }
  if (policy.expiresAt !== null && Date.parse(evaluatedAt) > Date.parse(policy.expiresAt)) {
    return {
      ...base,
      trusted: false,
      status: "policy-expired",
      detail: `Trust policy ${policy.policyId} expired before this evaluation.`,
    };
  }

  const rule = policy.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!rule) {
    return {
      ...base,
      trusted: false,
      status: "untrusted",
      detail: "The signing key is not listed by the imported trust policy.",
    };
  }
  if (rule.status === "compromised") {
    return {
      ...base,
      trusted: false,
      status: "compromised",
      detail: "The imported trust policy marks this signing key as compromised.",
    };
  }

  const decision = envelope.receipt.decision;
  const decidedAt = Date.parse(decision.decidedAt);
  if (
    decidedAt < Date.parse(rule.validFrom) ||
    (rule.validUntil !== null && decidedAt > Date.parse(rule.validUntil))
  ) {
    return {
      ...base,
      trusted: false,
      status: "outside-validity-window",
      detail: "The receipt decision falls outside this key's trusted signing window.",
    };
  }
  if (
    (rule.agentIds.length > 0 && !rule.agentIds.includes(decision.agentId)) ||
    (rule.dispositions.length > 0 && !rule.dispositions.includes(decision.disposition))
  ) {
    return {
      ...base,
      trusted: false,
      status: "scope-mismatch",
      detail: "The signing key is not trusted for this Agent and disposition scope.",
    };
  }

  const historical = rule.status === "retired";
  return {
    ...base,
    trusted: true,
    status: historical ? "historically-trusted" : "trusted",
    detail: historical
      ? "The retired key was trusted for this receipt's decision time and scope."
      : "The signing key is trusted for this receipt's decision time and scope.",
  };
}

function validateRule(value: unknown): SigningKeyTrustRule {
  const rule = asRecord(value, "Signing-key trust rule");
  assertExactKeys(
    rule,
    ["keyId", "status", "validFrom", "validUntil", "agentIds", "dispositions", "note"],
    "Signing-key trust rule",
  );
  if (
    !isDigest(rule.keyId) ||
    !["active", "retired", "compromised"].includes(String(rule.status)) ||
    !isTimestamp(rule.validFrom) ||
    !isNullableTimestamp(rule.validUntil) ||
    !Array.isArray(rule.agentIds) ||
    rule.agentIds.length > 256 ||
    !Array.isArray(rule.dispositions) ||
    rule.dispositions.length > DISPOSITIONS.length ||
    !(rule.note === null || (typeof rule.note === "string" && rule.note.length <= 500))
  ) {
    throw new Error("Signing-key trust rule is invalid");
  }
  if (
    rule.validUntil !== null &&
    Date.parse(String(rule.validUntil)) <= Date.parse(String(rule.validFrom))
  ) {
    throw new Error("Signing-key trust rule validity window is invalid");
  }
  if (rule.status === "retired" && rule.validUntil === null) {
    throw new Error("A retired signing key requires a validUntil timestamp");
  }
  assertSortedUniqueStrings(rule.agentIds, "Agent scope");
  assertSortedUniqueStrings(rule.dispositions, "Disposition scope");
  if (!rule.agentIds.every(isIdentifier)) {
    throw new Error("Signing-key trust rule Agent scope is invalid");
  }
  if (!rule.dispositions.every((item) => DISPOSITIONS.includes(item as PortableDisposition))) {
    throw new Error("Signing-key trust rule disposition scope is invalid");
  }
  return rule as unknown as SigningKeyTrustRule;
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

function assertSortedUniqueStrings(value: unknown[], name: string): void {
  let previous = "";
  for (const item of value) {
    if (typeof item !== "string" || item <= previous) {
      throw new Error(`${name} must be unique and sorted`);
    }
    previous = item;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
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
