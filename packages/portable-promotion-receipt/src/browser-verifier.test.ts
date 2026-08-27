import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  verifySignedPolicyAuthorityRotationEnvelopeInBrowser,
  verifySignedSigningKeyTrustPolicyEnvelopeInBrowser,
  verifyPortableDecisionChainInBrowser,
  verifyPortableEvidencePacketInBrowser,
  verifyPortablePromotionEnvelopeInBrowser,
  verifyPortablePromotionEnvelopeJsonInBrowser,
} from "./browser-verifier.js";
import {
  generatePortableSigningKey,
  signPortableReceipt,
  signPolicyAuthorityRotation,
  signSigningKeyTrustPolicy,
} from "./crypto.js";
import { buildPortableEvidencePacket } from "./evidence-packet.js";
import { encodeOfflineEvmAnchorPayload } from "./evm.js";
import {
  createSignedTransparencyCheckpoint,
  createTransparencyInclusionProof,
} from "./transparency.js";
import type {
  PortablePromotionEnvelope,
  SigningKeyTrustPolicy,
} from "./types.js";

async function goldenEnvelope(): Promise<PortablePromotionEnvelope> {
  const source = await readFile(
    new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
    "utf8",
  );
  return (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
}

describe("browser-local portable receipt verifier", () => {
  it("verifies a complete decision chain with Web Crypto and no server", async () => {
    const template = await goldenEnvelope();
    const key = generatePortableSigningKey();
    const parent = signPortableReceipt({
      receipt: template.receipt,
      privateKey: key.privateKeyPem,
      disclosures: [],
    });
    const childReceipt = structuredClone(parent.receipt);
    childReceipt.decision.runId = "run-browser-repair";
    childReceipt.state.before = structuredClone(parent.receipt.state.after);
    childReceipt.ancestry = {
      rootRunId: parent.receipt.decision.runId,
      parentRunId: parent.receipt.decision.runId,
      depth: 1,
      maxDepth: parent.receipt.ancestry.maxDepth,
      previousReceiptDigest: parent.receiptDigest,
    };
    const child = signPortableReceipt({
      receipt: childReceipt,
      privateKey: key.privateKeyPem,
      disclosures: [],
    });
    const chain = {
      schema: "agent-airlock/portable-decision-chain" as const,
      schemaVersion: 1 as const,
      packets: [parent, child].map((envelope) =>
        buildPortableEvidencePacket({ envelope, anchor: null, evmPayload: null }),
      ),
    };

    expect((await verifyPortableDecisionChainInBrowser(chain)).valid).toBe(true);
    chain.packets.reverse();
    expect((await verifyPortableDecisionChainInBrowser(chain)).valid).toBe(false);
  });

  it("verifies a complete evidence packet with Web Crypto and no server", async () => {
    const envelope = await goldenEnvelope();
    const checkpointKey = generatePortableSigningKey();
    const checkpoint = createSignedTransparencyCheckpoint({
      receiptDigests: [envelope.receiptDigest],
      priorCheckpointDigest: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      privateKey: checkpointKey.privateKeyPem,
    });
    const packet = buildPortableEvidencePacket({
      envelope,
      anchor: {
        checkpoint,
        inclusionProof: createTransparencyInclusionProof(
          [envelope.receiptDigest],
          0,
        ),
      },
      evmPayload: encodeOfflineEvmAnchorPayload(envelope.receiptDigest),
    });

    const report = await verifyPortableEvidencePacketInBrowser(packet);
    expect(report).toMatchObject({
      valid: true,
      anchor: { valid: true },
      evmPayload: { valid: true },
    });

    packet.evmPayload!.calldata = `0xeecdf927${"ff".repeat(32)}`;
    expect((await verifyPortableEvidencePacketInBrowser(packet)).valid).toBe(false);
  });

  it("verifies authority rotation continuity with Web Crypto", async () => {
    const previous = generatePortableSigningKey();
    const next = generatePortableSigningKey();
    const signed = signPolicyAuthorityRotation({
      rotation: {
        schema: "agent-airlock/policy-authority-rotation",
        schemaVersion: 1,
        rotationId: "browser-authority-rotation-1",
        issuedAt: "2026-08-25T00:00:00.000Z",
        effectiveAt: "2026-08-26T00:00:00.000Z",
        expiresAt: "2027-08-26T00:00:00.000Z",
        previousAuthorityKeyId: previous.keyId,
        nextAuthorityKeyId: next.keyId,
        nextAuthorityPublicJwk: next.publicJwk,
      },
      privateKey: previous.privateKeyPem,
    });

    const trusted = await verifySignedPolicyAuthorityRotationEnvelopeInBrowser(
      signed,
      [previous.keyId],
      { evaluatedAt: "2026-08-27T00:00:00.000Z" },
    );
    const unpinned = await verifySignedPolicyAuthorityRotationEnvelopeInBrowser(
      signed,
      [],
      { evaluatedAt: "2026-08-27T00:00:00.000Z" },
    );

    expect(trusted).toMatchObject({
      valid: true,
      nextAuthorityKeyId: next.keyId,
    });
    expect(unpinned).toMatchObject({
      valid: false,
      previousAuthorityTrusted: false,
    });
  });

  it("requires an out-of-band authority fingerprint for signed trust policy", async () => {
    const envelope = await goldenEnvelope();
    const authority = generatePortableSigningKey();
    const policy: SigningKeyTrustPolicy = {
      schema: "agent-airlock/signing-key-trust-policy",
      schemaVersion: 1,
      policyId: "browser-policy-v1",
      issuedAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2027-08-25T00:00:00.000Z",
      keys: [
        {
          keyId: envelope.keyId,
          status: "active",
          validFrom: "2026-08-25T00:00:00.000Z",
          validUntil: null,
          agentIds: ["agent-golden"],
          dispositions: ["promoted"],
          note: null,
        },
      ],
    };
    const signed = signSigningKeyTrustPolicy({
      policy,
      privateKey: authority.privateKeyPem,
    });

    const trusted = await verifySignedSigningKeyTrustPolicyEnvelopeInBrowser(
      signed,
      [authority.keyId],
    );
    const unpinned = await verifySignedSigningKeyTrustPolicyEnvelopeInBrowser(
      signed,
      [],
    );
    const tampered = structuredClone(signed);
    tampered.policy.keys[0]!.status = "compromised";
    const altered = await verifySignedSigningKeyTrustPolicyEnvelopeInBrowser(
      tampered,
      [authority.keyId],
    );

    expect(trusted).toMatchObject({
      valid: true,
      cryptographicallyValid: true,
      authorityTrusted: true,
      authorityKeyId: authority.keyId,
    });
    expect(unpinned).toMatchObject({
      valid: false,
      cryptographicallyValid: true,
      authorityTrusted: false,
    });
    expect(altered).toMatchObject({
      valid: false,
      cryptographicallyValid: false,
      authorityTrusted: true,
    });
  });

  it("verifies the published envelope with Web Crypto and no server", async () => {
    const envelope = await goldenEnvelope();
    const report = await verifyPortablePromotionEnvelopeJsonInBrowser(
      JSON.stringify(envelope),
    );

    expect(report.valid).toBe(true);
    expect(report.receiptDigest).toBe(envelope.receiptDigest);
    expect(report.checks.map((check) => check.name)).toEqual([
      "receipt-schema",
      "receipt-digest",
      "public-key-fingerprint",
      "signature",
      "evidence-disclosures",
    ]);
  });

  it("rejects a validly shaped receipt whose signed decision was changed", async () => {
    const envelope = structuredClone(await goldenEnvelope());
    envelope.receipt.outcomeContract.version += 1;

    const report = await verifyPortablePromotionEnvelopeInBrowser(envelope);

    expect(report.valid).toBe(false);
    expect(report.checks.find((check) => check.name === "receipt-digest")?.valid).toBe(
      false,
    );
    expect(report.provenClaims).toEqual([]);
  });

  it("fails oversized and duplicate-key documents before cryptography", async () => {
    const oversized = await verifyPortablePromotionEnvelopeJsonInBrowser(
      JSON.stringify({ padding: "x".repeat(1_048_576) }),
    );
    const duplicate = await verifyPortablePromotionEnvelopeJsonInBrowser(
      '{"schema":"one","schema":"two"}',
    );

    expect(oversized.valid).toBe(false);
    expect(duplicate.valid).toBe(false);
    expect(oversized.checks[0]?.detail).toContain("byte limit");
    expect(duplicate.checks[0]?.detail).toContain("duplicate key");
  });
});
