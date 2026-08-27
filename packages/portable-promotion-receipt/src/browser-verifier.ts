import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import type {
  PortableEvidenceDisclosure,
  PortableDecisionChain,
  PortableDecisionChainVerificationReport,
  PortableEvidencePacket,
  PortableEvidencePacketVerificationReport,
  PolicyAuthorityRotationVerificationReport,
  PortablePromotionEnvelope,
  PortableVerificationReport,
  ReceiptDigest,
  SignedPolicyAuthorityRotationEnvelope,
  SignedSigningKeyTrustPolicyEnvelope,
  TrustPolicyVerificationReport,
  VerificationCheck,
} from "./types.js";
import {
  assertSignedPolicyAuthorityRotationEnvelope,
  MAXIMUM_SIGNED_AUTHORITY_ROTATION_BYTES,
} from "./authority-rotation.js";
import {
  assertPortablePromotionEnvelope,
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
  safePortableDiagnostic,
} from "./validation.js";
import {
  assertSignedSigningKeyTrustPolicyEnvelope,
  MAXIMUM_SIGNED_TRUST_POLICY_BYTES,
} from "./trust-policy.js";

const RECEIPT_SIGNATURE_DOMAIN = utf8Bytes(
  "agent-airlock-portable-receipt-signature-v1\0",
);
const TRUST_POLICY_SIGNATURE_DOMAIN = utf8Bytes(
  "agent-airlock-signing-key-trust-policy-v1\0",
);
const AUTHORITY_ROTATION_SIGNATURE_DOMAIN = utf8Bytes(
  "agent-airlock-policy-authority-rotation-v1\0",
);
const CHECKPOINT_SIGNATURE_DOMAIN = utf8Bytes(
  "agent-airlock-portable-transparency-checkpoint-signature-v1\0",
);
const TRANSPARENCY_LEAF_DOMAIN = utf8Bytes(
  "agent-airlock-transparency-leaf-v1\0",
);
const TRANSPARENCY_NODE_DOMAIN = utf8Bytes(
  "agent-airlock-transparency-node-v1\0",
);
export const MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES = 2_097_152;
export const MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES = 4_194_304;
const MAXIMUM_PORTABLE_DECISION_CHAIN_PACKETS = 32;
const UNSUPPORTED_CLAIMS = [
  "The verifier does not prove that Runtime isolation was sufficient.",
  "The verifier does not prove that the Outcome Contract was sufficient.",
  "The verifier does not prove that Validation commands were trustworthy.",
  "The verifier does not prove that the signer clock was externally synchronized.",
  "Cryptography alone does not assign organizational trust to the signing key.",
  "The verifier does not reveal or assess undisclosed evidence.",
];

export async function verifyPortablePromotionEnvelopeInBrowser(
  value: unknown,
): Promise<PortableVerificationReport> {
  let envelope: PortablePromotionEnvelope;
  try {
    assertPortablePromotionEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidStructuralReport(error);
  }

  const checks: VerificationCheck[] = [];
  const receiptDigest = await sha256Digest(utf8Bytes(canonicalize(envelope.receipt)));
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
      ? "The canonical receipt digest matches the envelope."
      : "The signed receipt content does not match the claimed digest.",
  );

  const keyId = await sha256Digest(utf8Bytes(canonicalize(envelope.publicJwk)));
  addCheck(
    checks,
    "public-key-fingerprint",
    keyId === envelope.keyId,
    keyId === envelope.keyId
      ? "The key identifier matches the included Ed25519 public JWK."
      : "The included public key does not match the claimed key identifier.",
  );

  const signatureValid = await verifySignature(envelope);
  addCheck(
    checks,
    "signature",
    signatureValid,
    signatureValid
      ? "The browser verified the Ed25519 signature over the domain-separated receipt digest."
      : "The Ed25519 signature is invalid.",
  );

  const disclosures = [];
  for (const disclosure of envelope.disclosures) {
    const valid = await verifyDisclosure(
      disclosure,
      envelope.receipt.validationEvidence.root,
      envelope.receipt.validationEvidence.leafCount,
    );
    disclosures.push({
      identity: disclosure.leaf.identity,
      valid,
      detail: valid
        ? "The disclosed evidence leaf is included in the signed evidence root."
        : "The disclosed evidence leaf or proof does not match the signed root.",
    });
  }
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

