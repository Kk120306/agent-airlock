# Portable Trust architecture

## Purpose

Phase 11 lets a fresh offline verifier validate the integrity, signer key, resource commitments, contract commitment, Validation commitment, disposition, ancestry, and optional Selection commitment of an exported Airlock decision.

ADR 0013 is proposed and this document is an implementation-ready design, not yet accepted behavior.

## Package boundary

`packages/portable-promotion-receipt` is a zero-server-dependency package that exports:

- Strict TypeScript types and runtime parsers.
- JSON Schema for the receipt and envelope.
- RFC 8785 canonicalization with published vectors.
- SHA-256 receipt and evidence commitment functions.
- Ed25519 signing and verification over a domain-separated digest message.
- Public JWK parsing and deterministic key fingerprinting.
- Merkle evidence commitment and disclosure-proof verification.
- A human-readable and JSON CLI verifier.

The server may construct and sign envelopes through this package.
The package never imports application types, reads the Airlock database, calls ModelArk, calls a Resource Provider, or performs a network request.

## Receipt schema version 1

The signed receipt contains only these semantic groups:

### Protocol

- Receipt schema identifier `agent-airlock/portable-promotion-receipt`.
- Schema version `1`.
- Canonicalization algorithm `RFC8785`.
- Digest algorithm `SHA-256`.
- Signature algorithm `Ed25519` in the envelope.

### Decision identity

- Run Transaction identifier.
- Agent pseudonymous identifier or explicit export alias.
- Disposition `promoted`, `quarantined`, `discarded`, or `cancelled`.
- Decision timestamp from the signer clock with an explicit statement that it is not an external timestamp proof.

### State commitments

- Canonical state identifier and composite hash before the decision.
- Canonical state identifier and composite hash after the decision, equal to the prior state for non-Promotion dispositions.
- Sorted built-in resource kind and fingerprint commitments.
- Sorted provider identifier, resource kind, version identifier, and fingerprint commitments.

### Policy and evidence commitments

- Outcome Contract schema, version, and canonical SHA-256 commitment.
- Validation evidence Merkle root, leaf count, and ordering algorithm.
- External Action Intent commitment and delivered count without payloads.
- Candidate Set identifier and selection-decision commitment when Phase 9 applies.
- Assurance Proposal identifier and accepted-contract provenance when Phase 10 applies.

### Ancestry

- Root Run identifier, parent Run identifier, depth, and maximum depth.
- Previous portable receipt digest when the exporter intentionally creates a verifiable decision chain.

The schema rejects raw output fields, filesystem paths, environment names, secrets, arbitrary metadata, unknown algorithms, duplicate resource identities, duplicate evidence leaf identities, unsafe integers, non-finite numbers, and extra fields.

## Canonical digest and signature

The receipt digest is:

```text
SHA-256(UTF8(RFC8785(receipt)))
```

The Ed25519 signature input is:

```text
UTF8("agent-airlock-portable-receipt-signature-v1\0") || receiptDigestBytes
```

The envelope encodes digest and signature bytes with unpadded base64url.
The verifier rejects non-canonical base64url, wrong byte lengths, unknown algorithms, a digest mismatch, a key identifier mismatch, or a failed signature.

The public key fingerprint is:

```text
SHA-256(UTF8(RFC8785({"crv":"Ed25519","kty":"OKP","x":"..."})))
```

The envelope's `keyId` is `sha256:` followed by that lowercase hexadecimal digest.
Private JWK fields are forbidden in every exported envelope.

## Evidence Merkle tree

Every disclosable evidence leaf has an exact schema, stable identity tuple, classification, redacted value, and value hash.
Leaves are sorted by their canonical identity tuple and duplicate identities are rejected.

Leaf hashes use domain separation:

```text
SHA-256(0x00 || UTF8(RFC8785(leaf)))
```

Internal nodes use:

```text
SHA-256(0x01 || leftHash || rightHash)
```

An unpaired final node advances unchanged to the next level.
Proofs include the leaf, zero-based leaf index, total leaf count, and ordered sibling directions so a verifier can reconstruct the exact root without guessing tree shape.

Disclosures may include bounded redacted Validation summaries, status, duration, and named evidence hashes.
They may not include prompts, Runtime output, raw command output, secrets, private files, local paths, provider credentials, or undisclosed leaf values.

