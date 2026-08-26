import { parseCanonicalJson } from "./canonical.js";
import {
  digestPortableReceipt,
  publicJwkFingerprint,
  verifyPortableSignature,
} from "./crypto.js";
import { verifyEvidenceDisclosure } from "./merkle.js";
import type {
  PortablePromotionEnvelope,
  PortableVerificationReport,
  VerificationCheck,
} from "./types.js";
import {
  assertPortablePromotionEnvelope,
  safePortableDiagnostic,
} from "./validation.js";

const UNSUPPORTED_CLAIMS = [
  "The verifier does not prove that Runtime isolation was sufficient.",
  "The verifier does not prove that the Outcome Contract was sufficient.",
  "The verifier does not prove that Validation commands were trustworthy.",
  "The verifier does not prove that the signer clock was externally synchronized.",
  "The verifier does not assign organizational trust to the signing key.",
  "The verifier does not reveal or assess undisclosed evidence.",
];

export function verifyPortablePromotionEnvelope(
  value: unknown,
): PortableVerificationReport {
  let envelope: PortablePromotionEnvelope;
  try {
    assertPortablePromotionEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidStructuralReport(error);
  }

  const checks: VerificationCheck[] = [];
  const receiptDigest = digestPortableReceipt(envelope.receipt);
  addCheck(
    checks,
    "receipt-schema",
    true,
    "The receipt and envelope use the exact supported version 1 schemas.",
  );
  addCheck(
    checks,
    "receipt-digest",
    receiptDigest === envelope.receiptDigest,
    receiptDigest === envelope.receiptDigest
      ? "The RFC 8785 receipt digest matches the envelope."
      : "The signed receipt content does not match the claimed digest.",
  );

  const keyId = publicJwkFingerprint(envelope.publicJwk);
  addCheck(
    checks,
    "public-key-fingerprint",
    keyId === envelope.keyId,
    keyId === envelope.keyId
      ? "The key identifier matches the included Ed25519 public JWK."
      : "The included public key does not match the claimed key identifier.",
  );
  const signatureValid = verifyPortableSignature({
    digest: envelope.receiptDigest,
    signature: envelope.signature,
    publicJwk: envelope.publicJwk,
  });
  addCheck(
    checks,
    "signature",
    signatureValid,
    signatureValid
      ? "The Ed25519 signature is valid for the domain-separated receipt digest."
      : "The Ed25519 signature is invalid.",
  );

  const disclosures = envelope.disclosures.map((disclosure) => {
    const valid = verifyEvidenceDisclosure(
      disclosure,
      envelope.receipt.validationEvidence.root,
      envelope.receipt.validationEvidence.leafCount,
    );
    return {
      identity: disclosure.leaf.identity,
      valid,
      detail: valid
        ? "The disclosed evidence leaf is included in the signed evidence root."
        : "The disclosed evidence leaf or proof does not match the signed root.",
    };
  });
  addCheck(
    checks,
    "evidence-disclosures",
    disclosures.every((disclosure) => disclosure.valid),
    disclosures.length === 0
      ? "No evidence was disclosed; the signed evidence commitment remains valid."
      : `${disclosures.filter((item) => item.valid).length} of ${disclosures.length} disclosed evidence proofs are valid.`,
  );

  const valid = checks.every((check) => check.valid);
  return {
    valid,
    checks,
    receiptDigest,
    keyId,
    commitments: {
      resources:
        envelope.receipt.state.after.builtinResources.length +
        envelope.receipt.state.after.providerResources.length,
      outcomeContract: true,
      validationEvidence: true,
      externalActions: true,
      selection: envelope.receipt.selection !== null,
      assurance: envelope.receipt.assurance !== null,
      ancestry: true,
    },
    disclosures,
    provenClaims: valid
      ? [
          "The receipt content has the reported SHA-256 digest.",
          "The included Ed25519 key signed the domain-separated receipt digest.",
          "The receipt commits to the reported state, policy, evidence, action, and ancestry identifiers.",
          ...(disclosures.length > 0
            ? ["Every disclosed evidence leaf is included in the signed evidence root."]
            : []),
        ]
      : [],
    unsupportedClaims: [...UNSUPPORTED_CLAIMS],
  };
}

export function verifyPortablePromotionEnvelopeJson(
  source: string,
  maximumBytes = 1_048_576,
): PortableVerificationReport {
  try {
    return verifyPortablePromotionEnvelope(parseCanonicalJson(source, maximumBytes));
  } catch (error) {
    return invalidStructuralReport(error);
  }
}

function invalidStructuralReport(error: unknown): PortableVerificationReport {
  return {
    valid: false,
    checks: [
      {
        name: "receipt-schema",
        valid: false,
        detail:
          "The portable envelope is structurally invalid: " +
          safePortableDiagnostic(error),
      },
    ],
    receiptDigest: null,
    keyId: null,
    commitments: {
      resources: 0,
      outcomeContract: false,
      validationEvidence: false,
      externalActions: false,
      selection: false,
      assurance: false,
      ancestry: false,
    },
    disclosures: [],
    provenClaims: [],
    unsupportedClaims: [...UNSUPPORTED_CLAIMS],
  };
}

function addCheck(
  checks: VerificationCheck[],
  name: string,
  valid: boolean,
  detail: string,
): void {
  checks.push({ name, valid, detail });
}