export async function verifyPortablePromotionEnvelopeJsonInBrowser(
  source: string,
  maximumBytes = 1_048_576,
): Promise<PortableVerificationReport> {
  try {
    return await verifyPortablePromotionEnvelopeInBrowser(
      parseCanonicalJson(source, maximumBytes),
    );
  } catch (error) {
    return invalidStructuralReport(error);
  }
}

export async function verifyPortableEvidencePacketInBrowser(
  value: unknown,
): Promise<PortableEvidencePacketVerificationReport> {
  let packet: PortableEvidencePacket;
  try {
    assertBrowserEvidencePacket(value);
    packet = value;
  } catch (error) {
    return invalidEvidencePacketReport(error);
  }

  const receipt = await verifyPortablePromotionEnvelopeInBrowser(packet.envelope);
  const checks: VerificationCheck[] = [
    {
      name: "packet-schema",
      valid: true,
      detail: "The packet uses the exact supported version 1 schema.",
    },
    {
      name: "packet-receipt",
      valid: receipt.valid,
      detail: receipt.valid
        ? "The bundled signed receipt is valid."
        : "The bundled signed receipt is invalid.",
    },
  ];

  let anchor: PortableEvidencePacketVerificationReport["anchor"] = null;
  if (packet.anchor) {
    const checkpoint = await verifyCheckpointInBrowser(packet.anchor.checkpoint);
    const digestMatches =
      receipt.receiptDigest !== null &&
      packet.anchor.inclusionProof.receiptDigest === receipt.receiptDigest;
    const inclusionValid =
      checkpoint.valid &&
      digestMatches &&
      packet.anchor.inclusionProof.treeSize ===
        packet.anchor.checkpoint.checkpoint.treeSize &&
      (await verifyTransparencyInclusionInBrowser(
        packet.anchor.inclusionProof,
        packet.anchor.checkpoint.checkpoint.root,
      ));
    anchor = {
      valid: checkpoint.valid && digestMatches && inclusionValid,
      splitView: false,
      checks: [
        ...checkpoint.checks,
        {
          name: "anchor-receipt-digest",
          valid: digestMatches,
          detail: digestMatches
            ? "The inclusion proof names the bundled receipt digest."
            : "The inclusion proof names a different receipt digest.",
        },
        {
          name: "anchor-inclusion",
          valid: inclusionValid,
          detail: inclusionValid
            ? "The receipt digest is included in the signed checkpoint root."
            : "The receipt digest inclusion proof is invalid.",
        },
      ],
    };
    checks.push({
      name: "packet-anchor",
      valid: anchor.valid,
      detail: anchor.valid
        ? "The bundled transparency proof is valid for this receipt."
        : "The bundled transparency proof is invalid for this receipt.",
    });
  }

  let evmPayload: PortableEvidencePacketVerificationReport["evmPayload"] = null;
  if (packet.evmPayload) {
    const digestMatches =
      receipt.receiptDigest !== null &&
      packet.evmPayload.receiptDigest === receipt.receiptDigest;
    const encodingMatches =
      digestMatches &&
      packet.evmPayload.calldata ===
        `0xeecdf927${receipt.receiptDigest!.slice("sha256:".length)}`;
    evmPayload = {
      valid: digestMatches && encodingMatches,
      checks: [
        {
          name: "evm-receipt-digest",
          valid: digestMatches,
          detail: digestMatches
            ? "The EVM payload names the bundled receipt digest."
            : "The EVM payload names a different receipt digest.",
        },
        {
          name: "evm-calldata",
          valid: encodingMatches,
          detail: encodingMatches
            ? "The calldata is the exact anchor(bytes32) encoding of the receipt digest."
            : "The calldata does not exactly encode the bundled receipt digest.",
        },
      ],
    };
    checks.push({
      name: "packet-evm-payload",
      valid: evmPayload.valid,
      detail: evmPayload.valid
        ? "The bundled calldata encodes only this receipt digest without network or funds."
        : "The bundled calldata does not exactly encode this receipt digest.",
    });
  }

  return {
    valid: checks.every((check) => check.valid),
    receipt,
    anchor,
    evmPayload,
    checks,
  };
}

