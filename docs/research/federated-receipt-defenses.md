# Replay, revocation, and split-view defenses for federated receipts

**Status:** Research note for GitHub issue [#14](https://github.com/Kk120306/agent-airlock/issues/14)

**Research date:** 2026-08-28

**Decision boundary:** This note supplies evidence and implementation implications for ADR 0018.
It does not change the product requirements, architecture, or accepted ADRs.

## Question

Which minimal protocol evidence lets a receiving Airlock detect replay, revoked authority, protocol downgrade, equivocation, and transparency split views without making an online service or blockchain mandatory?

## Conclusion

No single receipt, timestamp, transparency proof, or blockchain commitment can provide every required guarantee.
The minimum useful design is a receiver-owned composition of independent controls:

1. A strict signed receipt and exact artifact commitment establish integrity and signed provenance.
2. An evaluator-pinned trust root and locally installed policy snapshot establish authorization and current local distrust.
3. A durable receiver replay ledger establishes at-most-once Candidate creation at that receiver.
4. A receiver challenge and producer-signed handoff proof optionally establish fresh, receiver-specific online transfer.
5. A signed transparency checkpoint plus inclusion proof establishes membership in one log view.
6. A consistency proof from a receiver-pinned checkpoint establishes append-only growth relative to that receiver's prior view.
7. Independent checkpoint exchange or a configured witness quorum is required to strengthen detection of views that the log keeps isolated from each other.
8. Local Outcome Contract Validations and local Promotion Authority remain separate from all imported evidence.

The fully offline profile can detect mutation, policy mismatch, local replay, checkpoint rollback, and equivocation that conflicts with evidence the receiver already holds.
It cannot prove globally fresh authority state, globally unique consumption, trusted wall-clock time, or the absence of a fork never shown to another observer.

## What the primary specifications establish

### Integrity and artifact identity

The in-toto Statement v1 schema binds an attestation to subjects through immutable identifiers and requires every subject to carry a digest.
The specification also warns that subjects are matched purely by digest regardless of content type, so a consumer that cares about type must enforce that context separately.
Airlock should therefore bind the artifact digest, byte length, schema identifier, and media type in the import identity instead of treating a digest alone as sufficient identity.
See the [in-toto Statement v1 specification](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/statement.md).

The in-toto envelope guidance separates serialization and authentication from the statement and recommends authenticating the payload type.
It tells consumers to rely on the authenticated statement predicate type rather than an unauthenticated storage media type.
Airlock should likewise authenticate every protocol discriminator and then evaluate it against a closed local allowlist.
See the [in-toto Envelope specification](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/envelope.md).

The older in-toto supply-chain specification explicitly states that in-toto does not prevent replay of older, unexpired layouts and recommends TUF for secure trust bootstrap.
This is direct evidence that signature and artifact integrity do not by themselves establish freshness or current authorization.
See the [in-toto specification, defender non-goals](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md#152-defender-goals-and-non-goals).

### Receipt identity and ancestry

A canonical receipt digest is a stable content identity, not a consumption token.
Presenting the same valid digest again is therefore not cryptographic misbehavior by itself.
The receiver has to decide whether that presentation is an exact retry, a forbidden second local consumption, or a distinct transfer to another receiver.

A complete Portable Decision Chain adds signed parent-digest and Canonical State handoff evidence.
That chain can detect omitted or reordered ancestry but cannot make its leaf fresh or single use.
The receiver must evaluate ancestry completeness before deriving the import identifier so a truncated chain cannot alias the intended complete import.

### Policy freshness, rollback, and key rotation

TUF separates root, targets, snapshot, and timestamp responsibilities.
Its timestamp role is frequently re-signed to bound how long a client can remain unaware of interference, while snapshot metadata binds versions of target metadata to prevent mix-and-match behavior.
Its client workflow persists trusted metadata, rejects version rollback, checks expiration against one fixed update-start time, and obtains root updates one consecutive version at a time.
See [TUF 1.0.36 sections 2.1, 5.1 through 5.6, and 6.1](https://theupdateframework.github.io/specification/v1.0.36/).

TUF root rotation requires each next root to satisfy the threshold of both the previously trusted root and the new root.
This creates explicit continuity and prevents a replacement root from authorizing itself.
Airlock's evaluator-pinned Policy Authority and predecessor-signed rotation follow the same trust-direction principle, although ADR 0015 deliberately supports only one bounded transition in version 1.

TUF also states that a repository attacker can withhold new root metadata and freeze a client until its latest trusted root expires.
This limitation is fundamental for offline admission: a valid locally held policy snapshot can prove what the receiver knew, but it cannot prove that no newer revocation exists elsewhere.
Airlock must describe such a result as evaluation under the receiver's exact installed policy version, not as globally current authority status.

For an offline revocation snapshot, the minimal authenticated content is the exact policy schema and version, policy identity, issuance and expiry, authority fingerprint, ordered signer-key rules, signing windows, scopes, compromise status, and canonical digest.
The receiver must add its own immutable installation generation, prior installed policy digest, installation time, and operator provenance because producer-signed content cannot attest that the receiver actually accepted it or that it is the newest snapshot the receiver has seen.
The signed policy envelope establishes origin and integrity, while the receiver installation record establishes monotonic local authority state.
An absent expiry allows an intercepted snapshot to be replayed indefinitely, while expiry only bounds the freeze window according to the receiver's clock and does not reveal a withheld newer snapshot.

Sigstore's TrustedRoot specification requires retaining previously used transparency-log, certificate-authority, and timestamp-authority instances so historical signatures remain verifiable across rotation.
It also keeps the complete trust set separate from the smaller policy-selected set used for one artifact verification.
Airlock should preserve old public verification material for mathematical audit while applying current admission distrust independently to new Candidate creation.
See Sigstore's [TrustedRoot protocol definition](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_trustroot.proto).

### Replay and receiver challenges

RFC 9449 uses a unique proof identifier, short acceptance window, endpoint binding, and an optional unpredictable server nonce to reduce replay.
It says a server can reject duplicate proof identifiers during the acceptance window and notes that strict single-use enforcement needs shared durable state when several servers serve one logical endpoint.
It also states that its proof does not cover the HTTP message body, which is an intentional limitation for DPoP but would be unsafe for an artifact transfer proof.
See [RFC 9449 sections 4.2, 8, 9, and 11.1](https://www.rfc-editor.org/rfc/rfc9449.html).

The analogous Airlock online handoff proof must bind more than a nonce.
It should be domain-separated and signed by an already authorized producer key over the receiver identity, producer identity, nonce, receipt digest, artifact digest, artifact schema, media type, policy profile identifier, issued time, and expiry.
The receiver must persist and consume the nonce atomically with the Federated Admission Record.
A signature over an unbound nonce would permit artifact substitution, and a nonce without durable consumption would permit same-receiver replay.

The online challenge is optional because an offline transfer cannot obtain a fresh receiver nonce.
Offline transfer therefore relies on bounded local policy age and the durable import identity, and it must not claim proof of liveness or global single use.

RFC 3161 defines a trusted time-stamping service as evidence that a datum existed before a claimed time and permits a request nonce to bind the response to the request.
Such a token can strengthen external time evidence when the receiver already trusts the time-stamping authority, but it adds another authority and is not required for Airlock's offline profile.
The receipt signer's `decidedAt` and a log's self-asserted time remain signed clock claims rather than universally trusted time.
See [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html).

### Transparency inclusion, consistency, and split views

RFC 9162 defines a Merkle inclusion proof as evidence that one leaf belongs to one tree root and a Merkle consistency proof as evidence that a larger tree is an append-only extension of a smaller tree.
The two proofs answer different questions and neither chooses which log key or checkpoint the receiver should trust.
See [RFC 9162 section 2.1.3.2](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.3.2) and [section 2.1.4.2](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.4.2).

RFC 9162 identifies conflicting views as log misbehavior and explains that detecting views presented to different parties requires clients to compare signed tree heads.
It calls this comparison gossip and leaves the mechanism outside the protocol.
Therefore, a valid inclusion proof against a valid signed checkpoint is not evidence that every observer received the same checkpoint.
See [RFC 9162 section 11.3](https://www.rfc-editor.org/rfc/rfc9162.html#section-11.3).

The Sigstore threat model likewise assigns append-only checks and cross-user tree-head comparison to monitors.
It explicitly states that replay and fork attacks can remain undetected when the relevant log and monitor are both compromised.
See the official [Sigstore threat model](https://docs.sigstore.dev/about/threat-model/).

Rekor's API and bundle formats carry an inclusion proof and the signed checkpoint on which it is based, and the API exposes consistency-proof material between tree sizes.
This supports offline verification of a bundled view but does not create an independent observer.
See Rekor's [official OpenAPI definition](https://github.com/sigstore/rekor/blob/main/openapi.yaml).

The Rekor v2 client specification requires clients to select the checkpoint key through a separately supplied TrustedRoot and to compute inclusion and consistency proofs from authenticated log tiles.
It describes witness cosigning as the stronger mechanism for independently checking that a log stays append-only, while also noting that the initial Rekor v2 launch does not yet provide witnessed checkpoints.
See the official [Rekor v2 client specification](https://github.com/sigstore/rekor-tiles/blob/main/CLIENTS.md).

The C2SP transparency-log cosignature specification defines a witness cosignature as a statement that the witness verified checkpoint consistency.
It says a client can require a quorum of independently configured cosignatures before trusting an inclusion proof to prevent split-view attacks.
Witness identities and thresholds remain evaluator policy and cannot be accepted merely because the producer bundled signatures.
See the [C2SP transparency-log cosignature specification](https://c2sp.org/tlog-cosignature).

## Minimal evidence profiles

### Profile A: bilateral offline admission

The minimum input is:

- One strict Portable Promotion Envelope or complete Portable Decision Chain.
- One exact artifact and manifest containing its digest, byte length, schema identifier, and media type.
- One signed Signing-Key Trust Policy verified under an evaluator-pinned Authority Trust Root.
- Any bounded Policy Authority Rotation required to reach the policy signer under ADR 0015.
- One exact locally installed Federated Admission Policy version and its digest.
- The receiver's durable replay-ledger state and current emergency-distrust state.
- One receiver evaluation time with an explicit statement that it is a local clock input.

This profile can establish exact signed content, artifact integrity, signer authorization under the installed policy, local scope and freshness checks, local replay behavior, and a deterministic admission result.
It cannot establish current global revocation state, producer liveness, globally trusted time, cross-receiver single use, or a globally consistent transparency view.

### Profile B: receiver-targeted online handoff

Profile B adds:

- A receiver-generated unpredictable nonce with a bounded expiry.
- A stable receiver identity and exact handoff profile identifier.
- A domain-separated producer signature that binds the nonce and receiver to the exact receipt and artifact identities.
- An atomic receiver record that consumes the challenge and import identity together.

This profile detects pre-generated or copied handoff proofs at the intended receiver and prevents a proof for one artifact, receiver, or protocol profile from authorizing another.
It still does not create global single use unless every receiver shares one authoritative consumption ledger, which is intentionally not required.

### Profile C: checkpoint-relative transparent admission

Profile C adds to Profile A or B:

- An inclusion proof for the exact receipt digest.
- A signed checkpoint verified under an exact locally trusted log key.
- The leaf index, tree size, root hash, log origin or identity, and proof path.
- A receiver-pinned earlier checkpoint and consistency proof when continuity is required.

This profile detects an omitted leaf, a forged checkpoint, rollback below the pinned tree size, conflicting roots at the same tree size, and non-append-only growth relative to the receiver's pinned checkpoint.
It cannot detect a fork created before the receiver's first pin or a fork kept consistent and isolated from that receiver.

### Profile D: witnessed transparent admission

Profile D adds:

- A locally configured set of independent witness identities and public keys.
- A local threshold over distinct witness operators.
- Valid cosignatures over the exact checkpoint under that threshold.

This profile provides portable evidence that the configured witnesses observed a consistent checkpoint.
Its strength depends on witness independence, key distribution, threshold policy, and the assumption that enough witnesses do not collude with the log.
It is optional and can remain offline at verification time when the complete checkpoint and cosignatures are bundled.

## Receiver state that must remain durable

Cryptographic evidence alone is insufficient for deterministic admission after restart.
The receiver must preserve these append-only or immutable records:

- Every Federated Admission Policy version and canonical digest.
- The highest locally accepted policy generation or an equivalent non-rollback installation record.
- Every accepted Authority Trust Root and bounded rotation artifact needed for historical verification.
- Current emergency-disable and compromised-key decisions with their local effective times.
- Every terminal Federated Admission Record keyed by the domain-separated import identifier.
- Every issued online challenge until it expires or is consumed.
- Every consumed challenge identifier and its exact receipt, artifact, receiver, and result binding.
- The latest checkpoint pinned for every exact transparency-log trust epoch.
- Every directly observed same-size checkpoint conflict and invalid consistency result.

A producer-supplied policy, checkpoint, or revocation snapshot may be evidence, but it cannot replace receiver-owned installation history.
The receiver must reject a lower policy generation, the same generation with a different digest, a checkpoint from a different log key, and a checkpoint that moves backward.

## Separation of guarantees

| Layer                      | Evidence                                                   | What it can establish                                                    | What it cannot establish                                    |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Cryptographic integrity    | Strict receipt digest and signature                        | The included key signed the exact receipt                                | Who controls the key or whether it is authorized            |
| Artifact identity          | Digest, byte length, schema, and media type                | The admitted bytes match the exact typed artifact identity               | Whether the artifact is safe or useful                      |
| Identity and authorization | Evaluator-pinned authority plus locally installed policies | The signer and scopes were authorized under exact receiver policy inputs | Universal identity or globally current policy               |
| Freshness                  | Local clock bound or receiver challenge                    | Bounded local age, or fresh receiver-targeted transfer                   | Universally trusted time without an external time authority |
| Local replay               | Durable import and challenge ledgers                       | At-most-once Candidate creation at one receiver                          | Single use across independent receivers                     |
| Transparency inclusion     | Signed checkpoint and Merkle inclusion proof               | The receipt digest appears in one authenticated log view                 | Append-only history or a globally shared view               |
| Transparency continuity    | Receiver-pinned checkpoint and consistency proof           | The new view extends that receiver's older view                          | Forks never compared with another observer                  |
| Witnessed transparency     | Locally trusted witness quorum                             | Configured independent observers cosigned the checkpoint                 | Safety if the log and threshold of witnesses collude        |
| Local Validation           | Receiver Outcome Contract evidence                         | Candidate State satisfies the receiver's required post-conditions        | Upstream Runtime honesty or all future safety               |
| Promotion                  | Receiver Promotion Authority and journal                   | One locally validated Candidate may replace Canonical State              | Authority from any upstream receipt or log                  |

## Required failure semantics

Every cryptographic, structural, policy, replay, freshness, and transparency input must be checked before artifact bytes become available inside Candidate State.
The evaluator must fail closed at the first stable reason and persist the exact terminal Admission Record when the import identity is well-formed enough to do so safely.
Malformed inputs that cannot yield a safe bounded identity must be rejected without creating a replay-ledger entry or Candidate State.

An exact retry returns the previously recorded outcome and does not create a second Candidate.
A reused challenge or transfer identity with different bindings is a conflict rather than a retry.
A newer local policy or revocation decision does not rewrite historical Admission Records, but it governs every new admission attempt.
A compromised key may remain mathematically valid for historical audit while being categorically ineligible for new admission.

Missing network access is not itself a failure for profiles whose complete evidence is present locally.
It is a stable failure when the selected local policy requires a live challenge, a new consistency base, or another online fact that is absent.
The receiver must not silently downgrade to a weaker profile.

Successful admission creates only isolated Candidate State.
Any local Validation failure quarantines or discards that Candidate according to local policy while leaving Canonical State unchanged.
No upstream Promotion, transparency proof, witness quorum, or blockchain record can bypass local Validation or grant Promotion Authority.

## Deterministic test vectors

All vectors assume strict bounded parsing and exact field matching before semantic evaluation.

| ID      | Condition                                                                                                                          | Expected result                                                       | Stable reason                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| FDR-001 | Valid receipt, exact typed artifact, authorized signer, current local policy, unused import identity, and no required transparency | Admit once to Candidate State                                         | `admitted`                          |
| FDR-002 | Receipt bytes differ after signing                                                                                                 | Reject before artifact materialization                                | `receipt-integrity-failed`          |
| FDR-003 | Artifact digest differs from the manifest                                                                                          | Reject before Candidate creation                                      | `artifact-integrity-failed`         |
| FDR-004 | Artifact bytes and digest match but the media type or artifact schema is substituted                                               | Reject because typed identity is part of scope                        | `artifact-type-mismatch`            |
| FDR-005 | Receipt, packet, chain, artifact, or policy schema version is not explicitly allowed                                               | Reject without fallback parsing                                       | `protocol-not-allowed`              |
| FDR-006 | Producer bundles a valid trust policy signed by an unpinned authority                                                              | Reject while preserving the mathematical policy-signature result      | `authority-unpinned`                |
| FDR-007 | A control-plane installation attempts to replace local admission policy with a lower generation                                    | Reject without replacing local policy                                 | `policy-rollback`                   |
| FDR-008 | A control-plane installation presents the same local policy generation with a different canonical digest                           | Reject and surface equivocation                                       | `policy-generation-conflict`        |
| FDR-009 | Signing policy is expired at the receiver's fixed evaluation time                                                                  | Reject                                                                | `policy-expired`                    |
| FDR-010 | Current local distrust marks the receipt key compromised even though the receipt predates compromise                               | Reject new admission while retaining historical signature validity    | `signer-compromised`                |
| FDR-011 | Retired receipt key signed inside its authorized historical window and current local policy still permits admission                | Continue evaluation                                                   | `historically-authorized`           |
| FDR-012 | Authority rotation is signed only by the new key or skips the pinned predecessor required by ADR 0015                              | Reject                                                                | `authority-rotation-invalid`        |
| FDR-013 | Exact import identity already has a terminal Admission Record                                                                      | Return that record without another Candidate                          | `admission-replay`                  |
| FDR-014 | Reused transfer or challenge identity binds different receipt, artifact, producer, receiver, or policy values                      | Reject and preserve the first binding                                 | `admission-conflict`                |
| FDR-015 | The same valid offline artifact and receipt are independently offered to receivers A and B                                         | Each receiver applies its own policy and ledger                       | `receiver-local-evaluation`         |
| FDR-016 | Online handoff proof contains an unknown, expired, or already consumed receiver nonce                                              | Reject                                                                | `handoff-challenge-invalid`         |
| FDR-017 | Online handoff proof is valid but names another receiver                                                                           | Reject                                                                | `handoff-receiver-mismatch`         |
| FDR-018 | Online handoff proof does not bind the exact receipt digest, artifact digest, schema, media type, and profile                      | Reject                                                                | `handoff-binding-mismatch`          |
| FDR-019 | Transparency inclusion is required but the proof or signed checkpoint is absent                                                    | Reject without weakening the mode                                     | `transparency-required`             |
| FDR-020 | Inclusion path does not reconstruct the root in the authenticated checkpoint                                                       | Reject                                                                | `transparency-inclusion-invalid`    |
| FDR-021 | Checkpoint signature is valid under a log key not named by local policy                                                            | Reject                                                                | `transparency-log-untrusted`        |
| FDR-022 | Presented checkpoint has the same tree size as the receiver pin but a different root                                               | Reject and retain both signed checkpoints as fork evidence            | `transparency-split-view`           |
| FDR-023 | Presented checkpoint is smaller than the receiver pin                                                                              | Reject                                                                | `transparency-rollback`             |
| FDR-024 | Larger checkpoint has a valid consistency proof from the exact receiver pin                                                        | Advance the pin only after the Admission Record is durable            | `transparency-consistent`           |
| FDR-025 | Larger checkpoint lacks or fails its required consistency proof                                                                    | Reject and retain bounded failure evidence                            | `transparency-consistency-invalid`  |
| FDR-026 | Consistency-required policy is evaluated without a receiver-pinned checkpoint                                                      | Reject rather than treating inclusion as consistency                  | `transparency-base-missing`         |
| FDR-027 | Log serves two internally consistent forks to isolated receivers that never exchange checkpoints and use no witnesses              | Neither receiver can detect the global fork from local evidence alone | `split-view-unobservable`           |
| FDR-028 | Witness mode requires two independent operators but two signatures come from one operator                                          | Reject the threshold count                                            | `witness-operator-threshold-failed` |
| FDR-029 | Exact checkpoint satisfies the locally configured independent witness threshold                                                    | Continue transparency evaluation                                      | `witness-threshold-passed`          |
| FDR-030 | Imported Candidate fails a required local Validation                                                                               | Quarantine or discard locally and leave Canonical State unchanged     | `local-validation-failed`           |
| FDR-031 | Every required local Validation passes but no local Promotion journal exists                                                       | Candidate remains unpromoted                                          | `promotion-not-authorized`          |
| FDR-032 | A public-chain digest matches the receipt but local artifact, policy, or Validation evidence fails                                 | Reject or quarantine according to the failing local stage             | `local-requirement-failed`          |

## Practical implementation implications for Agent Airlock

1. Keep the import identifier from ADR 0018 as the local replay key, but persist the complete typed binding beside it so a hash collision or identifier reuse cannot be interpreted as an exact retry without equality checks.
2. Serialize Admission Record publication and Candidate creation under one recoverable journal so restart cannot create two Candidates for one accepted import.
3. Treat admission policy installation as a non-rollback control-plane transition with a monotonic local generation and canonical digest.
4. Preserve historical receipt keys, Policy Authority keys, trust policies, rotations, and Admission Records even after current policy retires or distrusts them.
5. Evaluate emergency distrust for every new import identity after mathematical verification, while an exact replay returns only the immutable earlier Admission Record and never creates a new Candidate.
6. Keep the receiver evaluation time fixed for the complete attempt, following TUF's fixed-update-time pattern, so one attempt cannot cross an expiry boundary inconsistently.
7. Define a separate strict online handoff-proof schema rather than placing mutable nonce state inside the immutable Portable Promotion Receipt.
8. Bind the online proof to the full typed artifact identity because RFC 9449's method-and-URI binding intentionally does not protect a request body.
9. Pin transparency checkpoints per exact log trust epoch and never carry a pin across a log-key rotation without an explicit receiver-controlled transition.
10. Count witness thresholds by independent operator identity, not merely by distinct keys, following Sigstore's operator-aware trust-root model.
11. Retain two conflicting same-size signed checkpoints as direct bounded equivocation evidence and prevent either from silently replacing the receiver pin.
12. Keep `split-view-unobservable`, `global-replay-unavailable`, and `trusted-time-unavailable` as explicit unsupported claims in verifier and demo language.
13. Execute all imported artifacts only after admission inside Candidate State, then apply the receiver's own Outcome Contract and Promotion journal unchanged.

## Claims that remain unavailable without stronger assumptions

- A fully offline receiver cannot know that its signed policy snapshot is the newest policy published anywhere.
- Independent receivers cannot prove global single use without sharing an authoritative replay service or later exchanging consumption evidence.
- An inclusion proof cannot prove append-only history.
- A consistency proof cannot prove that every observer received the same history.
- A receiver with no prior checkpoint cannot detect a fork that predates its first pin.
- A witness quorum cannot help if the configured threshold colludes with the log or if witness keys were not independently trusted.
- A receipt timestamp, log timestamp, or local clock is not universally trusted time.
- A blockchain digest can add publication ordering under its own consensus assumptions, but it cannot select the receiver's trusted producer, current revocation policy, artifact scope, Outcome Contract, or Promotion Authority.
- Valid upstream evidence cannot establish that the imported artifact satisfies the receiver's local post-conditions.

## Recommendation for issue #14

Adopt Profiles A through C as the minimal Phase 12 protocol model, with Profile B required only for relationships that demand receiver-targeted online freshness and Profile C required only for scopes that demand checkpoint-relative transparency.
Keep Profile D as an optional stronger extension that can be verified offline from a complete cosigned checkpoint but requires separately configured witness trust.

Describe every verdict as a composition of independent results for integrity, typed artifact identity, authority trust, signer authorization, freshness, local replay, transparency, local Validation, and Promotion authority.
Never collapse those results into a single claim that a receipt is globally trusted or safe.

This recommendation satisfies the issue resolution rule because it keeps cryptographic integrity separate from identity, freshness, authorization, local Validation, and Promotion authority, while naming the exact guarantees that remain unavailable without online coordination or additional trusted observers.

## Primary sources

- [RFC 9162: Certificate Transparency Version 2.0](https://www.rfc-editor.org/rfc/rfc9162.html)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 3161: Internet X.509 Public Key Infrastructure Time-Stamp Protocol](https://www.rfc-editor.org/rfc/rfc3161.html)
- [The Update Framework Specification 1.0.36](https://theupdateframework.github.io/specification/v1.0.36/)
- [in-toto Attestation Framework 1.2](https://github.com/in-toto/attestation/tree/v1.2.0/spec)
- [in-toto Supply Chain Specification 1.0](https://github.com/in-toto/specification/blob/v1.0/in-toto-spec.md)
- [Sigstore TrustedRoot protocol definition](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_trustroot.proto)
- [Sigstore threat model](https://docs.sigstore.dev/about/threat-model/)
- [Rekor OpenAPI definition](https://github.com/sigstore/rekor/blob/main/openapi.yaml)
- [Rekor v2 client specification](https://github.com/sigstore/rekor-tiles/blob/main/CLIENTS.md)
- [C2SP transparency-log cosignature specification](https://c2sp.org/tlog-cosignature)
