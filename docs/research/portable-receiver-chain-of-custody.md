# Portable receiver chain-of-custody packet research

## Question

What is the smallest vendor-neutral packet that lets an independent verifier inspect the complete federated path from producer Promotion through receiver Admission, exact human review, receiver Validation, and final Promotion or Quarantine without trusting either application database?

## Recommendation

Adopt a **receiver-signed canonical closure manifest over embedded immutable records**, while preserving every existing producer and receiver signature as a nested signature from its original trust domain.

The packet should contain:

1. One strict versioned manifest whose ordered record descriptors bind each record's trust domain, semantic role, schema, schema version, canonicalization algorithm, digest algorithm, byte length, and digest.
2. An explicit ordered edge set that binds producer Promotion to the Federated Work Bundle, Admission, optional Approval Decision, receiver Run Transaction, receiver Outcome Contract, Validation evidence root, terminal Decision Authority, and receiver Promotion Receipt or Quarantine evidence.
3. The exact bounded canonical bytes for every required record, including the existing producer-signed Portable Promotion Envelope and Federated Work Bundle and the receiver-signed terminal Portable Promotion Envelope when the receiver promoted.
4. One receiver custody signature over the manifest only, with a domain-separated payload type and a separately evaluator-pinned receiver key policy.
5. Optional evidence disclosures and optional transparency, timestamp, or blockchain proofs that bind only the manifest digest.

The manifest signature proves that the receiver committed this exact closed set of records and links.
It does not turn a producer signature into receiver authority, replace the receiver's immutable local authorities, prove that an unsigned local record existed before export, prove the correctness or sufficiency of any Validation, or make an optional anchor authoritative.

