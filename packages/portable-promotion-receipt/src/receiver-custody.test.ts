import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { canonicalize, utf8Bytes } from "./canonical.js";
import {
  generatePortableSigningKey,
  sha256Digest,
  signPortableReceipt,
} from "./crypto.js";
import {
  buildFederatedWorkBundle,
} from "./federated-work-bundle.js";
import {
  buildReceiverCustodyPacket,
  buildReceiverCustodyRecord,
  verifyReceiverCustodyPacket,
  type ReceiverCustodyManifest,
} from "./receiver-custody.js";
import type {
  PortablePromotionReceipt,
  ReceiptDigest,
  SigningKeyTrustPolicy,
} from "./types.js";
import { buildWorkspaceChangeSetEnvelope } from "./workspace-change-set.js";
import { verifyReceiverCustodyPacketInBrowser } from "./browser-verifier.js";

function digest(value: unknown): ReceiptDigest {
  return sha256Digest(utf8Bytes(canonicalize(value)));
}

function state(label: string) {
  return {
    stateId: label,
    compositeHash: digest(label),
    builtinResources: [],
    providerResources: [],
  };
}

function receipt(input: {
  runId: string;
  agentId: string;
  before: ReturnType<typeof state>;
  after: ReturnType<typeof state>;
}): PortablePromotionReceipt {
  return {
    protocol: {
      schema: "agent-airlock/portable-promotion-receipt",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
    },
    decision: {
      runId: input.runId,
      agentId: input.agentId,
      disposition: "promoted",
      decidedAt: "2026-08-28T00:00:00.000Z",
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: { before: input.before, after: input.after },
    outcomeContract: { schemaVersion: 1, version: 1, digest: digest("contract") },
    validationEvidence: {
      root: digest("validation"),
      leafCount: 0,
      ordering: "canonical-identity-ascending",
    },
    externalActions: { commitment: digest("effects"), deliveredCount: 0 },
    selection: null,
    assurance: null,
    ancestry: {
      rootRunId: input.runId,
      parentRunId: null,
      depth: 0,
      maxDepth: 2,
      previousReceiptDigest: null,
    },
  };
}

function trustPolicy(
  policyId: string,
  keyId: ReceiptDigest,
  agentId: string,
): SigningKeyTrustPolicy {
  return {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId,
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    keys: [{
      keyId,
      status: "active",
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      agentIds: [agentId],
      dispositions: ["promoted"],
      note: null,
    }],
  };
}

function fixture() {
  const producerKey = generatePortableSigningKey();
  const receiverKey = generatePortableSigningKey();
  const producerReceipt = signPortableReceipt({
    receipt: receipt({
      runId: "producer-run",
      agentId: "producer-agent",
      before: state("producer-before"),
      after: state("producer-after"),
    }),
    privateKey: producerKey.privateKeyPem,
  });
  const content = Buffer.from("custody proof\n", "utf8");
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: producerReceipt.receipt.state.before.compositeHash,
    resultStateDigest: producerReceipt.receipt.state.after.compositeHash,
    operations: [{
      operation: "add",
      path: "proof.txt",
      mediaType: "text/plain",
      encoding: "base64url",
      content: content.toString("base64url"),
      contentDigest: sha256Digest(content),
      byteLength: content.length,
      priorContentDigest: null,
    }],
  });
  const bundle = buildFederatedWorkBundle({
    receipt: producerReceipt,
    artifact,
    privateKey: producerKey.privateKeyPem,
  });
  const admissionId = digest("admission-id");
  const importIdentifier = digest("import-id");
  const admissionBody = {
    schema: "agent-airlock/federated-admission-record",
    schemaVersion: 1,
    admissionId,
    importIdentifier,
    transferId: "transfer-one",
    attemptDigest: digest("attempt"),
    evidenceDigest: digest("evidence"),
    producerId: "producer-one",
    localAgentId: "receiver-agent",
    candidateRunId: null,
    decision: {
      decision: "pending",
      reason: "approval-required",
      policyId: "receiver-policy",
      policyGeneration: 1,
      policyDigest: digest("policy"),
      producerId: "producer-one",
      receiptDigest: bundle.receipt.receiptDigest,
      artifactDigest: bundle.artifact.artifactDigest,
      evaluatedAt: "2026-08-28T00:00:01.000Z",
      detail: "Local approval is required",
    },
    recordedAt: "2026-08-28T00:00:01.000Z",
  };
  const admission = { ...admissionBody, recordDigest: digest(admissionBody) };
  const context = digest("review-context");
  const approvalBody = {
    schema: "agent-airlock/federated-approval-decision",
    schemaVersion: 2,
    approvalId: digest("approval-id"),
    admissionId,
    importIdentifier,
    pendingRecordDigest: admission.recordDigest,
    decisionContextDigest: context,
    localAgentId: "receiver-agent",
    operatorId: "local-operator",
    choice: "approve",
    reason: "Verified for local execution",
    decidedAt: "2026-08-28T00:00:02.000Z",
  };
  const approval = { ...approvalBody, recordDigest: digest(approvalBody) };
  const receiverReceipt = signPortableReceipt({
    receipt: receipt({
      runId: "receiver-run",
      agentId: "receiver-agent",
      before: state("receiver-before"),
      after: state("receiver-after"),
    }),
    privateKey: receiverKey.privateKeyPem,
  });
  const transaction = { id: "receiver-run", evidence: "bounded" };
  const authorityBody = {
    schemaVersion: 1,
    transactionEvidenceHash: digest(transaction),
    parentAuthorityDigest: null,
    candidateSetAuthorityDigest: null,
    runId: "receiver-run",
    agentId: "receiver-agent",
    disposition: "promoted",
    decidedAt: "2026-08-28T00:00:03.000Z",
  };
  const authority = {
    ...authorityBody,
    authorityDigest: digest(authorityBody),
  };
  const entries = [
    buildReceiverCustodyRecord({ recordId: "producer", role: "producer-work-bundle", trustDomain: "producer", schema: bundle.schema, schemaVersion: bundle.schemaVersion, signingRequirement: "nested-required", value: bundle }),
    buildReceiverCustodyRecord({ recordId: "admission", role: "receiver-admission", trustDomain: "receiver", schema: admission.schema, schemaVersion: admission.schemaVersion, signingRequirement: "manifest-covered", value: admission }),
    buildReceiverCustodyRecord({ recordId: "approval", role: "receiver-approval", trustDomain: "receiver", schema: approval.schema, schemaVersion: approval.schemaVersion, signingRequirement: "manifest-covered", value: approval }),
    buildReceiverCustodyRecord({ recordId: "authority", role: "receiver-terminal-authority", trustDomain: "receiver", schema: "agent-airlock/portable-decision-authority-commitment", schemaVersion: 1, signingRequirement: "manifest-covered", value: authority }),
    buildReceiverCustodyRecord({ recordId: "receiver-receipt", role: "receiver-promotion-envelope", trustDomain: "receiver", schema: receiverReceipt.schema, schemaVersion: receiverReceipt.schemaVersion, signingRequirement: "nested-and-manifest", value: receiverReceipt }),
  ];
  const manifest: ReceiverCustodyManifest = {
    schema: "agent-airlock/receiver-custody-manifest",
    schemaVersion: 1,
    profile: "full-audit",
    records: entries.map((entry) => entry.descriptor),
    bindings: {
      admissionId,
      importIdentifier,
      producerId: "producer-one",
      receiverAgentId: "receiver-agent",
      receiverRunId: "receiver-run",
      producerReceiptDigest: bundle.receipt.receiptDigest,
      artifactDigest: bundle.artifact.artifactDigest,
      admissionRecordDigest: admission.recordDigest,
      approvalDecisionDigest: approval.recordDigest,
      decisionContextDigest: context,
      terminalAuthorityDigest: authority.authorityDigest,
      receiverReceiptDigest: receiverReceipt.receiptDigest,
      outcomeContractDigest: receiverReceipt.receipt.outcomeContract.digest,
      validationEvidenceRoot: receiverReceipt.receipt.validationEvidence.root,
      disposition: "promoted",
    },
  };
  return {
    packet: buildReceiverCustodyPacket({
      manifest,
      records: entries.map((entry) => entry.record),
      privateKey: receiverKey.privateKeyPem,
    }),
    producerReceipt,
    receiverReceipt,
    receiverPrivateKey: receiverKey.privateKeyPem,
  };
}