export async function verifyPortableEvidencePacketJsonInBrowser(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES,
): Promise<PortableEvidencePacketVerificationReport> {
  try {
    return await verifyPortableEvidencePacketInBrowser(
      parseCanonicalJson(source, maximumBytes),
    );
  } catch (error) {
    return invalidEvidencePacketReport(error);
  }
}

export async function verifyPortableDecisionChainInBrowser(
  value: unknown,
): Promise<PortableDecisionChainVerificationReport> {
  let chain: PortableDecisionChain;
  try {
    assertBrowserDecisionChain(value);
    chain = value;
  } catch (error) {
    return invalidDecisionChainReport(error);
  }

  const packets = await Promise.all(
    chain.packets.map((packet) => verifyPortableEvidencePacketInBrowser(packet)),
  );
  const checks: VerificationCheck[] = [
    {
      name: "chain-schema",
      valid: true,
      detail: "The decision chain uses the exact supported version 1 schema.",
    },
    {
      name: "chain-packets",
      valid: packets.every((packet) => packet.valid),
      detail: packets.every((packet) => packet.valid)
        ? `All ${packets.length} bundled evidence packets are valid.`
        : "At least one bundled evidence packet is invalid.",
    },
  ];
  const first = chain.packets[0]!.envelope;
  const root = first.receipt.ancestry;
  const rootValid =
    root.depth === 0 &&
    root.parentRunId === null &&
    root.previousReceiptDigest === null &&
    root.rootRunId === first.receipt.decision.runId;
  checks.push({
    name: "chain-root",
    valid: rootValid,
    detail: rootValid
      ? "The first receipt is the signed root of this complete lineage."
      : "The first receipt is not a valid lineage root.",
  });

  let linksValid = true;
  let stateContinuityValid = true;
  for (let index = 1; index < chain.packets.length; index += 1) {
    const previous = chain.packets[index - 1]!.envelope;
    const current = chain.packets[index]!.envelope;
    const ancestry = current.receipt.ancestry;
    linksValid &&=
      current.receipt.decision.agentId === first.receipt.decision.agentId &&
      ancestry.rootRunId === root.rootRunId &&
      ancestry.parentRunId === previous.receipt.decision.runId &&
      ancestry.depth === previous.receipt.ancestry.depth + 1 &&
      ancestry.maxDepth === root.maxDepth &&
      ancestry.previousReceiptDigest === previous.receiptDigest;
    stateContinuityValid &&=
      current.receipt.state.before.stateId === previous.receipt.state.after.stateId &&
      current.receipt.state.before.compositeHash ===
        previous.receipt.state.after.compositeHash;
  }
  const leaf = chain.packets.at(-1)!.envelope;
  const completeLength = leaf.receipt.ancestry.depth + 1 === chain.packets.length;
  checks.push({
    name: "chain-links",
    valid: linksValid && completeLength,
    detail:
      linksValid && completeLength
        ? "Every child names the exact prior receipt digest and signed parent Run."
        : "The chain is incomplete, reordered, or contains a broken parent digest link.",
  });
  checks.push({
    name: "chain-state-continuity",
    valid: stateContinuityValid,
    detail: stateContinuityValid
      ? "Every child begins from the exact Canonical State committed by its parent."
      : "A child does not begin from its parent's committed Canonical State.",
  });
  return {
    valid: checks.every((check) => check.valid),
    packets,
    checks,
    leafReceiptDigest: packets.at(-1)?.receipt.receiptDigest ?? null,
  };
}