This shape follows in-toto's separation between a trusted layout and independently signed functionary links without importing its software-build-specific layout semantics.
The in-toto specification assigns the project owner responsibility for the expected steps and authorized keys, assigns functionaries responsibility for signed link evidence, and requires clients to verify the layout, links, and material-to-product continuity [in-toto Supply Chain Specification sections 2.1 and 2.3](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md#21-involved-parties-and-their-roles).

## Existing authority inventory

| Existing evidence | Authority domain | Immutable today | Signed today | Existing digest links | Portable today | Missing closure link |
| --- | --- | --- | --- | --- | --- | --- |
| Portable Promotion Envelope | Producer decision signer | Yes | Ed25519 over the receipt digest | Before and after state, Outcome Contract, Validation root, effects, ancestry, Selection, and Assurance | Yes | It does not and must not claim receiver Admission or Promotion authority |
| Federated Work Bundle | Producer transfer signer | Yes as transferred bytes | Ed25519 over the binding digest | Producer receipt, artifact, base state, and result state | Yes | It does not identify the receiver Admission that consumed the transfer |
| Federated Admission Record | Receiver admission policy evaluator | Yes in the receiver journal | No | Transfer, attempt, evidence, producer, policy, producer receipt, and artifact | No | An independent verifier cannot authenticate receiver authorship or bind it to the final receiver outcome |
| Federated Approval Decision v2 | Receiver operator decision | Yes in the receiver journal | No | Admission, pending record, exact reviewed-context digest, operator alias, choice, and reason | No | It is not authenticated outside the receiver filesystem and has no direct edge to the resulting Candidate Run |
| Promotion Journal authority | Receiver Promotion coordinator | Recoverable durable journal | No separate portable signature | Admission or Approval digest, policy digest, Run, Candidate, Validation, state installation, and terminal receipt | No | Its receiver-only fields are not committed by a portable closure signature |
| Portable Decision Authority | Receiver terminal decision authority | Yes in the receiver decision journal | No separate signature | Exact terminal transaction evidence, parent authority, Candidate Set authority, Run, Agent, and disposition | No | The later portable receipt authenticates a projection, but no packet proves which Admission or Approval authorized this terminal Run |
| Receiver Portable Promotion Envelope | Receiver decision signer | Yes and reproducible from durable authority | Ed25519 over the receipt digest | Receiver before and after state, Outcome Contract, Validation root, effects, ancestry, and terminal disposition | Yes when exported | It does not identify the producer bundle, Admission Record, or Approval Decision that caused the receiver Run |

The missing proof is therefore graph closure, not another copy of application state.
The receiver already has durable authority records for each local decision, but only a new terminal custody signature can authenticate their complete ordered relationship for an offline verifier.

## Why the manifest is the right authority boundary

### Separate producer and receiver trust domains

The producer's existing Portable Promotion Envelope and Federated Work Bundle remain byte-for-byte signed producer evidence.
The receiver manifest references their exact digests but cannot rewrite their claims.
Receiver Admission, Approval, Outcome Contract, Validation, and terminal decision records remain receiver claims and are never placed under the producer signature.

SLSA explicitly separates the builder identity named by provenance from the signer and requires consumers to accept only specific signer-builder pairs [SLSA Build Provenance, Builder](https://slsa.dev/spec/v1.2/build-provenance#builder).
This supports the Airlock rule that a valid cryptographic signature is not sufficient authorization for a different trust domain.

The W3C Verifiable Credentials model likewise leaves the verifier's decision about which issuers to trust, and for which purposes, outside the credential data model [W3C Verifiable Credentials Data Model 2.0, Trust Model](https://www.w3.org/TR/vc-data-model-2.0/#trust-model).
That is directly relevant to the non-claim, but the holder-oriented Verifiable Credential abstraction is not needed for an artifact custody graph.

### Canonical manifest versus a newly signed aggregate record

A newly signed aggregate narrative would let one receiver signature appear to restate producer facts, local operator identity, Validation outcomes, and Promotion authority.
That flattens distinct claimants and makes it difficult to tell which evidence was directly signed by whom.

A closure manifest instead signs typed commitments and graph completeness.
The verifier separately verifies each nested signature and then verifies that every descriptor, edge, state handoff, policy link, and terminal outcome matches the manifest.

The in-toto Statement is useful as an interoperability model because it binds immutable subjects by digest to an explicitly typed predicate [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md).
Its subject matching is digest-based regardless of content type, so Airlock must additionally bind each record's schema, semantic role, and media type in its strict predicate rather than relying on `subject` alone [in-toto Statement v1, subject](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md#fields).

### Canonical manifest versus signing every receiver record

Individually signing every receiver journal record would provide finer signer attribution, but it would require a new signature lifecycle at every local persistence boundary and would make recovery depend on many signing operations.
It would also duplicate existing immutable digest chains without solving completeness, because a verifier would still need an authenticated declaration of which records and links constitute the complete transfer.

The minimal design therefore retains existing nested signatures and adds one terminal receiver closure signature.
Later versions may add per-record receiver signatures without changing the graph model, but a packet must never treat them as a substitute for closure.

## Standards comparison

| Standard or format | Directly useful property | Important limit for Airlock | Decision |
| --- | --- | --- | --- |
| in-toto Statement v1 | Binds one or more immutable digest subjects to an explicitly identified predicate type [specification](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) | Subject digest matching does not itself bind content type, and the Statement does not define Airlock's authority graph | Use as the conceptual outer statement model or optional wire profile, with an Airlock-specific strict predicate |
| in-toto Link plus Layout | Keeps signed step evidence separate from the trusted expected graph, authorized keys, thresholds, and artifact continuity rules [specification](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md#43-file-formats-layout) | The core model is specialized for software supply-chain materials and products, and link metadata is intentionally reusable across layouts [link metadata](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md#312-link-metadata) | Borrow the separation and closure idea, not the complete Layout or Link schema |
| DSSE v1.0.2 | Authenticates exact payload bytes and an unambiguous payload type with pre-authentication encoding, without requiring canonicalization for signature security [DSSE protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md) | `keyid` is an unauthenticated lookup hint and cannot be used for security decisions, while authorization and replay policy are out of scope [DSSE signature definition](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md#signature-definition) | Suitable optional signature envelope for the canonical manifest, but not a trust policy or custody schema |
| SLSA Provenance v1 | Separates build definition from run details and identifies subjects, builder, external parameters, dependencies, and execution metadata [SLSA Build Provenance schema](https://slsa.dev/spec/v1.2/build-provenance#schema) | It describes how build artifacts were produced and is not a receiver Admission, human approval, local Validation, or Promotion protocol | Reuse its trust-domain lessons and structured provenance vocabulary, not its predicate as the Airlock packet |
| Sigstore Bundle v0.3 | Packages signature content with verification material, optional transparency entries, and timestamps [Sigstore Bundle Format](https://docs.sigstore.dev/about/bundle/) | Independent trust roots remain outside the bundle, the current DSSE bundle permits exactly one signature, and an included transparency entry is not receiver authority [Sigstore Bundle schema](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto) | Copy the self-contained verification-material transport pattern while keeping evaluator trust roots and local authority outside the packet |
| W3C Verifiable Credentials 2.0 | Models issuer, holder, verifier, validity, status, and application-owned issuer trust [W3C Recommendation](https://www.w3.org/TR/vc-data-model-2.0/) | It does not define Airlock's artifact state transitions or local Promotion authority, and issuer trust remains verifier business logic [trust model](https://www.w3.org/TR/vc-data-model-2.0/#trust-model) | Do not use for the core packet |
| W3C BBS Data Integrity | Can derive proofs that reveal selected JSON-LD statements from a protected credential [W3C Data Integrity BBS Cryptosuites](https://www.w3.org/TR/vc-di-bbs/#add-derived-proof) | Derived proofs add a different canonicalization and cryptographic stack, and selective disclosure can still leak through cryptographic or revealed artifacts [privacy considerations](https://www.w3.org/TR/vc-di-bbs/#selective-disclosure-and-unlinkability) | Keep as a future privacy profile only if a real unlinkable-presentation requirement appears |

## Proposed packet sketch

```json
{
  "schema": "agent-airlock/portable-receiver-chain-of-custody",
  "schemaVersion": 1,
  "manifestEnvelope": {
    "payloadType": "application/vnd.agent-airlock.receiver-chain-manifest.v1+json",
    "payload": "<base64url canonical manifest bytes>",
    "signatures": [{ "keyId": "sha256:<receiver-custody-key>", "signature": "<base64url>" }]
  },
  "records": [
    { "recordId": "producer-promotion", "canonicalBytes": "<base64url>" },
    { "recordId": "federated-work-bundle", "canonicalBytes": "<base64url>" },
    { "recordId": "receiver-admission", "canonicalBytes": "<base64url>" },
    { "recordId": "receiver-approval", "canonicalBytes": "<base64url or null>" },
    { "recordId": "receiver-terminal-evidence", "canonicalBytes": "<base64url>" }
  ],
  "disclosures": [],
  "anchors": []
}
```

The signed manifest should contain exact protocol identifiers and bounds, producer and receiver organization aliases, one transfer identity, ordered record descriptors, explicit typed edges, one declared terminal disposition, one completeness profile, and the packet privacy profile.
The packet container itself should not carry another signature or authority claim.

Every descriptor should have at least:

- `recordId` unique within the manifest.
- `trustDomain` equal to `producer` or `receiver`.
- `role` from a closed role enum.
- `schema` and exact `schemaVersion`.
- `mediaType`.
- `canonicalization` and `digestAlgorithm` from closed algorithm enums.
- `byteLength` and `digest` over the exact embedded canonical bytes.
- `signingRequirement` equal to `nested-required`, `manifest-covered`, or `nested-and-manifest`.

Every edge should bind `fromRecordId`, `fromField`, `toRecordId`, `toField`, and an exact comparison rule from a closed enum.
The manifest must declare the complete required role set for its exact terminal profile so truncation cannot be interpreted as a valid shorter history.

## Deterministic verifier stages

1. Enforce the packet byte, node, record, edge, depth, and disclosure bounds before expensive work.
2. Strictly parse the packet and reject unknown top-level or version-specific fields.
3. Decode the manifest once, verify its canonical bytes, digest, payload type, receiver custody signature, and evaluator-pinned receiver signing policy.
4. Reject duplicate record identifiers, duplicate semantic roles where the profile permits only one, unknown algorithms, unsupported schemas, and any embedded private or credential material.
5. Recompute every embedded record byte length and digest and compare them to the manifest descriptors.
6. Run the native strict parser and signature verifier for every record marked `nested-required` or `nested-and-manifest`.
7. Evaluate the producer signer only under the evaluator's producer trust policy and the receiver custody signer only under the evaluator's receiver trust policy.
8. Verify every typed edge, including exact artifact digest, Admission digest, reviewed-context digest, Candidate State identity, Outcome Contract digest, Validation evidence root, Decision Authority, before-state, and after-state handoffs.
9. Enforce the declared terminal profile and reject an absent required role, extra authority-bearing role, multiple terminal outcomes, or a non-Promotion state change.
10. Verify disclosures against their committed roots without treating undisclosed content as verified.
11. Verify every included transparency, timestamp, or blockchain component against the exact manifest digest, and reject an invalid included component rather than ignoring it.
12. Emit separate results for cryptographic integrity, producer authorization, receiver custody, chain completeness, local decision linkage, evidence disclosure, freshness, transparency, and optional anchoring.

DSSE requires the verifier to verify the signature before parsing the payload, to reject unsupported payload types, and to ensure the verified bytes are the same bytes delivered to the application [DSSE verification protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md#protocol).
Airlock should keep that invariant even if it retains the current Ed25519 envelope instead of adopting DSSE.

## Offline verification and privacy profiles

### Full-audit profile

Embed all bounded canonical receiver records needed to recompute every link, plus redacted Validation evidence disclosures.
This profile gives the strongest offline chain-completeness evidence and the weakest metadata privacy.

### Commitment-only operator profile

The Approval Decision exposes a receiver-derived pseudonymous operator identifier, choice, bounded reason classification, decision time, and reviewed-context commitment, but not a human name, email address, raw reason, browser data, or authentication credential.
The closure manifest binds the complete Approval Decision digest.

### Minimal public profile

Embed required authority records and Merkle commitments but omit optional artifact names, operator reason text, raw Validation summaries, and nonessential timestamps.
The verifier must report omitted content as undisclosed rather than passed.

W3C BBS selective disclosure is directly relevant only if Airlock later needs unlinkable presentations to different verifiers [W3C BBS privacy considerations](https://www.w3.org/TR/vc-di-bbs/#selective-disclosure-and-unlinkability).
For the hackathon path, the existing deterministic Merkle disclosure model is simpler and preserves the current offline verifier.

## Key rotation

Each nested signature and the manifest signature must carry an exact key fingerprint, while evaluator-controlled policies and trust roots stay outside the packet.
Historical verification must retain prior public keys and explicit validity windows.
A new key must not authorize itself, and a rotation must be accepted only through the separately pinned predecessor authority.

Sigstore's TrustedRoot model requires previously used instances to remain available for historical verification, accepts overlapping validity windows during rotation, and supports a future-valid instance for planned rotation [Sigstore TrustedRoot protocol](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_trustroot.proto#L222-L267).
Sigstore also requires certificate chains in a bundle to terminate at a CA independently trusted by the verifier [Sigstore Bundle protocol](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto#L54-L68).
These rules support Airlock's existing separation of embedded verification material from evaluator-pinned authority.

## Replay, downgrade, and split-view defenses

### Replay

The portable packet cannot prove global single use.
The verifier can detect duplicate packet or transfer identities in its own durable ledger, while each receiver remains responsible for its own Admission replay record.
A signature format such as DSSE authenticates bytes and type but defines no replay state [DSSE protocol scope](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md).

### Downgrade

The verifier must accept only an explicitly configured packet version, completeness profile, record schema version, signature algorithm, canonicalization algorithm, and digest algorithm.
There must be no permissive fallback from an unsupported v2 packet to a v1 parser.

SLSA's predicate rules allow unknown fields to be ignored and treat minor changes as monotonic [SLSA parsing rules](https://slsa.dev/spec/v1.2/build-provenance#parsing-rules).
That is appropriate for extensible provenance but too permissive for the Airlock authority-bearing closure manifest, which should keep strict exact-key parsing.
Sigstore's bundle schema says verifiers should not enable legacy v0.1 bundles in ecosystems that never produced them [Sigstore Bundle protocol](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto#L84-L88).
Airlock should follow that explicit legacy allowlist principle.

### Split view

An inclusion proof establishes that one digest appears under one authenticated tree root, while a consistency proof establishes that a later tree extends an earlier tree [RFC 9162 sections 2.1.3 and 2.1.4](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.3).
RFC 9162 also states that a malicious log can show inconsistent views to isolated clients unless additional comparison mechanisms exist [RFC 9162 section 1](https://www.rfc-editor.org/rfc/rfc9162.html#section-1).

The packet may carry a manifest-digest inclusion proof and signed checkpoint for offline verification.
It can claim append-only continuity only when it also carries a valid consistency proof from a checkpoint independently pinned by that verifier.
It cannot claim global split-view resistance unless independently trusted observers compare or cosign checkpoints.

## Optional blockchain anchoring

An optional blockchain payload may commit only the canonical manifest digest, packet schema identifier, and schema version.
It must contain no artifact bytes, operator identity, Validation text, secret, trust policy, Authority Trust Root, wallet authority, Admission verdict, or Promotion verdict.

The verifier should report anchoring as a separate result that proves only that the exact manifest digest was included under the supplied chain proof and the verifier's independently configured chain assumptions.
This is intentionally analogous to transparency inclusion, which proves membership under an authenticated root but not the correctness or authority of the logged statement [RFC 9162 section 2.1.3](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.3).

A matching anchor must never:

- Authorize the producer.
- Grant receiver Admission.
- Substitute for human approval.
- Satisfy an Outcome Contract.
- Turn failed Validation into passed Validation.
- Grant Promotion Authority.
- Override key compromise, policy expiry, replay, downgrade, or split-view failure.

## Adversarial acceptance vectors

| Vector | Condition | Required result |
| --- | --- | --- |
| PRC-001 | Complete valid packet with all required nested signatures and exact state handoffs | Verify each layer and report one closed terminal chain |
| PRC-002 | Producer and receiver signatures are valid but the Admission record is omitted | Reject as incomplete |
| PRC-003 | Approval Decision is substituted from another Admission | Reject the Admission digest or reviewed-context edge mismatch |
| PRC-004 | Outcome Contract changes after the reviewed context but the manifest presents the newer contract | Reject the reviewed-context and contract link mismatch |
| PRC-005 | Validation summary says passed but its evidence root differs from terminal authority | Reject the Validation evidence edge mismatch |
| PRC-006 | Two receiver Promotions claim different after-state commitments for the same local authority | Reject conflicting terminal outcomes and preserve both as conflict evidence |
| PRC-007 | A receiver manifest is valid but one required producer nested signature fails | Reject the packet without transferring producer trust to the receiver signer |
| PRC-008 | The manifest signer is trusted as a producer but not as a receiver custody signer | Reject receiver custody authorization |
| PRC-009 | An older packet or record schema is presented without an explicit evaluator legacy allowlist | Reject downgrade |
| PRC-010 | A disclosure proof is valid but required Validation content is undisclosed | Report undisclosed and do not claim that content passed |
| PRC-011 | The manifest digest has a valid log or blockchain inclusion proof but local authority linkage fails | Reject the chain and report anchor inclusion separately |
| PRC-012 | Two same-size signed checkpoints have different roots | Reject continuity and retain split-view evidence |
| PRC-013 | An exact packet is replayed at the same verifier | Return the prior local verification result without granting new authority |
| PRC-014 | The same packet is independently evaluated by another receiver | Apply that receiver's own trust policy and replay ledger |

## Cut line for implementation

Do not extend the existing Portable Promotion Receipt to contain receiver Admission or Approval fields.
Doing so would conflate the producer receipt signer with receiver-owned authority and would make the same receipt schema mean different trust domains.

Implement a new zero-authority transport package with a strict receiver closure manifest, preserve the existing Portable Promotion Envelope and Federated Work Bundle unchanged, and use a distinct receiver custody key policy.
Freeze the existing hackathon demo path by making export and verification additive, network-free, and optional.

The first implementation slice should support the full-audit offline profile only.
Add privacy profiles, Sigstore-compatible envelope export, transparency publication, or blockchain anchoring only after the manifest and adversarial vectors are stable.

## Primary sources

- [in-toto Attestation Framework, Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
- [in-toto Attestation Framework, Envelope v1](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md)
- [in-toto Supply Chain Specification 1.0](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md)
- [DSSE Protocol 1.0.2](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
- [SLSA Build Provenance 1.2](https://slsa.dev/spec/v1.2/build-provenance)
- [Sigstore Bundle Format](https://docs.sigstore.dev/about/bundle/)
- [Sigstore Bundle protocol](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)
- [Sigstore TrustedRoot protocol](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_trustroot.proto)
- [RFC 9162: Certificate Transparency Version 2.0](https://www.rfc-editor.org/rfc/rfc9162.html)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [W3C Verifiable Credential Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/)
- [W3C Data Integrity BBS Cryptosuites 1.0](https://www.w3.org/TR/vc-di-bbs/)