describe("receiver custody closure", () => {
  it("verifies one complete producer-to-receiver authority path in Node and WebCrypto", async () => {
    const { packet } = fixture();
    const report = verifyReceiverCustodyPacket(packet);
    expect(report.valid).toBe(true);
    expect(report.checks.every((check) => check.valid)).toBe(true);
    const browserReport = await verifyReceiverCustodyPacketInBrowser(packet);
    expect(browserReport.valid).toBe(true);
    expect(browserReport.checks.every((check) => check.valid)).toBe(true);
  });

  it("rejects omission, substituted approval, and changed terminal evidence", () => {
    const omitted = structuredClone(fixture().packet);
    omitted.records = omitted.records.filter((record) => record.recordId !== "admission");
    expect(verifyReceiverCustodyPacket(omitted).valid).toBe(false);

    const substituted = structuredClone(fixture().packet);
    const approval = substituted.records.find((record) => record.recordId === "approval")!;
    approval.canonicalBytes = Buffer.from(canonicalize({ substitution: true }), "utf8").toString("base64url");
    expect(verifyReceiverCustodyPacket(substituted).valid).toBe(false);

    const terminal = structuredClone(fixture().packet);
    terminal.envelope.manifest.bindings.validationEvidenceRoot = digest("changed");
    expect(verifyReceiverCustodyPacket(terminal).valid).toBe(false);
  });

  it("rejects duplicate, uncommitted, and role-confused records", () => {
    const duplicate = structuredClone(fixture().packet);
    duplicate.records.push(structuredClone(duplicate.records[0]!));
    expect(verifyReceiverCustodyPacket(duplicate).valid).toBe(false);

    const uncommitted = structuredClone(fixture().packet);
    uncommitted.records.push({
      recordId: "uncommitted",
      canonicalBytes: Buffer.from("{}", "utf8").toString("base64url"),
    });
    expect(verifyReceiverCustodyPacket(uncommitted).valid).toBe(false);

    const roleConfused = structuredClone(fixture().packet);
    const producer = roleConfused.envelope.manifest.records.find(
      (record) => record.role === "producer-work-bundle",
    )!;
    producer.trustDomain = "receiver";
    expect(verifyReceiverCustodyPacket(roleConfused).valid).toBe(false);
  });

  it("rejects a tampered receiver signature in WebCrypto", async () => {
    const tampered = structuredClone(fixture().packet);
    tampered.envelope.signature = `${tampered.envelope.signature.slice(0, -1)}A`;
    expect((await verifyReceiverCustodyPacketInBrowser(tampered)).valid).toBe(false);
  });

  it("evaluates producer and receiver identities under separate policies", () => {
    const { packet, producerReceipt, receiverReceipt } = fixture();
    const report = verifyReceiverCustodyPacket(packet, {
      producer: trustPolicy("producer-policy", producerReceipt.keyId, "producer-agent"),
      receiver: trustPolicy("receiver-policy", receiverReceipt.keyId, "receiver-agent"),
      evaluatedAt: "2026-08-28T00:00:04.000Z",
    });
    expect(report.valid).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "producer-trust-domain", valid: true }),
      expect.objectContaining({ name: "receiver-trust-domain", valid: true }),
    ]));

    const conflated = verifyReceiverCustodyPacket(packet, {
      producer: trustPolicy("shared-policy", producerReceipt.keyId, "producer-agent"),
      receiver: trustPolicy("shared-policy", receiverReceipt.keyId, "receiver-agent"),
    });
    expect(conflated.valid).toBe(false);
  });

  it("rejects changed review context and two terminal authorities", () => {
    const changedContext = structuredClone(fixture().packet);
    changedContext.envelope.manifest.bindings.decisionContextDigest = digest("stale-context");
    expect(verifyReceiverCustodyPacket(changedContext).valid).toBe(false);

    const { packet, receiverPrivateKey } = fixture();
    const terminalDescriptor = packet.envelope.manifest.records.find(
      (record) => record.role === "receiver-terminal-authority",
    )!;
    const terminalRecord = packet.records.find(
      (record) => record.recordId === terminalDescriptor.recordId,
    )!;
    expect(() => buildReceiverCustodyPacket({
      manifest: {
        ...packet.envelope.manifest,
        records: [
          ...packet.envelope.manifest.records,
          { ...terminalDescriptor, recordId: "conflicting-terminal" },
        ],
      },
      records: [
        ...packet.records,
        { ...terminalRecord, recordId: "conflicting-terminal" },
      ],
      privateKey: receiverPrivateKey,
    })).toThrow(/unique identities and roles/);
  });

  it("rejects unsafe evidence before signing", () => {
    expect(() => buildReceiverCustodyRecord({
      recordId: "unsafe",
      role: "receiver-admission",
      trustDomain: "receiver",
      schema: "unsafe",
      schemaVersion: 1,
      signingRequirement: "manifest-covered",
      value: { credential: "Authorization: Bearer secret-value" },
    })).toThrow(/evidence boundary/);
  });
});
