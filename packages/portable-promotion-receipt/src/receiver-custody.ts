import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  KeyObject,
  type JsonWebKey,
} from "node:crypto";
import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import {
  exportPortablePublicJwk,
  publicJwkFingerprint,
  sha256Digest,
} from "./crypto.js";
import { verifyFederatedWorkBundle } from "./federated-work-bundle.js";
import type {
  FederatedWorkBundle,
} from "./federated-work-bundle.js";
import type {
  PortablePromotionEnvelope,
  PortablePublicJwk,
  OrganizationalTrustReport,
  ReceiptDigest,
  SigningKeyTrustPolicy,
  VerificationCheck,
} from "./types.js";
import {
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
} from "./validation.js";
import { verifyPortablePromotionEnvelope } from "./verifier.js";
import { evaluateSigningKeyTrust } from "./trust-policy.js";
import { buildReceiverCustodyVerifiedStory } from "./receiver-custody-story.js";

const SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-receiver-custody-manifest-v1\0",
  "utf8",
);
const MAXIMUM_PACKET_BYTES = 16 * 1_048_576;
const MAXIMUM_RECORD_BYTES = 12 * 1_048_576;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_EVIDENCE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization\s*:\s*[^"\\]{4}|Bearer\s+[A-Za-z0-9._~-]{8}|\bark-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-f0-9]{4,}\b|\/(?:Users|home|private|tmp)\//i;
const ROLE_REQUIREMENTS: Record<ReceiverCustodyRecordRole, {
  trustDomain: "producer" | "receiver";
  schema: string;
  signingRequirement: ReceiverCustodyRecordDescriptor["signingRequirement"];
}> = {
  "producer-work-bundle": {
    trustDomain: "producer",
    schema: "agent-airlock/federated-work-bundle",
    signingRequirement: "nested-required",
  },
  "receiver-admission": {
    trustDomain: "receiver",
    schema: "agent-airlock/federated-admission-record",
    signingRequirement: "manifest-covered",
  },
  "receiver-approval": {
    trustDomain: "receiver",
    schema: "agent-airlock/federated-approval-decision",
    signingRequirement: "manifest-covered",
  },
  "receiver-terminal-authority": {
    trustDomain: "receiver",
    schema: "agent-airlock/portable-decision-authority-commitment",
    signingRequirement: "manifest-covered",
  },
  "receiver-promotion-envelope": {
    trustDomain: "receiver",
    schema: "agent-airlock/portable-promotion-envelope",
    signingRequirement: "nested-and-manifest",
  },
};

export type ReceiverCustodyRecordRole =
  | "producer-work-bundle"
  | "receiver-admission"
  | "receiver-approval"
  | "receiver-terminal-authority"
  | "receiver-promotion-envelope";

export interface ReceiverCustodyRecordDescriptor {
  recordId: string;
  role: ReceiverCustodyRecordRole;
  trustDomain: "producer" | "receiver";
  schema: string;
  schemaVersion: number;
  mediaType: "application/json";
  canonicalization: "RFC8785";
  digestAlgorithm: "SHA-256";
  byteLength: number;
  digest: ReceiptDigest;
  signingRequirement: "nested-required" | "manifest-covered" | "nested-and-manifest";
}

export interface ReceiverCustodyBindings {
  admissionId: ReceiptDigest;
  importIdentifier: ReceiptDigest;
  producerId: string;
  receiverAgentId: string;
  receiverRunId: string;
  producerReceiptDigest: ReceiptDigest;
  artifactDigest: ReceiptDigest;
  admissionRecordDigest: ReceiptDigest;
  approvalDecisionDigest: ReceiptDigest | null;
  decisionContextDigest: ReceiptDigest | null;
  terminalAuthorityDigest: ReceiptDigest;
  receiverReceiptDigest: ReceiptDigest;
  outcomeContractDigest: ReceiptDigest;
  validationEvidenceRoot: ReceiptDigest;
  disposition: "promoted" | "quarantined";
}

export interface ReceiverCustodyManifest {
  schema: "agent-airlock/receiver-custody-manifest";
  schemaVersion: 1;
  profile: "full-audit";
  records: ReceiverCustodyRecordDescriptor[];
  bindings: ReceiverCustodyBindings;
}

export interface ReceiverCustodyEnvelope {
  schema: "agent-airlock/receiver-custody-envelope";
  schemaVersion: 1;
  manifest: ReceiverCustodyManifest;
  manifestDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  keyId: ReceiptDigest;
  publicJwk: PortablePublicJwk;
}

export interface ReceiverCustodyRecord {
  recordId: string;
  canonicalBytes: string;
}

export interface ReceiverCustodyPacket {
  schema: "agent-airlock/portable-receiver-chain-of-custody";
  schemaVersion: 1;
  envelope: ReceiverCustodyEnvelope;
  records: ReceiverCustodyRecord[];
  anchors: [];
}

export interface ReceiverCustodyVerificationReport {
  valid: boolean;
  manifestDigest: ReceiptDigest | null;
  receiverKeyId: ReceiptDigest | null;
  producerReceiptDigest: ReceiptDigest | null;
  receiverReceiptDigest: ReceiptDigest | null;
  story: ReceiverCustodyVerifiedStory | null;
  checks: VerificationCheck[];
}

export interface ReceiverCustodyVerifiedStory {
  disposition: "promoted" | "quarantined";
  approval: "automatic" | "operator-approved";
  producer: {
    producerId: string;
    keyId: ReceiptDigest;
    receiptDigest: ReceiptDigest;
    artifactDigest: ReceiptDigest;
  };
  receiver: {
    agentId: string;
    runId: string;
    keyId: ReceiptDigest;
    receiptDigest: ReceiptDigest;
  };
  authority: {
    admissionId: ReceiptDigest;
    admissionRecordDigest: ReceiptDigest;
    approvalDecisionDigest: ReceiptDigest | null;
    decisionContextDigest: ReceiptDigest | null;
    terminalAuthorityDigest: ReceiptDigest;
    outcomeContractDigest: ReceiptDigest;
    validationEvidenceRoot: ReceiptDigest;
  };
  state: {
    canonicalAdvanced: boolean;
    beforeStateId: string;
    afterStateId: string;
    beforeCompositeHash: ReceiptDigest;
    afterCompositeHash: ReceiptDigest;
  };
}

export interface ReceiverCustodyTrustReport {
  cryptographicValid: boolean;
  policiesDistinct: boolean;
  producer: OrganizationalTrustReport | null;
  receiver: OrganizationalTrustReport | null;
}

export type ReceiverCustodyTamperAttack =
  | "remove-admission"
  | "alter-reviewed-evidence"
  | "rewrite-disposition";

export function buildReceiverCustodyRecord(input: {
  recordId: string;
  role: ReceiverCustodyRecordRole;
  trustDomain: "producer" | "receiver";
  schema: string;
  schemaVersion: number;
  signingRequirement: ReceiverCustodyRecordDescriptor["signingRequirement"];
  value: unknown;
}): { descriptor: ReceiverCustodyRecordDescriptor; record: ReceiverCustodyRecord } {
  assertIdentifier(input.recordId, "record identity");
  const source = canonicalize(input.value);
  const bytes = utf8Bytes(source);
  if (bytes.length > MAXIMUM_RECORD_BYTES) {
    throw new Error("Receiver custody record exceeds the byte boundary");
  }
  if (containsForbiddenEvidence(input.value)) {
    throw new Error("Receiver custody record crossed its evidence boundary");
  }
  return {
    descriptor: {
      recordId: input.recordId,
      role: input.role,
      trustDomain: input.trustDomain,
      schema: input.schema,
      schemaVersion: input.schemaVersion,
      mediaType: "application/json",
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
      byteLength: bytes.length,
      digest: sha256Digest(bytes),
      signingRequirement: input.signingRequirement,
    },
    record: {
      recordId: input.recordId,
      canonicalBytes: Buffer.from(bytes).toString("base64url"),
    },
  };
}

export function buildReceiverCustodyPacket(input: {
  manifest: ReceiverCustodyManifest;
  records: ReceiverCustodyRecord[];
  privateKey: KeyObject | string | Buffer;
}): ReceiverCustodyPacket {
  assertManifest(input.manifest);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const publicJwk = exportPortablePublicJwk(privateKey);
  const keyId = publicJwkFingerprint(publicJwk);
  const manifestDigest = sha256Digest(utf8Bytes(canonicalize(input.manifest)));
  const packet: ReceiverCustodyPacket = {
    schema: "agent-airlock/portable-receiver-chain-of-custody",
    schemaVersion: 1,
    envelope: {
      schema: "agent-airlock/receiver-custody-envelope",
      schemaVersion: 1,
      manifest: structuredClone(input.manifest),
      manifestDigest,
      signatureAlgorithm: "Ed25519",
      signature: sign(
        null,
        Buffer.concat([SIGNATURE_DOMAIN, digestBytes(manifestDigest)]),
        privateKey,
      ).toString("base64url"),
      keyId,
      publicJwk,
    },
    records: structuredClone(input.records),
    anchors: [],
  };
  const report = verifyReceiverCustodyPacket(packet);
  if (!report.valid) {
    const failures = report.checks
      .filter((check) => !check.valid)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    throw new Error(`Receiver custody packet failed its own verification: ${failures}`);
  }
  return packet;
}

export function verifyReceiverCustodyPacket(
  value: unknown,
  trustPolicies: {
    producer: SigningKeyTrustPolicy;
    receiver: SigningKeyTrustPolicy;
    evaluatedAt?: string;
  } | null = null,
): ReceiverCustodyVerificationReport {
  const report = emptyReport();
  let verifiedStory: ReceiverCustodyVerifiedStory | null = null;
  try {
    const packet = assertPacket(value);
    const envelope = packet.envelope;
    const manifest = envelope.manifest;
    const expectedManifestDigest = sha256Digest(
      utf8Bytes(canonicalize(manifest)),
    );
    add(report, "manifest-digest", envelope.manifestDigest === expectedManifestDigest,
      "The receiver signature binds the exact canonical closure manifest");
    const keyId = publicJwkFingerprint(envelope.publicJwk);
    add(report, "receiver-key-id", envelope.keyId === keyId,
      "The receiver key fingerprint matches its public key");
    const signature = decodeCanonicalBase64Url(
      envelope.signature,
      64,
    );
    if (signature.length !== 64) throw new Error("Receiver custody signature length is invalid");
    const signatureValid = verify(
      null,
      Buffer.concat([SIGNATURE_DOMAIN, digestBytes(envelope.manifestDigest)]),
      createPublicKey({ key: envelope.publicJwk as JsonWebKey, format: "jwk" }),
      signature,
    );
    add(report, "receiver-signature", signatureValid,
      "The receiver signed the closure manifest under its distinct custody domain");
    const decoded = decodeRecords(packet, report);
    verifyRequiredRoles(manifest, decoded, report);
    verifyBindings(manifest.bindings, decoded, report);
    verifiedStory = buildReceiverCustodyVerifiedStory(manifest.bindings, decoded);
    if (trustPolicies) {
      verifyTrustDomains(decoded, trustPolicies, report);
    }
    report.manifestDigest = envelope.manifestDigest;
    report.receiverKeyId = envelope.keyId;
    report.producerReceiptDigest = manifest.bindings.producerReceiptDigest;
    report.receiverReceiptDigest = manifest.bindings.receiverReceiptDigest;
  } catch (error) {
    add(
      report,
      "packet-structure",
      false,
      error instanceof Error ? error.message : "Receiver custody packet is invalid",
    );
  }
  report.valid = report.checks.length > 0 && report.checks.every((check) => check.valid);
  report.story = report.valid ? verifiedStory : null;
  return report;
}

function verifyTrustDomains(
  records: Map<ReceiverCustodyRecordRole, unknown>,
  trustPolicies: {
    producer: SigningKeyTrustPolicy;
    receiver: SigningKeyTrustPolicy;
    evaluatedAt?: string;
  },
  report: ReceiverCustodyVerificationReport,
): void {
  if (trustPolicies.producer.policyId === trustPolicies.receiver.policyId) {
    throw new Error("Producer and receiver custody require separate trust policies");
  }
  const bundle = records.get("producer-work-bundle") as FederatedWorkBundle;
  const receiver = records.get("receiver-promotion-envelope") as PortablePromotionEnvelope;
  const evaluationOptions = trustPolicies.evaluatedAt
    ? { cryptographicValid: true, evaluatedAt: trustPolicies.evaluatedAt }
    : { cryptographicValid: true };
  const producerTrust = evaluateSigningKeyTrust(
    bundle.receipt,
    trustPolicies.producer,
    evaluationOptions,
  );
  const receiverTrust = evaluateSigningKeyTrust(
    receiver,
    trustPolicies.receiver,
    evaluationOptions,
  );
  add(report, "producer-trust-domain", producerTrust.trusted,
    "The producer signer was evaluated only under the evaluator's producer policy");
  add(report, "receiver-trust-domain", receiverTrust.trusted,
    "The receiver custody signer was evaluated only under the evaluator's receiver policy");
}

export function verifyReceiverCustodyPacketJson(
  source: string,
): ReceiverCustodyVerificationReport {
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_PACKET_BYTES) {
    const report = emptyReport();
    add(report, "packet-structure", false, "Receiver custody packet exceeds the byte boundary");
    return report;
  }
  try {
    return verifyReceiverCustodyPacket(
      parseCanonicalJson(source, MAXIMUM_PACKET_BYTES),
    );
  } catch (error) {
    const report = emptyReport();
    add(report, "packet-structure", false,
      error instanceof Error ? error.message : "Receiver custody packet is invalid");
    return report;
  }
}

