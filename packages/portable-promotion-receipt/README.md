# Portable Promotion Receipt

This package defines Agent Airlock's bounded, provider-neutral receipt protocol.
It signs an RFC 8785 canonical receipt commitment with Ed25519 and verifies it without an Airlock server, database, model, provider, wallet, or network.

## Claims

A valid envelope proves that the included Ed25519 public key signed the exact reported receipt digest.
The receipt commits to state fingerprints, resource versions, an Outcome Contract digest, a Validation evidence Merkle root, External Action evidence, optional Candidate Selection and Assurance provenance, and Run ancestry.

It does not prove that Runtime isolation was sufficient, that Validations were well designed, that the signer clock was externally trusted, that the signing key was uncompromised, or that undisclosed evidence was correct.

## CLI

```sh
agent-airlock-receipt verify envelope.json
agent-airlock-receipt verify envelope.json --json
agent-airlock-receipt verify-packet evidence-packet.json --json
agent-airlock-receipt verify-anchor envelope.json anchor-proof.json --json
agent-airlock-receipt keygen /operator/private/portable-receipt.pem
agent-airlock-receipt sign-policy policy.json /operator/private/policy-authority.pem
agent-airlock-receipt verify-policy signed-policy.json --authority sha256:trusted-root --json
agent-airlock-receipt sign-authority-rotation rotation.json /operator/private/current-authority.pem
agent-airlock-receipt verify-authority-rotation signed-rotation.json --authority sha256:trusted-root --json
agent-airlock-receipt verify-policy signed-policy.json --authority sha256:trusted-root --rotation signed-rotation.json --json
agent-airlock-receipt evm-payload sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

`keygen` creates a new Ed25519 PKCS#8 private key with owner-only permissions on supported operating systems and prints only the public JWK and key fingerprint.
`verify-packet` validates one strict 2 MB container and fails if its signed receipt, included transparency proof, or included EVM payload does not describe the same receipt digest.
`verify-chain` validates one strict 4 MB root-to-leaf Repair lineage and fails on an invalid packet, omitted ancestor, reordered receipt, broken parent digest, or discontinuous Canonical State handoff.
`verify-anchor` checks the receipt, signed checkpoint, receipt-digest identity, and Merkle inclusion proof without contacting a log server.
`sign-policy` signs the canonical bounded policy under a separate domain, while `verify-policy` requires the evaluator to pin the expected authority fingerprint explicitly.
`sign-authority-rotation` lets the pinned authority delegate to one named next key inside a bounded effective window.
`verify-policy --rotation` accepts the next authority only after independently verifying that transition from the pinned root.
`evm-payload` performs deterministic offline ABI encoding for `anchor(bytes32)` and makes no network call or transaction.

The golden vector under `vectors/` includes its public verification material and no private key.
Run `npm run check:phase11:protocol` at the repository root to verify it in a separate CLI process, reject a tampered copy, verify an ephemeral signed anchor, and freeze the digest-only EVM selector.

## Browser verifier

The `@agent-airlock/portable-promotion-receipt/browser` export verifies envelopes, Portable Evidence Packets, and Portable Decision Chains with the browser Web Crypto API and has no Node.js, server, database, or network dependency.
It applies the same strict JSON, schema, size, digest, key-fingerprint, signature, and disclosure-proof checks as the CLI.

```ts
import {
  verifyPortableEvidencePacketJsonInBrowser,
  verifyPortablePromotionEnvelopeJsonInBrowser,
} from "@agent-airlock/portable-promotion-receipt/browser";

const report = await verifyPortablePromotionEnvelopeJsonInBrowser(source);
const packetReport = await verifyPortableEvidencePacketJsonInBrowser(packetSource);
```

Agent Launchpad exposes this verifier through the global `Verify a receipt` control.
Files remain inside the browser and are capped at 1 MB for envelopes or 2 MB for packets before verification.
The packet intentionally excludes trust policies and Authority Trust Roots so producer evidence cannot authorize its own signer.

## Organizational signing-key trust

Cryptographic validity proves which included key signed a receipt, but it does not decide whether a receiving organization trusts that key.
The verifier can therefore import a separate signed `agent-airlock/signing-key-trust-policy` envelope and produce an independent second verdict.
The strict 64 KB policy names active, retired, or compromised key fingerprints, trusted signing windows, exact Agent scopes, and allowed dispositions.
Unknown keys, compromised keys, expired policies, invalid windows, scope mismatches, and invalid receipt proofs fail closed.
An empty Agent or disposition scope means all values in that dimension.
The policy authority uses its own Ed25519 key and signature domain rather than the receipt signing key.
The browser requires the evaluator to enter the authority fingerprint received through an independent channel before the signed policy can authorize any receipt signer.
A mathematically valid policy signed by an unpinned authority remains rejected.
An optional signed Policy Authority Rotation can derive one next authority from the pinned root without replacing the root blindly.
The transition has a separate signature domain, exact previous and next key fingerprints, an effective time, and an optional expiry.
An unpinned, tampered, early, or expired transition fails closed.

```ts
import {
  evaluateSigningKeyTrust,
  verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser,
  verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser,
} from "@agent-airlock/portable-promotion-receipt/browser";

const rotationReport = await verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser(
  rotationSource,
  [trustedAuthorityFingerprint],
);
const trustedAuthorities =
  rotationReport.valid && rotationReport.nextAuthorityKeyId
    ? [trustedAuthorityFingerprint, rotationReport.nextAuthorityKeyId]
    : [trustedAuthorityFingerprint];
const policyReport = await verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser(
  policySource,
  trustedAuthorities,
);
const trust = evaluateSigningKeyTrust(envelope, policyReport.policy!, {
  cryptographicValid: report.valid,
});
```

## Privacy boundary

Portable envelopes reject unknown fields, private JWK members, credential-like text, path-like strings, raw prompts, Runtime output, raw command output, arbitrary provider metadata, and environment values.
Selective evidence disclosures include only strict redacted leaves and Merkle proofs.
An optional anchor contains only the portable receipt digest.

## Key rotation

New receipts may use a new Ed25519 key without invalidating historical envelopes because each envelope includes the exact public JWK and verified key fingerprint that signed it.
Mathematical signature validity does not establish whether an organization trusts that key or whether it was later compromised.
Follow the repository [rotation and compromise runbook](../../docs/operations/PORTABLE_RECEIPT_KEYS.md) for operator policy.
