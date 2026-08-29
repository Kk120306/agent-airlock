import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { canonicalize } from "./canonical.js";
import type {
  PortableEvidenceDisclosure,
  PolicyAuthorityRotation,
  PolicyAuthorityRotationVerificationReport,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
  PortablePublicJwk,
  PortableSigningKeyMaterial,
  ReceiptDigest,
  SignedPolicyAuthorityRotationEnvelope,
  SignedSigningKeyTrustPolicyEnvelope,
  SigningKeyTrustPolicy,
  TrustPolicyVerificationReport,
  VerificationCheck,
} from "./types.js";
import {
  assertPolicyAuthorityRotation,
  assertSignedPolicyAuthorityRotationEnvelope,
} from "./authority-rotation.js";
import {
  assertPortablePromotionEnvelope,
  assertPortablePromotionReceipt,
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
  safePortableDiagnostic,
} from "./validation.js";
import {
  assertSignedSigningKeyTrustPolicyEnvelope,
  assertSigningKeyTrustPolicy,
} from "./trust-policy.js";

const RECEIPT_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-portable-receipt-signature-v1\0",
  "utf8",
);
const CHECKPOINT_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-portable-transparency-checkpoint-signature-v1\0",
  "utf8",
);
const TRUST_POLICY_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-signing-key-trust-policy-v1\0",
  "utf8",
);
const AUTHORITY_ROTATION_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-policy-authority-rotation-v1\0",
  "utf8",
);

export function sha256Digest(value: string | Uint8Array): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestPortableReceipt(
  receipt: PortablePromotionReceipt,
): ReceiptDigest {
  assertPortablePromotionReceipt(receipt);
  return sha256Digest(Buffer.from(canonicalize(receipt), "utf8"));
}

export function publicJwkFingerprint(jwk: PortablePublicJwk): ReceiptDigest {
  assertPortablePublicJwk(jwk);
  return sha256Digest(Buffer.from(canonicalize(jwk), "utf8"));
}

export function digestSigningKeyTrustPolicy(
  policy: SigningKeyTrustPolicy,
): ReceiptDigest {
  assertSigningKeyTrustPolicy(policy);
  return sha256Digest(Buffer.from(canonicalize(policy), "utf8"));
}

export function digestPolicyAuthorityRotation(
  rotation: PolicyAuthorityRotation,
): ReceiptDigest {
  assertPolicyAuthorityRotation(rotation);
  return sha256Digest(Buffer.from(canonicalize(rotation), "utf8"));
}

export function generatePortableSigningKey(): PortableSigningKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = exportPortablePublicJwk(publicKey);
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicJwk,
    keyId: publicJwkFingerprint(publicJwk),
  };
}

export function exportPortablePublicJwk(
  key: KeyObject | string | Buffer,
): PortablePublicJwk {
  const parsed = key instanceof KeyObject ? key : createPublicKey(key);
  const publicKey = parsed.type === "public" ? parsed : createPublicKey(parsed);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Portable receipt signing key must be Ed25519");
  }
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk = {
    crv: exported.crv,
    kty: exported.kty,
    x: exported.x,
  };
  assertPortablePublicJwk(publicJwk);
  return publicJwk;
}

export function signPortableReceipt(input: {
  receipt: PortablePromotionReceipt;
  privateKey: KeyObject | string | Buffer;
  disclosures?: readonly PortableEvidenceDisclosure[];
}): PortablePromotionEnvelope {
  assertPortablePromotionReceipt(input.receipt);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const publicJwk = exportPortablePublicJwk(privateKey);
  const receiptDigest = digestPortableReceipt(input.receipt);
  const signature = sign(
    null,
    signatureMessage(RECEIPT_SIGNATURE_DOMAIN, receiptDigest),
    privateKey,
  ).toString("base64url");
  const envelope: PortablePromotionEnvelope = {
    schema: "agent-airlock/portable-promotion-envelope",
    schemaVersion: 1,
    receipt: structuredClone(input.receipt),
    receiptDigest,
    signatureAlgorithm: "Ed25519",
    signature,
    keyId: publicJwkFingerprint(publicJwk),
    publicJwk,
    disclosures: structuredClone([...(input.disclosures ?? [])]),
  };
  assertPortablePromotionEnvelope(envelope);
  return envelope;
}