export async function verifyPortableDecisionChainJsonInBrowser(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES,
): Promise<PortableDecisionChainVerificationReport> {
  try {
    return await verifyPortableDecisionChainInBrowser(
      parseCanonicalJson(source, maximumBytes),
    );
  } catch (error) {
    return invalidDecisionChainReport(error);
  }
}

export async function verifySignedSigningKeyTrustPolicyEnvelopeInBrowser(
  value: unknown,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
): Promise<TrustPolicyVerificationReport> {
  let envelope: SignedSigningKeyTrustPolicyEnvelope;
  try {
    assertTrustedAuthorityKeyIds(trustedAuthorityKeyIds);
    assertSignedSigningKeyTrustPolicyEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidTrustPolicyReport(error);
  }

  const checks: VerificationCheck[] = [];
  addCheck(
    checks,
    "policy-schema",
    true,
    "The signed trust policy uses the exact supported version 1 schema.",
  );
  const policyDigest = await sha256Digest(utf8Bytes(canonicalize(envelope.policy)));
  addCheck(
    checks,
    "policy-digest",
    policyDigest === envelope.policyDigest,
    policyDigest === envelope.policyDigest
      ? "The canonical policy digest matches the signed envelope."
      : "The trust policy content does not match the claimed digest.",
  );
  const authorityKeyId = await sha256Digest(
    utf8Bytes(canonicalize(envelope.authorityPublicJwk)),
  );
  addCheck(
    checks,
    "authority-key-fingerprint",
    authorityKeyId === envelope.authorityKeyId,
    authorityKeyId === envelope.authorityKeyId
      ? "The authority key identifier matches the included Ed25519 public JWK."
      : "The authority public key does not match its claimed identifier.",
  );
  const signatureValid = await verifyTrustPolicySignature(envelope);
  addCheck(
    checks,
    "policy-signature",
    signatureValid,
    signatureValid
      ? "The browser verified the authority signature over the policy digest."
      : "The trust-policy authority signature is invalid.",
  );
  const authorityTrusted = trustedAuthorityKeyIds.includes(envelope.authorityKeyId);
  addCheck(
    checks,
    "authority-trust-root",
    authorityTrusted,
    authorityTrusted
      ? "The policy authority matches an evaluator-supplied trust root."
      : "The policy authority is not in the evaluator-supplied trust roots.",
  );
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

export async function verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser(
  source: string,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
  maximumBytes = MAXIMUM_SIGNED_TRUST_POLICY_BYTES,
): Promise<TrustPolicyVerificationReport> {
  try {
    return await verifySignedSigningKeyTrustPolicyEnvelopeInBrowser(
      parseCanonicalJson(source, maximumBytes),
      trustedAuthorityKeyIds,
    );
  } catch (error) {
    return invalidTrustPolicyReport(error);
  }
}

export async function verifySignedPolicyAuthorityRotationEnvelopeInBrowser(
  value: unknown,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
  options: { evaluatedAt?: string } = {},
): Promise<PolicyAuthorityRotationVerificationReport> {
  let envelope: SignedPolicyAuthorityRotationEnvelope;
  try {
    assertTrustedAuthorityKeyIds(trustedAuthorityKeyIds);
    assertSignedPolicyAuthorityRotationEnvelope(value);
    envelope = value;
  } catch (error) {
    return invalidAuthorityRotationReport(error);
  }

  const checks: VerificationCheck[] = [];
  addCheck(
    checks,
    "rotation-schema",
    true,
    "The signed authority rotation uses the exact supported version 1 schema.",
  );
  const rotationDigest = await sha256Digest(
    utf8Bytes(canonicalize(envelope.rotation)),
  );
  addCheck(
    checks,
    "rotation-digest",
    rotationDigest === envelope.rotationDigest,
    rotationDigest === envelope.rotationDigest
      ? "The canonical rotation digest matches the signed envelope."
      : "The authority rotation does not match the claimed digest.",
  );
  const previousAuthorityKeyId = await sha256Digest(
    utf8Bytes(canonicalize(envelope.previousAuthorityPublicJwk)),
  );
  addCheck(
    checks,
    "previous-authority-fingerprint",
    previousAuthorityKeyId === envelope.rotation.previousAuthorityKeyId,
    previousAuthorityKeyId === envelope.rotation.previousAuthorityKeyId
      ? "The previous authority fingerprint matches its included public key."
      : "The previous authority key does not match the rotation statement.",
  );
  const nextAuthorityKeyId = await sha256Digest(
    utf8Bytes(canonicalize(envelope.rotation.nextAuthorityPublicJwk)),
  );
  addCheck(
    checks,
    "next-authority-fingerprint",
    nextAuthorityKeyId === envelope.rotation.nextAuthorityKeyId,
    nextAuthorityKeyId === envelope.rotation.nextAuthorityKeyId
      ? "The next authority fingerprint matches its included public key."
      : "The next authority key does not match the rotation statement.",
  );
  const signatureValid = await verifyAuthorityRotationSignature(envelope);
  addCheck(
    checks,
    "rotation-signature",
    signatureValid,
    signatureValid
      ? "The browser verified the previous authority's rotation signature."
      : "The authority-rotation signature is invalid.",
  );
  const previousAuthorityTrusted = trustedAuthorityKeyIds.includes(
    envelope.rotation.previousAuthorityKeyId,
  );
  addCheck(
    checks,
    "previous-authority-trust-root",
    previousAuthorityTrusted,
    previousAuthorityTrusted
      ? "The previous authority matches an evaluator-supplied trust root."
      : "The previous authority is not in the evaluator-supplied trust roots.",
  );
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const temporallyValid =
    isTimestamp(evaluatedAt) &&
    Date.parse(evaluatedAt) >= Date.parse(envelope.rotation.effectiveAt) &&
    (envelope.rotation.expiresAt === null ||
      Date.parse(evaluatedAt) <= Date.parse(envelope.rotation.expiresAt));
  addCheck(
    checks,
    "rotation-validity-window",
    temporallyValid,
    temporallyValid
      ? "The authority rotation is effective at the evaluator-supplied time."
      : "The authority rotation is not effective at the evaluator-supplied time.",
  );
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

export async function verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser(
  source: string,
  trustedAuthorityKeyIds: readonly ReceiptDigest[],
  options: { evaluatedAt?: string } = {},
  maximumBytes = MAXIMUM_SIGNED_AUTHORITY_ROTATION_BYTES,
): Promise<PolicyAuthorityRotationVerificationReport> {
  try {
    return await verifySignedPolicyAuthorityRotationEnvelopeInBrowser(
      parseCanonicalJson(source, maximumBytes),
      trustedAuthorityKeyIds,
      options,
    );
  } catch (error) {
    return invalidAuthorityRotationReport(error);
  }
}

export {
  assertSigningKeyTrustPolicy,
  evaluateSigningKeyTrust,
  parseSigningKeyTrustPolicyJson,
} from "./trust-policy.js";
export type {
  OrganizationalTrustReport,
  SigningKeyTrustPolicy,
} from "./types.js";

async function verifySignature(envelope: PortablePromotionEnvelope): Promise<boolean> {
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      envelope.publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signature = decodeCanonicalBase64Url(envelope.signature, 64);
    const digestBytes = decodeHexDigest(envelope.receiptDigest);
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signature,
      concatBytes(RECEIPT_SIGNATURE_DOMAIN, digestBytes),
    );
  } catch {
    return false;
  }
}

