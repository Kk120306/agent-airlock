# Portable Trust architecture

## Purpose

Phase 11 lets a fresh offline verifier validate the integrity, included signer key, resource commitments, contract commitment, Validation commitment, disposition, ancestry, and optional Selection commitment of an exported Airlock decision.

Offline verification proves that the included Ed25519 public key signed the exact canonical content and that disclosed evidence belongs to its committed Merkle root.
It does not prove who controls the key, that the committed physical state still exists, that the statements were honest, or that the underlying policy and Validations were sufficient.

ADRs 0013 through 0016 are accepted locally and this document describes the implemented Phase 11 trust boundary.
ADR 0013 defines the portable receipt protocol, and ADR 0014 defines its independent Selection and terminal authority publication boundary.

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
- Strict signing-key trust policies, separately signed policy envelopes, and browser-local authority pinning.

The server may construct and sign envelopes through this package.
The package never imports application types, reads the Airlock database, calls ModelArk, calls a Resource Provider, or performs a network request.
The normative runtime parser and verifier enforce recursive exact keys, a one MiB envelope boundary, a 50,000-node boundary, a depth boundary, byte-bounded text, and closed algorithm identifiers.
The JSON Schema is a portable structural description, while the runtime verifier remains authoritative for canonical ordering, uniqueness, credential and path rejection, byte lengths, semantic equality, hashing, signatures, and Merkle proofs.

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

The stable Run and Agent identifiers, decision timestamp, state and resource fingerprints, and evidence commitments are required receipt fields rather than optional disclosures.

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
It writes an adjacent non-secret canonical identity marker containing the expected public key fingerprint.
Startup rejects group-readable or world-readable key or marker permissions on supported operating systems, symbolic links, malformed material, a missing key with an existing marker, and a key whose fingerprint contradicts that marker.
The private key is never serialized into the JSON store, receipt, evidence, logs, browser response, test fixture, or optional anchor.

Rotation creates a new active key and marker at a new path while retaining prior public JWK records by key identifier.
The verifier can validate a historical envelope using its included public JWK without contacting the signer.
An external operator trust inventory may label a key trusted, retired, lost, or compromised with an effective time, but that policy assessment remains separate from mathematical signature validity.
The [key rotation and compromise runbook](../operations/PORTABLE_RECEIPT_KEYS.md) defines that operational separation.

## Federated organizational trust

A signing-key trust policy names exact receipt-key fingerprints, active, retired, or compromised status, signing windows, Agent scope, and disposition scope.
The policy is canonicalized, hashed, and signed with a distinct Ed25519 policy-authority key under `agent-airlock-signing-key-trust-policy-v1\0` domain separation.
Its signed envelope includes public verification material but does not treat that included authority key as trusted.
The evaluator must pin one or more expected policy-authority fingerprints through an independent channel.
The verifier checks schema, policy digest, authority-key fingerprint, policy signature, and the evaluator-supplied trust root before evaluating the receipt signer.
A valid policy signature from an unpinned authority fails authorization, which prevents a receipt producer from minting a policy that trusts its own receipt key.
Unknown receipt keys, compromised keys, policy timing failures, signing-window failures, scope mismatches, and invalid receipt cryptography fail closed without rewriting the underlying mathematical signature result.

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
- Whole-packet receipt, anchor, and EVM binding when a Portable Evidence Packet is supplied.
- Unsupported claims such as Runtime correctness, policy sufficiency, signer-clock accuracy, key trust, and undisclosed evidence content.

One failed cryptographic or structural check makes the envelope invalid.
An absent optional anchor or absent disclosure does not make a valid signature invalid.

## Portable Evidence Packet

The version 1 Portable Evidence Packet is a deterministic one-file transport for one Portable Promotion Envelope, one optional signed transparency checkpoint and inclusion proof, and one optional offline EVM payload.
It adds no signature, authority, timestamp, or correctness claim of its own.
The verifier always validates the envelope first and then binds every included optional component to that exact receipt digest.
An invalid included component rejects the complete packet instead of being ignored.
The strict parser rejects missing or unknown fields and limits packet input to 2 MB.
Signed trust policies, Policy Authority Rotations, and evaluator-pinned Authority Trust Roots stay outside the packet because they belong to the evaluator's trust domain.

## Portable Decision Chain

