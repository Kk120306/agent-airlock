import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  PortablePromotionEnvelope,
  SigningKeyTrustPolicy,
} from "./types.js";
import {
  evaluateSigningKeyTrust,
  parseSigningKeyTrustPolicyJson,
  parseSignedSigningKeyTrustPolicyEnvelopeJson,
} from "./trust-policy.js";
import {
  digestSigningKeyTrustPolicy,
  generatePortableSigningKey,
  signSigningKeyTrustPolicy,
  verifyPortableSignature,
} from "./crypto.js";

async function goldenEnvelope(): Promise<PortablePromotionEnvelope> {
  const source = await readFile(
    new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
    "utf8",
  );
  return (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
}

function policyFor(envelope: PortablePromotionEnvelope): SigningKeyTrustPolicy {
  return {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId: "judge-policy-v1",
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
        note: "Hackathon judge trust root",
      },
    ],
  };
}

describe("signing-key trust policy", () => {
  it("signs a policy under a separate authority domain", async () => {
    const policy = policyFor(await goldenEnvelope());
    const authority = generatePortableSigningKey();
    const signed = signSigningKeyTrustPolicy({
      policy,
      privateKey: authority.privateKeyPem,
    });
    const parsed = parseSignedSigningKeyTrustPolicyEnvelopeJson(
      JSON.stringify(signed),
    );

    expect(parsed.authorityKeyId).toBe(authority.keyId);
    expect(parsed.policyDigest).toBe(digestSigningKeyTrustPolicy(policy));
    expect(
      verifyPortableSignature({
        digest: parsed.policyDigest,
        signature: parsed.signature,
        publicJwk: parsed.authorityPublicJwk,
        domain: "trust-policy",
      }),
    ).toBe(true);
  });

  it("separates valid cryptography from scoped organizational trust", async () => {
    const envelope = await goldenEnvelope();
    const policy = parseSigningKeyTrustPolicyJson(JSON.stringify(policyFor(envelope)));

    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: true,
        evaluatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).toMatchObject({ trusted: true, status: "trusted", policyId: "judge-policy-v1" });
  });

  it("fails closed for compromised, expired, out-of-window, and invalid proofs", async () => {
    const envelope = await goldenEnvelope();
    const policy = policyFor(envelope);
    const evaluatedAt = "2026-08-27T00:00:00.000Z";

    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: false,
        evaluatedAt,
      }).status,
    ).toBe("cryptographic-proof-invalid");

    policy.keys[0]!.status = "compromised";
    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: true,
        evaluatedAt,
      }).status,
    ).toBe("compromised");

    policy.keys[0]!.status = "active";
    policy.issuedAt = "2026-08-28T00:00:00.000Z";
    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: true,
        evaluatedAt,
      }).status,
    ).toBe("policy-not-yet-effective");

    policy.issuedAt = "2026-08-25T00:00:00.000Z";
    policy.expiresAt = "2026-08-26T00:00:00.000Z";
    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: true,
        evaluatedAt,
      }).status,
    ).toBe("policy-expired");

    policy.expiresAt = "2027-08-25T00:00:00.000Z";
    policy.keys[0]!.validFrom = "2026-08-27T00:00:00.000Z";
    expect(
      evaluateSigningKeyTrust(envelope, policy, {
        cryptographicValid: true,
        evaluatedAt,
      }).status,
    ).toBe("outside-validity-window");
  });

  it("rejects unknown fields, duplicate keys, unsorted scopes, and oversized input", async () => {
    const envelope = await goldenEnvelope();
    const policy = policyFor(envelope) as SigningKeyTrustPolicy & { surprise?: boolean };
    policy.surprise = true;
    expect(() => parseSigningKeyTrustPolicyJson(JSON.stringify(policy))).toThrow(
      /unsupported fields/,
    );
    expect(() =>
      parseSigningKeyTrustPolicyJson('{"schema":"one","schema":"two"}'),
    ).toThrow(/duplicate key/);

    delete policy.surprise;
    policy.keys[0]!.agentIds = ["z-agent", "a-agent"];
    expect(() => parseSigningKeyTrustPolicyJson(JSON.stringify(policy))).toThrow(
      /unique and sorted/,
    );
    expect(() => parseSigningKeyTrustPolicyJson(JSON.stringify(policyFor(envelope)), 32)).toThrow(
      /byte limit/,
    );
  });
});