## Signing key lifecycle

The POC creates an Ed25519 key in an operator-selected path outside the repository and normal application data export.
Startup rejects group-readable or world-readable private-key permissions on supported operating systems.
The private key is never serialized into the JSON store, receipt, evidence, logs, browser response, test fixture, or optional anchor.

Rotation creates a new active key while retaining prior public JWK records by key identifier.
The verifier can validate a historical envelope using its included public JWK without contacting the signer.
An optional trust policy file may label a key trusted, retired, or compromised with an effective time, but that policy assessment is reported separately from mathematical signature validity.

## Offline verification report

The CLI accepts one bounded envelope file and emits both human-readable and JSON results.
It reports:

- Schema and canonicalization validity.
- Receipt digest match.
- Public key fingerprint match.
- Ed25519 signature validity.
- Resource, contract, Validation, Selection, Assurance, and ancestry commitments present.
- Every disclosed evidence proof result.
- Optional anchor proof result when supplied.
- Unsupported claims such as Runtime correctness, policy sufficiency, signer-clock accuracy, key trust, and undisclosed evidence content.

One failed cryptographic or structural check makes the envelope invalid.
An absent optional anchor or absent disclosure does not make a valid signature invalid.

## Optional transparency log

The local reference anchor stores only ordered receipt digests and produces:

- An append-only sequence number.
- A Merkle root over digest leaves.
- A checkpoint containing tree size, root, prior checkpoint digest, timestamp, and log key identifier.
- An Ed25519 checkpoint signature under a separate log key.
- Inclusion proofs for one digest.
- Consistency proofs between checkpoint sizes.

Two signed checkpoints with the same tree size and different roots constitute direct split-view evidence.
A later larger checkpoint without a valid consistency proof is not accepted as an append-only continuation.

The optional EVM reference is limited to a contract interface and offline payload encoder for one receipt digest.
The demo prints payload bytes and the exact privacy and consistency claim, performs no RPC request, submits no transaction, deploys nothing, and spends no funds.

## Export boundary

The server builds a portable receipt only from strictly parsed durable Run Transaction evidence.
It verifies Canonical State commitments before signing a promoted decision and uses identical before and after commitments for non-Promotion dispositions.
It refuses export when required evidence is missing, contradictory, credential-bearing, truncated beyond the schema's disclosure claim, or associated with unresolved recovery.

The initial HTTP and CLI boundary is:

```text
POST /api/runs/:runId/portable-receipt
agent-airlock-receipt verify envelope.json
agent-airlock-receipt disclose envelope.json disclosure.json
agent-airlock-receipt verify-anchor envelope.json anchor-proof.json
```

Receipt creation is idempotent for the same Run Transaction evidence, schema, and signing key.
Changing signing key creates a different envelope signature and key identifier but not a different receipt digest.

## Required golden vectors and adversarial matrix

- RFC 8785 strings, Unicode, safe integers, property order, arrays, and rejection cases match published vectors.
- Receipt and key fingerprints match fixtures implemented independently in at least two processes.
- Empty, single-leaf, odd-leaf, even-leaf, and large bounded Merkle trees match golden roots.
- Full disclosure, selective disclosure, and no disclosure preserve the same signed receipt.
- One-bit changes to receipt content, digest, signature, key, leaf, proof sibling, proof direction, tree size, or algorithm fail.
- Duplicate JSON names, duplicate resources, duplicate leaves, non-canonical base64url, unknown fields, unknown algorithms, unsafe integers, invalid Unicode, and oversized input fail before signature acceptance.
- Private key material, credentials, prompts, outputs, environment values, and local paths are absent from every envelope, disclosure, report, fixture, and anchor.
- A historical receipt verifies under its original public key after rotation.
- Compromised-key policy changes the trust assessment but not the mathematical signature result.
- Signature-only verification passes offline with anchoring disabled.
- Inclusion and consistency proofs pass, while conflicting same-size checkpoints trigger split-view evidence.
- EVM payload encoding is deterministic, contains only the receipt digest, makes no network call, and spends no funds.
- A fresh clone verifies all fixtures without the Airlock server, database, ModelArk, a provider process, or blockchain access.