The version 1 Portable Decision Chain carries a complete root-to-leaf sequence of Portable Evidence Packets for one Repair lineage.
Every packet must verify independently before the chain is considered.
The first signed receipt must be the lineage root at depth zero with no parent or prior receipt digest.
Every child must name the same Agent and root, the exact preceding Run and receipt digest, the next depth, and the same configured maximum depth.
Every child before-state identifier and composite hash must equal the preceding receipt's signed after-state commitment.
The final receipt depth must prove that no ancestor was omitted from the bounded chain.
Reordering, truncation, unrelated valid receipts, broken digest links, or discontinuous Canonical State all reject the complete chain.
The chain adds no signature or authority of its own and remains separate from evaluator-controlled trust policy.

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
Consistency verification authenticates both signed checkpoints and requires one checkpoint key identity before evaluating the Merkle continuation.
The local implementation serializes writers across processes through an append-only queue of immutable numbered lock turns, revalidates the current log while holding its turn, uses an incremental Merkle accumulator for prefix verification, and persists with an atomic replace plus file and directory synchronization.
Every turn contains one nonce-bound owner and at most one strictly validated completion marker.
Each completion marker is synchronized before atomic non-overwriting publication, so a follower cannot observe a partially written completion.
A contender may mark a stale predecessor abandoned only after its recorded process is no longer alive, and it never unlinks or reuses another turn's pathname.
Malformed turns, missing sequence numbers, conflicting completion evidence, unsafe entries, and exhausted queue bounds fail closed.
The older singleton lock format is drained only as a compatibility barrier inside the acquired queue turn and before the log operation begins.
A log history accepts exactly one checkpoint key identity, so transparency-key rotation starts a new log and explicit trust epoch.

The optional EVM reference is limited to a contract interface and offline payload encoder for one receipt digest.
The demo prints payload bytes and the exact privacy and consistency claim, performs no RPC request, submits no transaction, deploys nothing, and spends no funds.

## Export boundary

The server builds a portable receipt only from strictly parsed durable Run Transaction evidence.
Before mutable control-plane metadata is persisted, Airlock writes an immutable Decision Authority record for each terminal Run decision.
Before mutable Candidate Set Selection is persisted, Airlock separately writes one immutable Candidate Set Decision Authority that commits the final source, contracts, loser policy, bounded competitor evidence, Selection Decision, selected competitor, winner Run, and decision timestamp.
Airlock then publishes a final Candidate Set-bound authority for every already-terminal competitor before exposing the mutable Selection projection.
A terminal Run may retain both its earlier context-free authority and its final Candidate Set-bound authority for the same transaction hash.
All authorities for one Run must retain one exact parent authority digest and at most one non-null Candidate Set authority digest, so duplicate transaction hashes cannot hide contradictory ancestry or Selection context.
An available Quarantine may later add one different authoritative Discard transaction when the immutable Run core and event prefixes prove the valid lifecycle transition.
An interrupted completed Promotion may add one recovery authority only after the completed Promotion journal is verified.
That recovery authority must change `recoveredAfterRestart` from `false` to `true` and may append exactly one successful `reconcile` event for every provider already committed by the promoted transaction.
Repeated verification preserves the complete batch byte-for-byte, while a predecessor partial batch is removed and replaced only after a full live verification succeeds.
If a later verification attempt fails, mutable Run evidence remains pinned to the last terminal authority while the journal carries the bounded recovery error until a healthy retry normalizes it.
Every other transaction field and the complete earlier provider-event prefix remain exact.
No other multi-hash terminal history is accepted.
Export requires an exact match against this authority and never synthesizes a missing record from mutable database content.
Terminal progress callbacks may publish authority, but they do not expose the terminal transaction through the mutable store before the enclosing child Run and competitor lifecycle update is complete.
Airlock publishes immutable Discard authority before invoking provider Discard or removing local Candidate or Quarantine state.
The authority commits the irreversible decision and retains every provider recovery handle; it does not claim that later physical cleanup already completed.
The final Run transaction plus loser lifecycle are published in one database replacement only after provider and local cleanup succeed.
If interruption leaves local state behind after Discard authority exists, startup retries provider cleanup idempotently, removes the authorized remnant, and replays the exact authority.
If local state disappears without Discard authority, recovery fails closed even when mutable provider progress claims cleanup succeeded.
If authority publication fails, every local and provider Quarantine remains available for retry.
The Agent remains busy until the complete Candidate Set finishes Selection, winner Promotion, and loser cleanup.
Candidate Set cancellation and cleanup record authority at the branch that makes the terminal decision, while aggregate completion performs no authority reconstruction.
Decision Authority records and historical Canonical manifests are first written and synchronized under unique same-directory temporary names, then installed through non-replacing hard-link publication and directory synchronization.
New per-Run authority, Candidate Set, and provider-cleanup directories are synchronized in their pinned parent namespace before their records can become prerequisites for destructive cleanup.
Recognizable temporary remnants from interruption are removed before retry, while an existing deterministic authority target is verified rather than replaced.

Every schema 4 Canonical State also has an immutable historical manifest keyed by state identifier.
Promotion manifests reuse the installed Candidate timestamp, and Registry Transition manifests reuse the durable transition timestamp, so retry derives the exact bytes already published before an interruption.
Before signing, Airlock rebuilds the complete physical Whole-Agent state reference from the exact historical workspace, Codex home, deterministic SQLite resource, outbox, Codex thread identity, and Resource Provider versions.
It compares the rebuilt composite and every component fingerprint with both the historical manifest and the terminal decision authority.
Non-Promotion dispositions require identical before and after commitments.
It refuses export when required evidence is missing, contradictory, credential-bearing, truncated beyond the schema's disclosure claim, or associated with unresolved recovery.
Startup audits authority for active and already-terminal Runs, selects only one unambiguous latest lifecycle decision, and replays that exact transaction with any Candidate competitor projection that is behind it.
Authority corruption leaves the Run in `recovery-error`, the Agent in `error`, and execution plus Resource Registry admission closed.
Completed decisions created before Decision Authority records were introduced fail export closed because their historical authority cannot be reconstructed safely from the mutable JSON store.

