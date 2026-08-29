import { describe, expect, it } from "vitest";
import {
  digestPolicyAuthorityRotation,
  generatePortableSigningKey,
  signPolicyAuthorityRotation,
  signSigningKeyTrustPolicy,
  verifySignedPolicyAuthorityRotationEnvelope,
  verifySignedSigningKeyTrustPolicyEnvelope,
} from "./crypto.js";
import {
  parseSignedPolicyAuthorityRotationEnvelopeJson,
} from "./authority-rotation.js";
import type {
  PolicyAuthorityRotation,
  SigningKeyTrustPolicy,
} from "./types.js";

function rotationFixture(): {
  previous: ReturnType<typeof generatePortableSigningKey>;
  next: ReturnType<typeof generatePortableSigningKey>;
  rotation: PolicyAuthorityRotation;
} {
  const previous = generatePortableSigningKey();
  const next = generatePortableSigningKey();
  return {
    previous,
    next,
    rotation: {
      schema: "agent-airlock/policy-authority-rotation",
      schemaVersion: 1,
      rotationId: "authority-rotation-1",
      issuedAt: "2026-08-25T00:00:00.000Z",
      effectiveAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2027-08-26T00:00:00.000Z",
      previousAuthorityKeyId: previous.keyId,
      nextAuthorityKeyId: next.keyId,
      nextAuthorityPublicJwk: next.publicJwk,
    },
  };
}

describe("policy-authority rotation", () => {
  it("derives a new authority only from a valid transition signed by the pinned root", () => {
    const { previous, next, rotation } = rotationFixture();
    const signed = signPolicyAuthorityRotation({
      rotation,
      privateKey: previous.privateKeyPem,
    });
    const parsed = parseSignedPolicyAuthorityRotationEnvelopeJson(
      JSON.stringify(signed),
    );
    const report = verifySignedPolicyAuthorityRotationEnvelope(
      parsed,
      [previous.keyId],
      { evaluatedAt: "2026-08-27T00:00:00.000Z" },
    );

    expect(parsed.rotationDigest).toBe(digestPolicyAuthorityRotation(rotation));
    expect(report).toMatchObject({
      valid: true,
      cryptographicallyValid: true,
      previousAuthorityTrusted: true,
      temporallyValid: true,
      previousAuthorityKeyId: previous.keyId,
      nextAuthorityKeyId: next.keyId,
    });
  });

  it("rejects an unpinned, tampered, early, or expired transition", () => {
    const { previous, rotation } = rotationFixture();
    const signed = signPolicyAuthorityRotation({
      rotation,
      privateKey: previous.privateKeyPem,
    });

    expect(
      verifySignedPolicyAuthorityRotationEnvelope(signed, [], {
        evaluatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).toMatchObject({ valid: false, previousAuthorityTrusted: false });
    expect(
      verifySignedPolicyAuthorityRotationEnvelope(signed, [previous.keyId], {
        evaluatedAt: "2026-08-25T12:00:00.000Z",
      }),
    ).toMatchObject({ valid: false, temporallyValid: false });
    expect(
      verifySignedPolicyAuthorityRotationEnvelope(signed, [previous.keyId], {
        evaluatedAt: "2027-08-27T00:00:00.000Z",
      }),
    ).toMatchObject({ valid: false, temporallyValid: false });

    const tampered = structuredClone(signed);
    tampered.rotation.rotationId = "attacker-rotation";
    expect(
      verifySignedPolicyAuthorityRotationEnvelope(tampered, [previous.keyId], {
        evaluatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).toMatchObject({ valid: false, cryptographicallyValid: false });
  });

  it("authorizes a policy from the next key only after rotation verification", () => {
    const { previous, next, rotation } = rotationFixture();
    const rotationReport = verifySignedPolicyAuthorityRotationEnvelope(
      signPolicyAuthorityRotation({
        rotation,
        privateKey: previous.privateKeyPem,
      }),
      [previous.keyId],
      { evaluatedAt: "2026-08-27T00:00:00.000Z" },
    );
    const policy: SigningKeyTrustPolicy = {
      schema: "agent-airlock/signing-key-trust-policy",
      schemaVersion: 1,
      policyId: "rotated-policy-v1",
      issuedAt: "2026-08-27T00:00:00.000Z",
      expiresAt: null,
      keys: [],
    };
    const signedPolicy = signSigningKeyTrustPolicy({
      policy,
      privateKey: next.privateKeyPem,
    });

    expect(
      verifySignedSigningKeyTrustPolicyEnvelope(signedPolicy, [previous.keyId]).valid,
    ).toBe(false);
    expect(rotationReport.nextAuthorityKeyId).toBe(next.keyId);
    expect(
      verifySignedSigningKeyTrustPolicyEnvelope(signedPolicy, [
        previous.keyId,
        rotationReport.nextAuthorityKeyId!,
      ]).valid,
    ).toBe(true);
  });
});