async function verifyTrustPolicySignature(
  envelope: SignedSigningKeyTrustPolicyEnvelope,
): Promise<boolean> {
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      envelope.authorityPublicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      decodeCanonicalBase64Url(envelope.signature, 64),
      concatBytes(
        TRUST_POLICY_SIGNATURE_DOMAIN,
        decodeHexDigest(envelope.policyDigest),
      ),
    );
  } catch {
    return false;
  }
}

async function verifyAuthorityRotationSignature(
  envelope: SignedPolicyAuthorityRotationEnvelope,
): Promise<boolean> {
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      envelope.previousAuthorityPublicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      decodeCanonicalBase64Url(envelope.signature, 64),
      concatBytes(
        AUTHORITY_ROTATION_SIGNATURE_DOMAIN,
        decodeHexDigest(envelope.rotationDigest),
      ),
    );
  } catch {
    return false;
  }
}

async function verifyDisclosure(
  disclosure: PortableEvidenceDisclosure,
  expectedRoot: ReceiptDigest,
  expectedLeafCount: number,
): Promise<boolean> {
  try {
    if (disclosure.totalLeaves !== expectedLeafCount) return false;
    let current = await sha256Digest(
      concatBytes(Uint8Array.of(0), utf8Bytes(canonicalize(disclosure.leaf))),
    );
    let index = disclosure.leafIndex;
    let width = disclosure.totalLeaves;
    let siblingIndex = 0;
    while (width > 1) {
      const isRight = index % 2 === 1;
      const hasSibling = isRight || index + 1 < width;
      if (hasSibling) {
        const sibling = disclosure.siblings[siblingIndex];
        if (
          !sibling ||
          (isRight && sibling.direction !== "left") ||
          (!isRight && sibling.direction !== "right")
        ) {
          return false;
        }
        current = isRight
          ? await hashInternal(sibling.hash, current)
          : await hashInternal(current, sibling.hash);
        siblingIndex += 1;
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return siblingIndex === disclosure.siblings.length && current === expectedRoot;
  } catch {
    return false;
  }
}

async function hashInternal(
  left: ReceiptDigest,
  right: ReceiptDigest,
): Promise<ReceiptDigest> {
  return sha256Digest(
    concatBytes(Uint8Array.of(1), decodeHexDigest(left), decodeHexDigest(right)),
  );
}

async function verifyCheckpointInBrowser(
  signed: NonNullable<PortableEvidencePacket["anchor"]>["checkpoint"],
): Promise<{ valid: boolean; splitView: false; checks: VerificationCheck[] }> {
  const checks: VerificationCheck[] = [];
  const expectedDigest = await sha256Digest(
    utf8Bytes(canonicalize(signed.checkpoint)),
  );
  addCheck(
    checks,
    "checkpoint-digest",
    expectedDigest === signed.checkpointDigest,
    "The canonical checkpoint digest must match.",
  );
  const expectedKeyId = await sha256Digest(utf8Bytes(canonicalize(signed.publicJwk)));
  addCheck(
    checks,
    "checkpoint-key",
    expectedKeyId === signed.checkpoint.keyId,
    "The checkpoint key identifier must match its public JWK.",
  );
  let signatureValid = false;
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      signed.publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    signatureValid = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      decodeCanonicalBase64Url(signed.signature, 64),
      concatBytes(
        CHECKPOINT_SIGNATURE_DOMAIN,
        decodeHexDigest(signed.checkpointDigest),
      ),
    );
  } catch {
    signatureValid = false;
  }
  addCheck(
    checks,
    "checkpoint-signature",
    signatureValid,
    "The domain-separated checkpoint signature must verify.",
  );
  return { valid: checks.every((check) => check.valid), splitView: false, checks };
}

