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
agent-airlock-receipt verify-anchor envelope.json anchor-proof.json --json
agent-airlock-receipt keygen /operator/private/portable-receipt.pem
agent-airlock-receipt evm-payload sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

`keygen` creates a new Ed25519 PKCS#8 private key with owner-only permissions on supported operating systems and prints only the public JWK and key fingerprint.
`verify-anchor` checks the receipt, signed checkpoint, receipt-digest identity, and Merkle inclusion proof without contacting a log server.
`evm-payload` performs deterministic offline ABI encoding for `anchor(bytes32)` and makes no network call or transaction.

The golden vector under `vectors/` includes its public verification material and no private key.
Run `npm run check:phase11:protocol` at the repository root to verify it in a separate CLI process, reject a tampered copy, verify an ephemeral signed anchor, and freeze the digest-only EVM selector.

## Privacy boundary

Portable envelopes reject unknown fields, private JWK members, credential-like text, path-like strings, raw prompts, Runtime output, raw command output, arbitrary provider metadata, and environment values.
Selective evidence disclosures include only strict redacted leaves and Merkle proofs.
An optional anchor contains only the portable receipt digest.

## Key rotation

New receipts may use a new Ed25519 key without invalidating historical envelopes because each envelope includes the exact public JWK and verified key fingerprint that signed it.
Mathematical signature validity does not establish whether an organization trusts that key or whether it was later compromised.
Follow the repository [rotation and compromise runbook](../../docs/operations/PORTABLE_RECEIPT_KEYS.md) for operator policy.