function decodeRecords(
  packet: ReceiverCustodyPacket,
  report: ReceiverCustodyVerificationReport,
): Map<ReceiverCustodyRecordRole, unknown> {
  const byId = new Map(packet.records.map((record) => [record.recordId, record]));
  const decoded = new Map<ReceiverCustodyRecordRole, unknown>();
  for (const descriptor of packet.envelope.manifest.records) {
    const record = byId.get(descriptor.recordId);
    if (!record) throw new Error(`Receiver custody record ${descriptor.recordId} is missing`);
    const bytes = decodeCanonicalBase64Url(
      record.canonicalBytes,
      MAXIMUM_RECORD_BYTES,
    );
    if (bytes.length !== descriptor.byteLength || sha256Digest(bytes) !== descriptor.digest) {
      throw new Error(`Receiver custody record ${descriptor.recordId} contradicts its descriptor`);
    }
    const source = Buffer.from(bytes).toString("utf8");
    const value = parseCanonicalJson(source, MAXIMUM_RECORD_BYTES);
    if (canonicalize(value) !== source || containsForbiddenEvidence(value)) {
      throw new Error(`Receiver custody record ${descriptor.recordId} is not safe canonical evidence`);
    }
    decoded.set(descriptor.role, value);
  }
  add(report, "record-commitments", true,
    "Every embedded canonical record matches its signed typed descriptor");
  return decoded;
}

function containsForbiddenEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    return FORBIDDEN_EVIDENCE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenEvidence(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsForbiddenEvidence(item));
  }
  return false;
}

function verifyRequiredRoles(
  manifest: ReceiverCustodyManifest,
  decoded: Map<ReceiverCustodyRecordRole, unknown>,
  report: ReceiverCustodyVerificationReport,
): void {
  const required: ReceiverCustodyRecordRole[] = [
    "producer-work-bundle",
    "receiver-admission",
    "receiver-terminal-authority",
    "receiver-promotion-envelope",
  ];
  if (manifest.bindings.approvalDecisionDigest !== null) required.push("receiver-approval");
  if (manifest.bindings.approvalDecisionDigest === null && decoded.has("receiver-approval")) {
    throw new Error("Receiver custody packet contains an undeclared Approval Decision");
  }
  for (const role of required) {
    if (!decoded.has(role)) throw new Error(`Receiver custody role ${role} is missing`);
  }
  add(report, "profile-completeness", true,
    "The full-audit profile contains exactly one complete authority path");
}

function verifyBindings(
  bindings: ReceiverCustodyBindings,
  records: Map<ReceiverCustodyRecordRole, unknown>,
  report: ReceiverCustodyVerificationReport,
): void {
  const bundle = records.get("producer-work-bundle") as FederatedWorkBundle;
  const producer = verifyFederatedWorkBundle(bundle);
  add(report, "producer-evidence", producer.valid,
    "The producer Work Bundle and nested Promotion Receipt verify independently");
  if (
    bundle.receipt.receiptDigest !== bindings.producerReceiptDigest ||
    bundle.artifact.artifactDigest !== bindings.artifactDigest
  ) throw new Error("Producer evidence contradicts the custody bindings");

  const admission = asRecord(records.get("receiver-admission"), "Admission Record");
  const admissionBody = without(admission, "recordDigest");
  if (
    admission.admissionId !== bindings.admissionId ||
    admission.importIdentifier !== bindings.importIdentifier ||
    admission.producerId !== bindings.producerId ||
    admission.localAgentId !== bindings.receiverAgentId ||
    admission.recordDigest !== bindings.admissionRecordDigest ||
    sha256Digest(utf8Bytes(canonicalize(admissionBody))) !== admission.recordDigest
  ) throw new Error("Receiver Admission Record contradicts the custody bindings");
  const admissionDecision = asRecord(admission.decision, "Admission decision");
  if (
    admissionDecision.receiptDigest !== bindings.producerReceiptDigest ||
    admissionDecision.artifactDigest !== bindings.artifactDigest
  ) throw new Error("Receiver Admission does not bind the producer evidence");

  if (bindings.approvalDecisionDigest !== null) {
    const approval = asRecord(records.get("receiver-approval"), "Approval Decision");
    if (
      approval.admissionId !== bindings.admissionId ||
      approval.pendingRecordDigest !== bindings.admissionRecordDigest ||
      approval.recordDigest !== bindings.approvalDecisionDigest ||
      (approval.decisionContextDigest ?? null) !== bindings.decisionContextDigest ||
      sha256Digest(utf8Bytes(canonicalize(without(approval, "recordDigest")))) !==
        approval.recordDigest
    ) throw new Error("Receiver Approval Decision contradicts the reviewed custody context");
  }

  const authority = asRecord(records.get("receiver-terminal-authority"), "terminal authority");
  if (
    authority.authorityDigest !== bindings.terminalAuthorityDigest ||
    authority.runId !== bindings.receiverRunId ||
    authority.agentId !== bindings.receiverAgentId ||
    authority.disposition !== bindings.disposition ||
    !isDigest(authority.transactionEvidenceHash) ||
    sha256Digest(utf8Bytes(canonicalize(without(authority, "authorityDigest")))) !==
      authority.authorityDigest
  ) throw new Error("Receiver terminal authority contradicts the custody bindings");

  const receiverEnvelope = records.get(
    "receiver-promotion-envelope",
  ) as PortablePromotionEnvelope;
  const receiver = verifyPortablePromotionEnvelope(receiverEnvelope);
  add(report, "receiver-terminal-receipt", receiver.valid,
    "The receiver terminal Promotion Receipt verifies independently");
  const receipt = receiverEnvelope.receipt;
  if (
    receiverEnvelope.receiptDigest !== bindings.receiverReceiptDigest ||
    receipt.decision.runId !== bindings.receiverRunId ||
    receipt.decision.agentId !== bindings.receiverAgentId ||
    receipt.decision.disposition !== bindings.disposition ||
    receipt.outcomeContract.digest !== bindings.outcomeContractDigest ||
    receipt.validationEvidence.root !== bindings.validationEvidenceRoot
  ) throw new Error("Receiver terminal receipt contradicts the custody bindings");
  if (
    bindings.disposition === "quarantined" &&
    (receipt.state.before.stateId !== receipt.state.after.stateId ||
      receipt.state.before.compositeHash !== receipt.state.after.compositeHash)
  ) throw new Error("Quarantined receiver custody evidence advanced Canonical State");
  add(report, "authority-links", true,
    "Producer evidence, Admission, reviewed approval, terminal authority, and receiver receipt form one closed path");
}

