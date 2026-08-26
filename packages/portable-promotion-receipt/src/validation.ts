import { Buffer } from "node:buffer";
import {
  assertCanonicalJsonValue,
  canonicalize,
  MAXIMUM_CANONICAL_DOCUMENT_BYTES,
} from "./canonical.js";
import type {
  BuiltinResourceCommitment,
  PortableEvidenceDisclosure,
  PortableEvidenceLeaf,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
  PortablePublicJwk,
  ProviderResourceCommitment,
  ReceiptDigest,
} from "./types.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const credentialPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:api[_-]?key|auth(?:entication|orization)?|bearer|client[_-]?secret|connection[_-]?string|cookie|credential|dsn|passphrase|password|private[_-]?key|refresh[_-]?token|secret|session|token|access[_-]?token)\s*[:=]\s*[^\s,;]{8,}/i,
];
const localPathPatterns = [
  /(?:^|\s)(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\)/,
  /(?:^|\s)\.\.(?:\/|\\)/,
  /[\\/]/,
];

export function assertPortablePromotionReceipt(
  value: unknown,
): asserts value is PortablePromotionReceipt {
  assertCanonicalJsonValue(value);
  const receipt = asRecord(value, "Portable Promotion Receipt");
  assertExactKeys(
    receipt,
    [
      "protocol",
      "decision",
      "state",
      "outcomeContract",
      "validationEvidence",
      "externalActions",
      "selection",
      "assurance",
      "ancestry",
    ],
    "Portable Promotion Receipt",
  );

  const protocol = asRecord(receipt.protocol, "Portable receipt protocol");
  assertExactKeys(
    protocol,
    ["schema", "schemaVersion", "canonicalization", "digestAlgorithm"],
    "Portable receipt protocol",
  );
  if (
    protocol.schema !== "agent-airlock/portable-promotion-receipt" ||
    protocol.schemaVersion !== 1 ||
    protocol.canonicalization !== "RFC8785" ||
    protocol.digestAlgorithm !== "SHA-256"
  ) {
    throw new Error("Portable receipt protocol is unsupported");
  }

  validateDecision(receipt.decision);
  const state = asRecord(receipt.state, "Portable receipt state");
  assertExactKeys(state, ["before", "after"], "Portable receipt state");
  const before = validateStateCommitment(state.before, "before");
  const after = validateStateCommitment(state.after, "after");

  const decision = receipt.decision as PortablePromotionReceipt["decision"];
  if (
    decision.disposition !== "promoted" &&
    canonicalize(before) !== canonicalize(after)
  ) {
    throw new Error("A non-Promotion receipt must preserve the state commitment");
  }

  validateOutcomeContractCommitment(receipt.outcomeContract);
  validateValidationCommitment(receipt.validationEvidence);
  validateExternalActions(receipt.externalActions);
  validateSelection(receipt.selection);
  validateAssurance(receipt.assurance);
  validateAncestry(receipt.ancestry, decision.runId);
}

export function assertPortablePromotionEnvelope(
  value: unknown,
): asserts value is PortablePromotionEnvelope {
  assertCanonicalJsonValue(value);
  const envelope = asRecord(value, "Portable Promotion Envelope");
  assertExactKeys(
    envelope,
    [
      "schema",
      "schemaVersion",
      "receipt",
      "receiptDigest",
      "signatureAlgorithm",
      "signature",
      "keyId",
      "publicJwk",
      "disclosures",
    ],
    "Portable Promotion Envelope",
  );
  if (
    envelope.schema !== "agent-airlock/portable-promotion-envelope" ||
    envelope.schemaVersion !== 1 ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    !isDigest(envelope.receiptDigest) ||
    !isDigest(envelope.keyId) ||
    typeof envelope.signature !== "string" ||
    decodeCanonicalBase64Url(envelope.signature, 64).length !== 64 ||
    !Array.isArray(envelope.disclosures) ||
    envelope.disclosures.length > 256
  ) {
    throw new Error("Portable Promotion Envelope identity or bounds are invalid");
  }
  assertPortablePromotionReceipt(envelope.receipt);
  assertPortablePublicJwk(envelope.publicJwk);
  const identities = new Set<string>();
  for (const disclosure of envelope.disclosures) {
    assertPortableEvidenceDisclosure(disclosure);
    const identity = disclosure.leaf.identity;
    if (identities.has(identity)) {
      throw new Error("Portable evidence disclosures contain a duplicate identity");
    }
    identities.add(identity);
  }
  if (
    Buffer.byteLength(canonicalize(envelope), "utf8") >
    MAXIMUM_CANONICAL_DOCUMENT_BYTES
  ) {
    throw new Error("Portable Promotion Envelope exceeds the byte limit");
  }
}