async function verifyTransparencyInclusionInBrowser(
  proof: NonNullable<PortableEvidencePacket["anchor"]>["inclusionProof"],
  expectedRoot: ReceiptDigest,
): Promise<boolean> {
  try {
    let hash = await sha256Digest(
      concatBytes(TRANSPARENCY_LEAF_DOMAIN, decodeHexDigest(proof.receiptDigest)),
    );
    let index = proof.leafIndex;
    let width = proof.treeSize;
    let siblingIndex = 0;
    while (width > 1) {
      const right = index % 2 === 1;
      const hasSibling = right || index + 1 < width;
      if (hasSibling) {
        const sibling = proof.siblings[siblingIndex];
        if (
          !sibling ||
          (right && sibling.direction !== "left") ||
          (!right && sibling.direction !== "right")
        ) {
          return false;
        }
        hash = await sha256Digest(
          right
            ? concatBytes(
                TRANSPARENCY_NODE_DOMAIN,
                decodeHexDigest(sibling.hash),
                decodeHexDigest(hash),
              )
            : concatBytes(
                TRANSPARENCY_NODE_DOMAIN,
                decodeHexDigest(hash),
                decodeHexDigest(sibling.hash),
              ),
        );
        siblingIndex += 1;
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return siblingIndex === proof.siblings.length && hash === expectedRoot;
  } catch {
    return false;
  }
}

function assertBrowserEvidencePacket(
  value: unknown,
): asserts value is PortableEvidencePacket {
  const packet = browserRecord(value, "Portable evidence packet");
  browserExactKeys(
    packet,
    ["schema", "schemaVersion", "envelope", "anchor", "evmPayload"],
    "Portable evidence packet",
  );
  if (
    packet.schema !== "agent-airlock/portable-evidence-packet" ||
    packet.schemaVersion !== 1
  ) {
    throw new Error("Portable evidence packet protocol is unsupported");
  }
  assertPortablePromotionEnvelope(packet.envelope);
  if (packet.anchor !== null) assertBrowserAnchor(packet.anchor);
  if (packet.evmPayload !== null) assertBrowserEvmPayload(packet.evmPayload);
}

function assertBrowserDecisionChain(
  value: unknown,
): asserts value is PortableDecisionChain {
  const chain = browserRecord(value, "Portable decision chain");
  browserExactKeys(
    chain,
    ["schema", "schemaVersion", "packets"],
    "Portable decision chain",
  );
  if (
    chain.schema !== "agent-airlock/portable-decision-chain" ||
    chain.schemaVersion !== 1 ||
    !Array.isArray(chain.packets) ||
    chain.packets.length < 1 ||
    chain.packets.length > MAXIMUM_PORTABLE_DECISION_CHAIN_PACKETS
  ) {
    throw new Error("Portable decision chain protocol is unsupported");
  }
  for (const packet of chain.packets) assertBrowserEvidencePacket(packet);
}

function assertBrowserAnchor(value: unknown): void {
  const anchor = browserRecord(value, "Portable transparency anchor");
  browserExactKeys(
    anchor,
    ["checkpoint", "inclusionProof"],
    "Portable transparency anchor",
  );
  const signed = browserRecord(anchor.checkpoint, "Signed transparency checkpoint");
  browserExactKeys(
    signed,
    ["checkpoint", "checkpointDigest", "signatureAlgorithm", "signature", "publicJwk"],
    "Signed transparency checkpoint",
  );
  const checkpoint = browserRecord(signed.checkpoint, "Transparency checkpoint");
  browserExactKeys(
    checkpoint,
    ["schema", "schemaVersion", "treeSize", "root", "priorCheckpointDigest", "createdAt", "keyId"],
    "Transparency checkpoint",
  );
  if (
    checkpoint.schema !== "agent-airlock/portable-transparency-checkpoint" ||
    checkpoint.schemaVersion !== 1 ||
    !Number.isSafeInteger(checkpoint.treeSize) ||
    (checkpoint.treeSize as number) < 1 ||
    (checkpoint.treeSize as number) > 100_000 ||
    !isDigest(checkpoint.root) ||
    !(checkpoint.priorCheckpointDigest === null || isDigest(checkpoint.priorCheckpointDigest)) ||
    !isBrowserTimestamp(checkpoint.createdAt) ||
    !isDigest(checkpoint.keyId) ||
    !isDigest(signed.checkpointDigest) ||
    signed.signatureAlgorithm !== "Ed25519" ||
    typeof signed.signature !== "string"
  ) {
    throw new Error("Signed transparency checkpoint is invalid");
  }
  if (decodeCanonicalBase64Url(signed.signature, 64).length !== 64) {
    throw new Error("Signed transparency checkpoint signature is invalid");
  }
  assertPortablePublicJwk(signed.publicJwk);

  const proof = browserRecord(anchor.inclusionProof, "Transparency inclusion proof");
  browserExactKeys(
    proof,
    ["receiptDigest", "leafIndex", "treeSize", "siblings"],
    "Transparency inclusion proof",
  );
  if (
    !isDigest(proof.receiptDigest) ||
    !Number.isSafeInteger(proof.leafIndex) ||
    (proof.leafIndex as number) < 0 ||
    !Number.isSafeInteger(proof.treeSize) ||
    (proof.treeSize as number) < 1 ||
    (proof.treeSize as number) > 100_000 ||
    (proof.leafIndex as number) >= (proof.treeSize as number) ||
    !Array.isArray(proof.siblings) ||
    proof.siblings.length > 32
  ) {
    throw new Error("Transparency inclusion proof is invalid");
  }
  for (const item of proof.siblings) {
    const sibling = browserRecord(item, "Transparency inclusion sibling");
    browserExactKeys(sibling, ["direction", "hash"], "Transparency inclusion sibling");
    if (!["left", "right"].includes(String(sibling.direction)) || !isDigest(sibling.hash)) {
      throw new Error("Transparency inclusion sibling is invalid");
    }
  }
}

function assertBrowserEvmPayload(value: unknown): void {
  const payload = browserRecord(value, "Offline EVM anchor payload");
  browserExactKeys(
    payload,
    ["schema", "schemaVersion", "methodSignature", "functionSelector", "receiptDigest", "calldata", "privacyClaim", "networkCalls", "fundsSpent"],
    "Offline EVM anchor payload",
  );
  if (
    payload.schema !== "agent-airlock/offline-evm-anchor-payload" ||
    payload.schemaVersion !== 1 ||
    payload.methodSignature !== "anchor(bytes32)" ||
    payload.functionSelector !== "0xeecdf927" ||
    !isDigest(payload.receiptDigest) ||
    typeof payload.calldata !== "string" ||
    !/^0x[a-f0-9]{72}$/.test(payload.calldata) ||
    payload.privacyClaim !== "receipt-digest-only" ||
    payload.networkCalls !== 0 ||
    payload.fundsSpent !== 0
  ) {
    throw new Error("Offline EVM anchor payload is invalid");
  }
}

function browserRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function browserExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function isBrowserTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

async function sha256Digest(value: Uint8Array): Promise<ReceiptDigest> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function decodeHexDigest(value: ReceiptDigest): Uint8Array {
  const hex = value.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Digest is invalid");
  return Uint8Array.from(
    Array.from({ length: 32 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function invalidStructuralReport(error: unknown): PortableVerificationReport {
  return {
    valid: false,
    checks: [
      {
        name: "receipt-schema",
        valid: false,
        detail: "The portable envelope is structurally invalid: " + safePortableDiagnostic(error),
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

function invalidEvidencePacketReport(
  error: unknown,
): PortableEvidencePacketVerificationReport {
  return {
    valid: false,
    receipt: invalidStructuralReport(error),
    anchor: null,
    evmPayload: null,
    checks: [
      {
        name: "packet-schema",
        valid: false,
        detail:
          "The portable evidence packet is structurally invalid: " +
          safePortableDiagnostic(error),
      },
    ],
  };
}

function invalidDecisionChainReport(
  error: unknown,
): PortableDecisionChainVerificationReport {
  return {
    valid: false,
    packets: [],
    checks: [
      {
        name: "chain-schema",
        valid: false,
        detail:
          "The portable decision chain is structurally invalid: " +
          safePortableDiagnostic(error),
      },
    ],
    leafReceiptDigest: null,
  };
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

function assertTrustedAuthorityKeyIds(
  values: readonly ReceiptDigest[],
): void {
  const seen = new Set<ReceiptDigest>();
  if (values.length > 32) throw new Error("Too many trusted policy authorities");
  for (const value of values) {
    if (!isDigest(value) || seen.has(value)) {
      throw new Error("Trusted policy authority fingerprints are invalid or duplicated");
    }
    seen.add(value);
  }
}

function addCheck(
  checks: VerificationCheck[],
  name: string,
  valid: boolean,
  detail: string,
): void {
  checks.push({ name, valid, detail });
}