export function signSigningKeyTrustPolicy(input: {
  policy: SigningKeyTrustPolicy;
  privateKey: KeyObject | string | Buffer;
}): SignedSigningKeyTrustPolicyEnvelope {
  assertSigningKeyTrustPolicy(input.policy);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const authorityPublicJwk = exportPortablePublicJwk(privateKey);
  const policyDigest = digestSigningKeyTrustPolicy(input.policy);
  const envelope: SignedSigningKeyTrustPolicyEnvelope = {
    schema: "agent-airlock/signed-signing-key-trust-policy",
    schemaVersion: 1,
    policy: structuredClone(input.policy),
    policyDigest,
    signatureAlgorithm: "Ed25519",
    signature: sign(
      null,
      signatureMessage(TRUST_POLICY_SIGNATURE_DOMAIN, policyDigest),
      privateKey,
    ).toString("base64url"),
    authorityKeyId: publicJwkFingerprint(authorityPublicJwk),
    authorityPublicJwk,
  };
  assertSignedSigningKeyTrustPolicyEnvelope(envelope);
  return envelope;
}

export function signPolicyAuthorityRotation(input: {
  rotation: PolicyAuthorityRotation;
  privateKey: KeyObject | string | Buffer;
}): SignedPolicyAuthorityRotationEnvelope {
  assertPolicyAuthorityRotation(input.rotation);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const previousAuthorityPublicJwk = exportPortablePublicJwk(privateKey);
  const rotationDigest = digestPolicyAuthorityRotation(input.rotation);
  const envelope: SignedPolicyAuthorityRotationEnvelope = {
    schema: "agent-airlock/signed-policy-authority-rotation",
    schemaVersion: 1,
    rotation: structuredClone(input.rotation),
    rotationDigest,
    signatureAlgorithm: "Ed25519",
    signature: sign(
      null,
      signatureMessage(AUTHORITY_ROTATION_SIGNATURE_DOMAIN, rotationDigest),
      privateKey,
    ).toString("base64url"),
    previousAuthorityPublicJwk,
  };
  assertSignedPolicyAuthorityRotationEnvelope(envelope);
  return envelope;
}