export function assertPortablePublicJwk(
  value: unknown,
): asserts value is PortablePublicJwk {
  const jwk = asRecord(value, "Portable public JWK");
  assertExactKeys(jwk, ["crv", "kty", "x"], "Portable public JWK");
  if (
    jwk.crv !== "Ed25519" ||
    jwk.kty !== "OKP" ||
    typeof jwk.x !== "string" ||
    decodeCanonicalBase64Url(jwk.x, 32).length !== 32
  ) {
    throw new Error("Portable public JWK is invalid");
  }
}

export function assertPortableEvidenceLeaf(
  value: unknown,
): asserts value is PortableEvidenceLeaf {
  const leaf = asRecord(value, "Portable evidence leaf");
  assertExactKeys(
    leaf,
    [
      "schemaVersion",
      "identity",
      "category",
      "status",
      "required",
      "durationMs",
      "summary",
      "valueHash",
    ],
    "Portable evidence leaf",
  );
  if (
    leaf.schemaVersion !== 1 ||
    !isIdentifier(leaf.identity) ||
    !["validation", "resource", "external-action", "selection"].includes(
      String(leaf.category),
    ) ||
    !["passed", "failed", "skipped", "error", "recorded"].includes(
      String(leaf.status),
    ) ||
    typeof leaf.required !== "boolean" ||
    !isNullableSafeInteger(leaf.durationMs, 0, 3_600_000) ||
    !isNullableSafeText(leaf.summary, 500) ||
    !isDigest(leaf.valueHash)
  ) {
    throw new Error("Portable evidence leaf is invalid");
  }
}

export function assertPortableEvidenceDisclosure(
  value: unknown,
): asserts value is PortableEvidenceDisclosure {
  const disclosure = asRecord(value, "Portable evidence disclosure");
  assertExactKeys(
    disclosure,
    ["leaf", "leafIndex", "totalLeaves", "siblings"],
    "Portable evidence disclosure",
  );
  if (
    !Number.isSafeInteger(disclosure.leafIndex) ||
    (disclosure.leafIndex as number) < 0 ||
    !Number.isSafeInteger(disclosure.totalLeaves) ||
    (disclosure.totalLeaves as number) < 1 ||
    (disclosure.totalLeaves as number) > 10_000 ||
    (disclosure.leafIndex as number) >= (disclosure.totalLeaves as number) ||
    !Array.isArray(disclosure.siblings) ||
    disclosure.siblings.length > 32
  ) {
    throw new Error("Portable evidence disclosure bounds are invalid");
  }
  assertPortableEvidenceLeaf(disclosure.leaf);
  for (const siblingValue of disclosure.siblings) {
    const sibling = asRecord(siblingValue, "Portable evidence sibling");
    assertExactKeys(sibling, ["direction", "hash"], "Portable evidence sibling");
    if (
      !["left", "right"].includes(String(sibling.direction)) ||
      !isDigest(sibling.hash)
    ) {
      throw new Error("Portable evidence sibling is invalid");
    }
  }
}

