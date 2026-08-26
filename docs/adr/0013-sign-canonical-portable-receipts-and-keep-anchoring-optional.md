# ADR 0013: Sign canonical Portable Promotion Receipts and keep anchoring optional

## Status

Proposed for Phase 11 pending Wayfinder decision synchronization and all prior phase gates.

## Context

Current Promotion Receipts are durable inside one Airlock deployment but depend on that deployment's database and trust boundary.
Cross-machine or cross-organization verification requires a stable encoding, explicit commitments, a signature, public verification material, and clear privacy limits.

A public blockchain can prove that a digest was submitted to a shared ledger, but it cannot prove that an Agent result was correct, that required Validations were meaningful, or that private evidence should be public.
Making a blockchain transaction part of Promotion would add cost and availability dependencies to the acceptance boundary.

## Decision

Airlock defines a standalone Portable Promotion Receipt schema and verifier package with no dependency on the server, ModelArk, a Resource Provider, or a network.
The receipt uses the JSON Canonicalization Scheme defined by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), restricted further to exact schema fields, unique object names, valid Unicode strings, safe integers, and no unknown algorithms.

Airlock computes a SHA-256 digest over the UTF-8 canonical receipt and signs a domain-separated message containing that digest with Ed25519 as defined by [RFC 8032](https://www.rfc-editor.org/info/rfc8032/).
The public key is exported as an OKP JSON Web Key using the Ed25519 representation defined by [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037.html).
The key identifier is the SHA-256 digest of the canonical public JWK fields and is verified rather than trusted from input.

The portable envelope contains the receipt, receipt digest, signature algorithm, signature, key identifier, and public JWK.
Verification strictly parses every field, canonicalizes the receipt independently, recomputes both receipt and key digests, verifies the signature, and explains which claims are cryptographically proven and which remain policy or provenance claims.

Raw prompts, Runtime output, file contents, Validation output, credentials, environment values, local paths, private provider metadata, and user identity are forbidden from the portable schema.
The receipt commits to bounded evidence through hashes and may carry selected redacted evidence with Merkle inclusion proofs.

Signing keys are ordinary Ed25519 key pairs generated and held outside the repository and application data records with restrictive filesystem permissions.
Key rotation creates a new key identifier for new receipts and preserves the public keys needed to verify historical receipts.
Cryptographic verification proves possession of the signing key, not that the key was uncompromised or trusted by every verifier.
Compromise and revocation policy are reported separately and never rewrite a historical signature.

Anchoring is an optional protocol over only the portable receipt digest.
Signature verification is complete without an anchor.
The reference implementation first provides a local append-only transparency log with hash chaining, Merkle inclusion proofs, signed checkpoints, consistency proofs, and split-view detection fixtures.
An optional EVM payload encoder may produce a deterministic `bytes32` digest call without connecting to a network, deploying a contract, spending funds, or placing private evidence on a ledger.

## Consequences

An independent verifier can detect any change to the signed decision or disclosed evidence without the original Airlock database.
The verifier can prove receipt integrity and signer-key correspondence, but it cannot independently prove that the original Runtime was secure, the Validations were sufficient, the timestamp came from a trusted clock, or an optional anchor was globally observed.

Canonicalization, algorithm allowlists, key custody, rotation, selective disclosure, and transparency proofs become protocol commitments with permanent test vectors.
The protocol remains useful in an offline hackathon demo and does not require sponsor keys or a funded blockchain wallet.

## Alternatives rejected

### Sign ordinary `JSON.stringify` output

Property order and serialization differences would make cross-implementation verification brittle.

### Store the complete evidence bundle in the receipt

That would leak sensitive content, make envelopes unbounded, and prevent selective disclosure.

### Put receipts directly on a public blockchain

It would make trust depend on network access and cost while exposing permanent metadata without improving Validation correctness.

### Use an HMAC

Every verifier would need the signing secret and could forge receipts, so verification would not be independently portable.

### Treat key rotation as invalidating old signatures

Historical integrity must remain verifiable with the key that actually signed the receipt.