export function verifySignedPolicyAuthorityRotationEnvelope(
  value: unknown,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
  options: { evaluatedAt?: string } = {},
): PolicyAuthorityRotationVerificationReport {
  let envelope: SignedPolicyAuthorityRotationEnvelope;
  try {
    assertTrustedAuthorityKeyIds(trustedAuthorityKeyIds);
    assertSignedPolicyAuthorityRotationEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidAuthorityRotationReport(error);
  }
  const checks: VerificationCheck[] = [];
  checks.push({
    name: "rotation-schema",
    valid: true,
    detail: "The signed authority rotation uses the exact supported version 1 schema.",
  });
  const rotationDigest = digestPolicyAuthorityRotation(envelope.rotation);
  checks.push({
    name: "rotation-digest",
    valid: rotationDigest === envelope.rotationDigest,
    detail:
      rotationDigest === envelope.rotationDigest
        ? "The canonical rotation digest matches the signed envelope."
        : "The authority rotation does not match the claimed digest.",
  });
  const previousAuthorityKeyId = publicJwkFingerprint(
    envelope.previousAuthorityPublicJwk,
  );
  checks.push({
    name: "previous-authority-fingerprint",
    valid: previousAuthorityKeyId === envelope.rotation.previousAuthorityKeyId,
    detail:
      previousAuthorityKeyId === envelope.rotation.previousAuthorityKeyId
        ? "The previous authority fingerprint matches its included public key."
        : "The previous authority key does not match the rotation statement.",
  });
  const nextAuthorityKeyId = publicJwkFingerprint(
    envelope.rotation.nextAuthorityPublicJwk,
  );
  checks.push({
    name: "next-authority-fingerprint",
    valid: nextAuthorityKeyId === envelope.rotation.nextAuthorityKeyId,
    detail:
      nextAuthorityKeyId === envelope.rotation.nextAuthorityKeyId
        ? "The next authority fingerprint matches its included public key."
        : "The next authority key does not match the rotation statement.",
  });
  const signatureValid = verifyPortableSignature({
    digest: envelope.rotationDigest,
    signature: envelope.signature,
    publicJwk: envelope.previousAuthorityPublicJwk,
    domain: "authority-rotation",
  });
  checks.push({
    name: "rotation-signature",
    valid: signatureValid,
    detail: signatureValid
      ? "The previous authority signed the domain-separated rotation digest."
      : "The authority-rotation signature is invalid.",
  });
  const previousAuthorityTrusted = trustedAuthorityKeyIds.includes(
    envelope.rotation.previousAuthorityKeyId,
  );
  checks.push({
    name: "previous-authority-trust-root",
    valid: previousAuthorityTrusted,
    detail: previousAuthorityTrusted
      ? "The previous authority matches an evaluator-supplied trust root."
      : "The previous authority is not in the evaluator-supplied trust roots.",
  });
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const evaluationTimeValid = isTimestamp(evaluatedAt);
  const temporallyValid =
    evaluationTimeValid &&
    Date.parse(evaluatedAt) >= Date.parse(envelope.rotation.effectiveAt) &&
    (envelope.rotation.expiresAt === null ||
      Date.parse(evaluatedAt) <= Date.parse(envelope.rotation.expiresAt));
  checks.push({
    name: "rotation-validity-window",
    valid: temporallyValid,
    detail: temporallyValid
      ? "The authority rotation is effective at the evaluator-supplied time."
      : "The authority rotation is not effective at the evaluator-supplied time.",
  });
  const cryptographicallyValid = checks.slice(0, 5).every((check) => check.valid);
  const valid = cryptographicallyValid && previousAuthorityTrusted && temporallyValid;
  return {
    valid,
    cryptographicallyValid,
    previousAuthorityTrusted,
    temporallyValid,
    checks,
    rotation: valid ? structuredClone(envelope.rotation) : null,
    rotationDigest,
    previousAuthorityKeyId,
    nextAuthorityKeyId,
  };
}

export function verifySignedSigningKeyTrustPolicyEnvelope(
  value: unknown,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
): TrustPolicyVerificationReport {
  let envelope: SignedSigningKeyTrustPolicyEnvelope;
  try {
    assertTrustedAuthorityKeyIds(trustedAuthorityKeyIds);
    assertSignedSigningKeyTrustPolicyEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidTrustPolicyReport(error);
  }
  const checks: VerificationCheck[] = [];
  checks.push({
    name: "policy-schema",
    valid: true,
    detail: "The signed trust policy uses the exact supported version 1 schema.",
  });
  const policyDigest = digestSigningKeyTrustPolicy(envelope.policy);
  checks.push({
    name: "policy-digest",
    valid: policyDigest === envelope.policyDigest,
    detail:
      policyDigest === envelope.policyDigest
        ? "The canonical policy digest matches the signed envelope."
        : "The trust policy content does not match the claimed digest.",
  });
  const authorityKeyId = publicJwkFingerprint(envelope.authorityPublicJwk);
  checks.push({
    name: "authority-key-fingerprint",
    valid: authorityKeyId === envelope.authorityKeyId,
    detail:
      authorityKeyId === envelope.authorityKeyId
        ? "The authority key identifier matches the included Ed25519 public JWK."
        : "The authority public key does not match its claimed identifier.",
  });
  const signatureValid = verifyPortableSignature({
    digest: envelope.policyDigest,
    signature: envelope.signature,
    publicJwk: envelope.authorityPublicJwk,
    domain: "trust-policy",
  });
  checks.push({
    name: "policy-signature",
    valid: signatureValid,
    detail: signatureValid
      ? "The authority signature over the policy digest is valid."
      : "The trust-policy authority signature is invalid.",
  });
  const authorityTrusted = trustedAuthorityKeyIds.includes(envelope.authorityKeyId);
  checks.push({
    name: "authority-trust-root",
    valid: authorityTrusted,
    detail: authorityTrusted
      ? "The policy authority matches an evaluator-supplied trust root."
      : "The policy authority is not in the evaluator-supplied trust roots.",
  });
  const cryptographicallyValid = checks.slice(0, 4).every((check) => check.valid);
  const valid = cryptographicallyValid && authorityTrusted;
  return {
    valid,
    cryptographicallyValid,
    authorityTrusted,
    checks,
    policy: valid ? structuredClone(envelope.policy) : null,
    policyDigest,
    authorityKeyId,
  };
}