export function decodeCanonicalBase64Url(value: string, maximumBytes: number): Buffer {
  if (!value || !base64UrlPattern.test(value) || value.includes("=")) {
    throw new Error("Value is not canonical unpadded base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maximumBytes || decoded.toString("base64url") !== value) {
    throw new Error("Value is not canonical bounded base64url");
  }
  return decoded;
}

export function isDigest(value: unknown): value is ReceiptDigest {
  return typeof value === "string" && digestPattern.test(value);
}

export function assertCredentialFreeText(value: string, name: string): void {
  if (
    redactPortableSensitiveText(value) !== value ||
    localPathPatterns.some((pattern) => pattern.test(value))
  ) {
    throw new Error(`${name} contains credential-like or local-path content`);
  }
}

export function redactPortableSensitiveText(input: string): string {
  let output = input;
  output = output.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  for (const pattern of credentialPatterns.slice(0, -1)) {
    output = output.replace(new RegExp(pattern.source, `${pattern.flags}g`.replace("gg", "g")), "[REDACTED]");
  }
  output = output.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    "$1[REDACTED]@",
  );
  output = output.replace(
    /((?:api[_-]?key|auth(?:entication|orization)?|bearer|client[_-]?secret|connection[_-]?string|cookie|credential|dsn|passphrase|password|private[_-]?key|refresh[_-]?token|secret|session|token|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
  return output;
}

export function safePortableDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactPortableSensitiveText(message);
  return redacted
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function validateDecision(value: unknown): void {
  const decision = asRecord(value, "Portable receipt decision");
  assertExactKeys(
    decision,
    ["runId", "agentId", "disposition", "decidedAt", "clockClaim"],
    "Portable receipt decision",
  );
  if (
    !isIdentifier(decision.runId) ||
    !isIdentifier(decision.agentId) ||
    !["promoted", "quarantined", "discarded", "cancelled"].includes(
      String(decision.disposition),
    ) ||
    !isTimestamp(decision.decidedAt) ||
    decision.clockClaim !== "signer-clock-not-external-timestamp"
  ) {
    throw new Error("Portable receipt decision is invalid");
  }
}

function validateStateCommitment(
  value: unknown,
  label: string,
): PortablePromotionReceipt["state"]["before"] {
  const state = asRecord(value, `Portable ${label} state`);
  assertExactKeys(
    state,
    ["stateId", "compositeHash", "builtinResources", "providerResources"],
    `Portable ${label} state`,
  );
  if (
    !isIdentifier(state.stateId) ||
    !isDigest(state.compositeHash) ||
    !Array.isArray(state.builtinResources) ||
    state.builtinResources.length > 32 ||
    !Array.isArray(state.providerResources) ||
    state.providerResources.length > 64
  ) {
    throw new Error(`Portable ${label} state is invalid`);
  }
  const builtin = state.builtinResources.map((resource) =>
    validateBuiltinResource(resource),
  );
  const providers = state.providerResources.map((resource) =>
    validateProviderResource(resource),
  );
  assertSortedUnique(builtin, (resource) => resource.kind, "built-in resource");
  assertSortedUnique(
    providers,
    (resource) => `${resource.providerId}\u0000${resource.resourceKind}`,
    "provider resource",
  );
  return state as unknown as PortablePromotionReceipt["state"]["before"];
}

function validateBuiltinResource(value: unknown): BuiltinResourceCommitment {
  const resource = asRecord(value, "Built-in resource commitment");
  assertExactKeys(resource, ["kind", "fingerprint"], "Built-in resource commitment");
  if (!isIdentifier(resource.kind) || !isDigest(resource.fingerprint)) {
    throw new Error("Built-in resource commitment is invalid");
  }
  return resource as unknown as BuiltinResourceCommitment;
}

function validateProviderResource(value: unknown): ProviderResourceCommitment {
  const resource = asRecord(value, "Provider resource commitment");
  assertExactKeys(
    resource,
    ["providerId", "resourceKind", "versionId", "fingerprint"],
    "Provider resource commitment",
  );
  if (
    !isIdentifier(resource.providerId) ||
    !isIdentifier(resource.resourceKind) ||
    !isIdentifier(resource.versionId) ||
    !isDigest(resource.fingerprint)
  ) {
    throw new Error("Provider resource commitment is invalid");
  }
  return resource as unknown as ProviderResourceCommitment;
}

function validateOutcomeContractCommitment(value: unknown): void {
  const contract = asRecord(value, "Outcome Contract commitment");
  assertExactKeys(
    contract,
    ["schemaVersion", "version", "digest"],
    "Outcome Contract commitment",
  );
  if (
    !isSafeInteger(contract.schemaVersion, 1, 1_000_000) ||
    !isSafeInteger(contract.version, 1, 1_000_000) ||
    !isDigest(contract.digest)
  ) {
    throw new Error("Outcome Contract commitment is invalid");
  }
}

function validateValidationCommitment(value: unknown): void {
  const validation = asRecord(value, "Validation evidence commitment");
  assertExactKeys(
    validation,
    ["root", "leafCount", "ordering"],
    "Validation evidence commitment",
  );
  if (
    !isDigest(validation.root) ||
    !isSafeInteger(validation.leafCount, 0, 10_000) ||
    validation.ordering !== "canonical-identity-ascending"
  ) {
    throw new Error("Validation evidence commitment is invalid");
  }
}

function validateExternalActions(value: unknown): void {
  const actions = asRecord(value, "External Action commitment");
  assertExactKeys(
    actions,
    ["commitment", "deliveredCount"],
    "External Action commitment",
  );
  if (
    !isDigest(actions.commitment) ||
    !isSafeInteger(actions.deliveredCount, 0, 10_000)
  ) {
    throw new Error("External Action commitment is invalid");
  }
}

function validateSelection(value: unknown): void {
  if (value === null) return;
  const selection = asRecord(value, "Selection commitment");
  assertExactKeys(
    selection,
    ["candidateSetId", "decisionDigest"],
    "Selection commitment",
  );
  if (!isIdentifier(selection.candidateSetId) || !isDigest(selection.decisionDigest)) {
    throw new Error("Selection commitment is invalid");
  }
}

function validateAssurance(value: unknown): void {
  if (value === null) return;
  const assurance = asRecord(value, "Assurance provenance");
  assertExactKeys(
    assurance,
    ["proposalId", "contractVersion"],
    "Assurance provenance",
  );
  if (
    !isIdentifier(assurance.proposalId) ||
    !isSafeInteger(assurance.contractVersion, 1, 1_000_000)
  ) {
    throw new Error("Assurance provenance is invalid");
  }
}

function validateAncestry(value: unknown, runId: string): void {
  const ancestry = asRecord(value, "Portable receipt ancestry");
  assertExactKeys(
    ancestry,
    ["rootRunId", "parentRunId", "depth", "maxDepth", "previousReceiptDigest"],
    "Portable receipt ancestry",
  );
  if (
    !isIdentifier(ancestry.rootRunId) ||
    !isNullableIdentifier(ancestry.parentRunId) ||
    !isSafeInteger(ancestry.depth, 0, 64) ||
    !isSafeInteger(ancestry.maxDepth, 0, 64) ||
    (ancestry.depth as number) > (ancestry.maxDepth as number) ||
    !(
      ancestry.previousReceiptDigest === null ||
      isDigest(ancestry.previousReceiptDigest)
    ) ||
    ((ancestry.depth as number) === 0 &&
      (ancestry.parentRunId !== null || ancestry.rootRunId !== runId)) ||
    ((ancestry.depth as number) > 0 && ancestry.parentRunId === null)
  ) {
    throw new Error("Portable receipt ancestry is invalid");
  }
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || !identifierPattern.test(value)) return false;
  assertCredentialFreeText(value, "Identifier");
  return true;
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isNullableSafeText(value: unknown, maximumBytes: number): boolean {
  if (value === null) return true;
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return false;
  }
  assertCredentialFreeText(value, "Portable evidence text");
  return true;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function isNullableSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return value === null || isSafeInteger(value, minimum, maximum);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function assertSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  let previous: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(current)) >= 0) {
      throw new Error(`Portable ${label} commitments must be sorted and unique`);
    }
    previous = current;
  }
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