function assertPacket(value: unknown): ReceiverCustodyPacket {
  const packet = asRecord(value, "receiver custody packet");
  exactKeys(packet, ["schema", "schemaVersion", "envelope", "records", "anchors"]);
  if (
    packet.schema !== "agent-airlock/portable-receiver-chain-of-custody" ||
    packet.schemaVersion !== 1 ||
    !Array.isArray(packet.records) ||
    !Array.isArray(packet.anchors) ||
    packet.anchors.length !== 0
  ) throw new Error("Receiver custody packet protocol is invalid");
  const envelope = asRecord(packet.envelope, "receiver custody envelope");
  exactKeys(envelope, ["schema", "schemaVersion", "manifest", "manifestDigest", "signatureAlgorithm", "signature", "keyId", "publicJwk"]);
  if (
    envelope.schema !== "agent-airlock/receiver-custody-envelope" ||
    envelope.schemaVersion !== 1 ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    typeof envelope.signature !== "string" ||
    !isDigest(envelope.manifestDigest) ||
    !isDigest(envelope.keyId)
  ) throw new Error("Receiver custody envelope protocol is invalid");
  assertManifest(envelope.manifest);
  assertPortablePublicJwk(envelope.publicJwk);
  if (packet.records.length !== envelope.manifest.records.length) {
    throw new Error("Receiver custody packet contains an uncommitted or missing record");
  }
  const packetRecordIds = new Set<string>();
  for (const item of packet.records) {
    const record = asRecord(item, "receiver custody record");
    exactKeys(record, ["recordId", "canonicalBytes"]);
    assertIdentifier(record.recordId, "record identity");
    if (typeof record.canonicalBytes !== "string") {
      throw new Error("Receiver custody record bytes are invalid");
    }
    if (packetRecordIds.has(record.recordId)) {
      throw new Error("Receiver custody packet contains duplicate record identities");
    }
    packetRecordIds.add(record.recordId);
  }
  for (const descriptor of envelope.manifest.records) {
    if (!packetRecordIds.has(descriptor.recordId)) {
      throw new Error(`Receiver custody record ${descriptor.recordId} is missing`);
    }
  }
  return value as ReceiverCustodyPacket;
}

