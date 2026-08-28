# ADR 0018: Make federated admission local, versioned, and non-authoritative

## Status

Accepted locally for the Phase 12 federated-admission boundary.
The primary-source security analysis and deterministic defense vectors are recorded in [Replay, revocation, and split-view defenses for federated receipts](../research/federated-receipt-defenses.md).

## Context

Phase 11 proves the integrity and ancestry of a Portable Promotion Receipt and can evaluate its signing key under an evaluator-pinned Signing-Key Trust Policy.
Those checks do not decide whether a receiver should copy the referenced artifact into its own Candidate State.
A producer-controlled policy, signature, transparency log, blockchain anchor, or upstream Promotion decision cannot safely make that local decision.

The receiver needs one deterministic boundary that combines protocol compatibility, producer authorization, artifact scope, freshness, revocation, replay defense, and optional transparency evidence.
That decision must remain explainable after the local policy changes and must not give imported work authority over Canonical State.

## Decision

Define a **Federated Admission Policy** as an immutable, receiver-controlled policy version.
The receiver snapshots the exact policy identifier and digest before evaluating one imported evidence bundle.
The policy is installed only through an explicit local operator action or an authenticated local control-plane change that preserves the prior version.
The producer cannot supply, select, downgrade, or expand the effective policy.

Each producer rule binds one evaluator-pinned Policy Authority and exact receipt-key fingerprints to all of these closed scopes:

- A stable local producer identifier.
- Allowed Portable Promotion Receipt schema versions.
- Allowed artifact media types and artifact schema identifiers.
- Allowed Agent aliases, dispositions, built-in resource kinds, provider identifiers, and provider resource kinds.
- Required ancestry form, maximum ancestry depth, and whether a complete Portable Decision Chain is mandatory.
- Maximum receipt age, whether offline transfer is allowed, and an optional receiver-issued online handoff expiry.
- Maximum artifact bytes and exact digest algorithm.
- Transparency mode `not-required`, `inclusion-required`, or `consistency-required`.
- Exact trusted transparency-log key fingerprints and a receiver-pinned prior checkpoint when consistency is required.
- An emergency-disable flag and an optional local approval requirement.

Empty scope lists mean no permission rather than unrestricted permission.
Wildcard producer, resource, artifact, key, algorithm, and schema scopes are not supported in version 1.
Trust on first use is not supported.

The admission evaluator executes these stages in order and fails closed at the first failure:

1. Strictly parse a bounded import manifest, artifact, receipt envelope or complete decision chain, signed Signing-Key Trust Policy, and any required transparency evidence.
2. Verify receipt or chain integrity, exact artifact digest and byte length, state ancestry, and protocol compatibility.
3. Verify the Signing-Key Trust Policy under the locally pinned Authority Trust Root and evaluate the receipt signer at the receipt decision time.
4. Evaluate the current Federated Admission Policy snapshot for producer, signer, schema, disposition, artifact, resource, ancestry, size, and freshness scope.
5. Apply current emergency distrust and revocation state at the receiver evaluation time.
6. Verify required transparency inclusion and, when configured, consistency from the locally pinned prior checkpoint.
7. Return the exact prior result for a consumed import identifier and reject contradictory reuse of its receipt, artifact, producer, or policy bindings.
8. Obtain explicit local approval when the matched producer rule requires it.
9. Create an immutable Federated Admission Record before making the imported artifact available as isolated Candidate State.

The import identifier is a domain-separated SHA-256 digest over the producer identifier, receipt digest, artifact digest, artifact schema, and artifact media type.
The receiver keeps an append-only local replay ledger keyed by this identifier.
A retry may return the exact existing Admission Record but may not create a second Candidate or reinterpret the import under a different policy version.

Receipt timestamps remain signer-clock claims.
The receiver enforces freshness conservatively with its own evaluation time and the policy's maximum receipt age.
An online handoff may add a receiver-issued nonce and expiry to prove transfer freshness.
An offline import is eligible only when the local rule explicitly allows offline transfer and never claims proof of global non-replay or an externally trusted timestamp.

A key marked compromised or a producer marked emergency-disabled is ineligible for every new admission, including receipts signed before the local distrust event.
Historical receipt signatures and previously recorded admission decisions remain mathematically verifiable.
Policy or revocation changes never rewrite an earlier Admission Record.
An operator may separately mark a prior local Candidate or Promotion for investigation, but that response is not retroactive mutation of admission evidence.

Policy Authority rotation follows ADR 0015.
Receipt-key rotation requires the new exact key fingerprint to appear in a valid Signing-Key Trust Policy under the locally accepted Policy Authority and within an explicit signing window.
Neither a new receipt key nor a producer-provided transition can authorize itself.