The implemented HTTP and CLI boundary is:

```text
POST /api/runs/:runId/portable-receipt
agent-airlock-receipt verify envelope.json
agent-airlock-receipt verify-packet evidence-packet.json
agent-airlock-receipt verify-anchor envelope.json anchor-proof.json
agent-airlock-receipt sign-policy policy.json policy-authority.pem
agent-airlock-receipt verify-policy signed-policy.json --authority sha256:trusted-root
agent-airlock-receipt sign-authority-rotation rotation.json current-authority.pem
agent-airlock-receipt verify-authority-rotation signed-rotation.json --authority sha256:trusted-root
agent-airlock-receipt verify-policy signed-policy.json --authority sha256:trusted-root --rotation signed-rotation.json
agent-airlock-receipt evm-payload sha256:receipt-digest
```

Receipt creation is idempotent for the same Run Transaction evidence, schema, and signing key.
Changing signing key creates a different envelope signature and key identifier but not a different receipt digest.
Disclosure selection changes only the envelope's proof list and never changes the signed receipt or receipt digest.

The Playground exposes this boundary only for terminal contradiction-free Run evidence and completed Candidate Sets.
Promoted, retained, discarded, and cancelled competitors can each export a receipt that commits the same final Selection Decision and their own exact disposition.
Export is private by default, lets the operator opt into individual redacted evidence proofs, and labels local transparency and EVM calldata as optional additions rather than correctness dependencies.
The disclosure panel names the stable identifiers, timestamps, state and resource fingerprints, and evidence hashes that every receipt necessarily contains before the operator generates an artifact.
The server self-verifies every envelope and assembled packet before returning them and converts incomplete evidence into a retryable conflict without creating a key or receipt.

## Required golden vector and adversarial matrix

- RFC 8785 strings, Unicode, safe integers, property order, arrays, and rejection cases match published vectors.
- Receipt and key fingerprints match the published vector when verified in a separate process.
- Empty, single-leaf, odd-leaf, even-leaf, and large bounded Merkle trees match golden roots.
- Full disclosure, selective disclosure, and no disclosure preserve the same signed receipt.
- One-bit changes to receipt content, digest, signature, key, leaf, proof sibling, proof direction, tree size, or algorithm fail.
- Duplicate JSON names, duplicate resources, duplicate leaves, non-canonical base64url, unknown fields, unknown algorithms, unsafe integers, invalid Unicode, and oversized input fail before signature acceptance.
- Private key material, credentials, prompts, outputs, environment values, and local paths are absent from every envelope, disclosure, report, fixture, and anchor.
- A historical receipt verifies under its original public key after rotation.
- Compromised-key policy changes the trust assessment but not the mathematical signature result.
- A separately signed trust policy is accepted only under an evaluator-pinned authority fingerprint, while an unpinned or tampered authority envelope fails closed.
- A rotated policy authority is accepted only through a bounded transition signed by the pinned authority and effective at the evaluator's time.
- An unpinned, tampered, not-yet-effective, or expired authority transition fails without granting the next key any trust.
- Signature-only verification passes offline with anchoring disabled.
- Inclusion and consistency proofs pass, while conflicting same-size checkpoints trigger split-view evidence.
- Consistency proofs signed by different checkpoint keys fail even when their Merkle roots are mathematically compatible.
- A dead predecessor receives one immutable abandoned marker, every later lock turn remains present, and no contender can delete a successor's pathname.
- Symbolic-link and oversized CLI inputs fail through one no-follow, bounded file handle.
- EVM payload encoding is deterministic, contains only the receipt digest, makes no network call, and spends no funds.
- A fresh clone verifies all fixtures without the Airlock server, database, ModelArk, a provider process, or blockchain access.
- Coordinated rewrites of mutable Run, embedded Promotion Receipt, Candidate winner seal, Selection, and physical resource evidence fail against independent Decision Authority and historical-state records.
- Loss of mutable Selection after immutable authority publication restores the exact authorized decision, while terminal Quarantine authority replays the exact transaction after restart.
- Promoted, retained, discarded, and cancelled Candidate Runs each verify with the final Candidate Set Selection commitment.
- Registered Resource Provider source and installed versions export successfully, while provider-version, fingerprint, required-Validation, and historical-vector corruption fail before key creation.
- Authority and historical-manifest interruption remnants at create, partial-write, synchronized, and published stages are recovered without publishing a partial deterministic target.
- A Repair child preserves the exact parent authority it referenced even if the parent later receives a new discarded disposition.