export function verifyPortableSignature(input: {
  digest: ReceiptDigest;
  signature: string;
  publicJwk: PortablePublicJwk;
  domain?: "receipt" | "checkpoint" | "trust-policy" | "authority-rotation";
}): boolean {
  try {
    assertPortablePublicJwk(input.publicJwk);
    const signatureBytes = decodeCanonicalBase64Url(input.signature, 64);
    if (signatureBytes.length !== 64) return false;
    const publicKey = createPublicKey({
      key: { ...input.publicJwk } as JsonWebKey,
      format: "jwk",
    });
    return verify(
      null,
      signatureMessage(
        input.domain === "checkpoint"
          ? CHECKPOINT_SIGNATURE_DOMAIN
          : input.domain === "trust-policy"
            ? TRUST_POLICY_SIGNATURE_DOMAIN
            : input.domain === "authority-rotation"
              ? AUTHORITY_ROTATION_SIGNATURE_DOMAIN
              : RECEIPT_SIGNATURE_DOMAIN,
        input.digest,
      ),
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function signCheckpointDigest(
  digest: ReceiptDigest,
  privateKeyInput: KeyObject | string | Buffer,
): { signature: string; publicJwk: PortablePublicJwk; keyId: ReceiptDigest } {
  const privateKey = asEd25519PrivateKey(privateKeyInput);
  const publicJwk = exportPortablePublicJwk(privateKey);
  return {
    signature: sign(
      null,
      signatureMessage(CHECKPOINT_SIGNATURE_DOMAIN, digest),
      privateKey,
    ).toString("base64url"),
    publicJwk,
    keyId: publicJwkFingerprint(publicJwk),
  };
}

function signatureMessage(domain: Buffer, digest: ReceiptDigest): Buffer {
  return Buffer.concat([
    domain,
    Buffer.from(digest.slice("sha256:".length), "hex"),
  ]);
}

function asEd25519PrivateKey(
  input: KeyObject | string | Buffer,
): KeyObject {
  const key = input instanceof KeyObject ? input : createPrivateKey(input);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Portable receipt signing key must be an Ed25519 private key");
  }
  return key;
}

function assertTrustedAuthorityKeyIds(values: readonly ReceiptDigest[]): void {
  const seen = new Set<ReceiptDigest>();
  if (values.length > 32) throw new Error("Too many trusted policy authorities");
  for (const value of values) {
    if (!isDigest(value) || seen.has(value)) {
      throw new Error("Trusted policy authority fingerprints are invalid or duplicated");
    }
    seen.add(value);
  }
}

function invalidTrustPolicyReport(error: unknown): TrustPolicyVerificationReport {
  return {
    valid: false,
    cryptographicallyValid: false,
    authorityTrusted: false,
    checks: [
      {
        name: "policy-schema",
        valid: false,
        detail: "The signed trust policy is structurally invalid: " + safePortableDiagnostic(error),
      },
    ],
    policy: null,
    policyDigest: null,
    authorityKeyId: null,
  };
}

function invalidAuthorityRotationReport(
  error: unknown,
): PolicyAuthorityRotationVerificationReport {
  return {
    valid: false,
    cryptographicallyValid: false,
    previousAuthorityTrusted: false,
    temporallyValid: false,
    checks: [
      {
        name: "rotation-schema",
        valid: false,
        detail:
          "The signed authority rotation is structurally invalid: " +
          safePortableDiagnostic(error),
      },
    ],
    rotation: null,
    rotationDigest: null,
    previousAuthorityKeyId: null,
    nextAuthorityKeyId: null,
  };
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