Transparency is optional by default because a valid signature and local authorization are sufficient for bilateral offline transfer.
High-risk producer scopes may require inclusion under an exact log key.
Consistency mode additionally requires a proof from the receiver's pinned checkpoint to the presented checkpoint.
Conflicting same-size checkpoints, an invalid consistency proof, a changed log key, or a checkpoint rollback rejects admission.
An offline receiver that has never pinned a checkpoint cannot claim split-view resistance and must reject a rule that requires consistency.

A successful admission grants only permission to construct isolated Candidate State from the verified artifact.
The receiver snapshots a local Outcome Contract, executes every required local Validation, and retains sole Promotion Authority.
The imported receipt, upstream disposition, signer authorization, transparency proof, and blockchain evidence are evidence inputs only.

## Deterministic acceptance vectors

| Vector                    | Inputs                                                                                                                                        | Result                                             | Stable reason               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------- |
| Authorized offline import | Exact trusted producer and key, allowed schema and artifact, fresh receipt, valid digest, unused import identifier, transparency not required | Admit to Candidate State                           | `admitted`                  |
| Unknown producer          | No exact local producer rule                                                                                                                  | Reject                                             | `producer-untrusted`        |
| Trust on first use        | Producer supplies a valid policy authority that is not locally pinned                                                                         | Reject                                             | `authority-unpinned`        |
| Wrong signer scope        | Valid signature from a key outside the producer rule                                                                                          | Reject                                             | `signer-scope-mismatch`     |
| Downgraded protocol       | Receipt or artifact schema is not explicitly allowed                                                                                          | Reject                                             | `protocol-not-allowed`      |
| Wrong resource scope      | Receipt commits a provider or resource kind outside the rule                                                                                  | Reject                                             | `resource-scope-mismatch`   |
| Stale receipt             | Receiver evaluation time exceeds the maximum receipt age                                                                                      | Reject                                             | `receipt-stale`             |
| Revoked signer            | Current local policy marks the signer compromised                                                                                             | Reject                                             | `signer-compromised`        |
| Emergency distrust        | Producer rule is disabled at evaluation time                                                                                                  | Reject                                             | `producer-disabled`         |
| Artifact mutation         | Artifact bytes do not match the import manifest digest and length                                                                             | Reject                                             | `artifact-integrity-failed` |
| Incomplete ancestry       | Complete chain is required but a parent is omitted or state handoff differs                                                                   | Reject                                             | `ancestry-incomplete`       |
| Replay                    | Exact import identifier already has an Admission Record                                                                                       | Return the existing result without a new Candidate | `admission-replay`          |
| Contradictory replay      | A reused transfer identity binds different receipt, artifact, producer, or policy content                                                     | Reject                                             | `admission-conflict`        |
| Missing inclusion         | Producer rule requires transparency inclusion and no valid proof is present                                                                   | Reject                                             | `transparency-required`     |
| Split view                | Same-size checkpoint conflicts with the receiver-pinned checkpoint                                                                            | Reject                                             | `transparency-split-view`   |
| Missing consistency base  | Consistency is required but the receiver has no pinned prior checkpoint                                                                       | Reject                                             | `transparency-base-missing` |
| Approval required         | Every machine check passes but local approval is absent                                                                                       | Keep pending outside Candidate State               | `approval-required`         |
| Local Validation fails    | Admission succeeds but the receiver's Outcome Contract fails                                                                                  | Quarantine or discard local Candidate State        | `local-validation-failed`   |
| Local Validation passes   | Admission succeeds and every required local Validation passes                                                                                 | Eligible for local Promotion                       | `locally-eligible`          |

## Consequences

Two organizations can exchange Agent-produced work without sharing credentials or trusting each other's Runtime, database, model, or Promotion decision.
Every accept, reject, pending, and replay result is reproducible from immutable receiver-controlled inputs.
Emergency distrust protects new admissions while preserving historical evidence.
Optional transparency can strengthen high-risk relationships without making a blockchain or online service mandatory.
The receiver still bears responsibility for artifact materialization, sandboxing, local Validation, and Promotion recovery.

The policy adds local governance and replay-ledger state that must be retained and recovered safely.
Global non-replay, universally trusted time, and worldwide split-view detection remain unsupported claims.

## Alternatives rejected

### Let a valid upstream Promotion Receipt enter Canonical State

The receipt proves a signed upstream decision, not compliance with the receiver's policy or current state.

### Let the producer bundle its admission policy

That lets the subject of the decision expand its own authority and enables downgrade attacks.

### Treat first contact as trust bootstrap

Trust on first use cannot distinguish the intended producer from the first attacker to present a key.

### Require a public blockchain for every transfer

A chain may publish a digest but cannot choose the receiver's trusted producer, artifact scope, Outcome Contract, or Promotion decision.
Mandatory online publication also breaks the credential-free offline path.

### Re-evaluate old admissions under the newest policy

That rewrites historical decision meaning and prevents deterministic audit of what the receiver actually authorized at the time.