function assertManifest(value: unknown): asserts value is ReceiverCustodyManifest {
  const manifest = asRecord(value, "receiver custody manifest");
  exactKeys(manifest, ["schema", "schemaVersion", "profile", "records", "bindings"]);
  if (
    manifest.schema !== "agent-airlock/receiver-custody-manifest" ||
    manifest.schemaVersion !== 1 ||
    manifest.profile !== "full-audit" ||
    !Array.isArray(manifest.records)
  ) throw new Error("Receiver custody manifest protocol is invalid");
  const ids = new Set<string>();
  const roles = new Set<string>();
  for (const item of manifest.records) {
    const descriptor = asRecord(item, "receiver custody descriptor");
    exactKeys(descriptor, ["recordId", "role", "trustDomain", "schema", "schemaVersion", "mediaType", "canonicalization", "digestAlgorithm", "byteLength", "digest", "signingRequirement"]);
    assertIdentifier(descriptor.recordId, "record identity");
    if (ids.has(descriptor.recordId as string) || roles.has(descriptor.role as string)) {
      throw new Error("Receiver custody descriptors must have unique identities and roles");
    }
    ids.add(descriptor.recordId as string);
    roles.add(descriptor.role as string);
    if (!Object.hasOwn(ROLE_REQUIREMENTS, String(descriptor.role))) {
      throw new Error("Receiver custody record role is invalid");
    }
    const role = descriptor.role as ReceiverCustodyRecordRole;
    const requirement = ROLE_REQUIREMENTS[role];
    if (
      descriptor.trustDomain !== requirement.trustDomain ||
      descriptor.schema !== requirement.schema ||
      descriptor.signingRequirement !== requirement.signingRequirement ||
      descriptor.mediaType !== "application/json" ||
      descriptor.canonicalization !== "RFC8785" ||
      descriptor.digestAlgorithm !== "SHA-256" ||
      !Number.isSafeInteger(descriptor.schemaVersion) ||
      !Number.isSafeInteger(descriptor.byteLength) ||
      (descriptor.byteLength as number) < 2 ||
      !isDigest(descriptor.digest)
    ) throw new Error("Receiver custody record descriptor is invalid");
  }
  const bindings = asRecord(manifest.bindings, "receiver custody bindings");
  exactKeys(bindings, ["admissionId", "importIdentifier", "producerId", "receiverAgentId", "receiverRunId", "producerReceiptDigest", "artifactDigest", "admissionRecordDigest", "approvalDecisionDigest", "decisionContextDigest", "terminalAuthorityDigest", "receiverReceiptDigest", "outcomeContractDigest", "validationEvidenceRoot", "disposition"]);
  for (const key of ["admissionId", "importIdentifier", "producerReceiptDigest", "artifactDigest", "admissionRecordDigest", "terminalAuthorityDigest", "receiverReceiptDigest", "outcomeContractDigest", "validationEvidenceRoot"] as const) {
    if (!isDigest(bindings[key])) throw new Error(`Receiver custody ${key} is invalid`);
  }
  if (bindings.approvalDecisionDigest !== null && !isDigest(bindings.approvalDecisionDigest)) throw new Error("Receiver custody approval digest is invalid");
  if (bindings.decisionContextDigest !== null && !isDigest(bindings.decisionContextDigest)) throw new Error("Receiver custody review digest is invalid");
  for (const key of ["producerId", "receiverAgentId", "receiverRunId"] as const) assertIdentifier(bindings[key], key);
  if (!["promoted", "quarantined"].includes(String(bindings.disposition))) throw new Error("Receiver custody disposition is invalid");
}

function asEd25519PrivateKey(input: KeyObject | string | Buffer): KeyObject {
  const key = input instanceof KeyObject ? input : createPrivateKey(input);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Receiver custody signing requires an Ed25519 private key");
  }
  return key;
}

function digestBytes(digest: ReceiptDigest): Buffer {
  if (!isDigest(digest)) throw new Error("Receiver custody digest is invalid");
  return Buffer.from(digest.slice(7), "hex");
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = { ...value };
  delete result[key];
  return result;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error("Receiver custody object has unknown or missing fields");
  }
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Receiver custody ${name} is invalid`);
  }
}

function emptyReport(): ReceiverCustodyVerificationReport {
  return {
    valid: false,
    manifestDigest: null,
    receiverKeyId: null,
    producerReceiptDigest: null,
    receiverReceiptDigest: null,
    story: null,
    checks: [],
  };
}

function add(
  report: ReceiverCustodyVerificationReport,
  name: string,
  valid: boolean,
  detail: string,
): void {
  report.checks.push({ name, valid, detail });
}
