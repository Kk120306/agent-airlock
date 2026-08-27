# ADR 0015: Cross-sign Policy Authority Rotation from the pinned root

## Status

Accepted after evaluator-pinned policy authorities shipped and exposed the operational need to rotate that authority without blind re-pinning.

## Context

ADR 0014 makes organizational trust fail closed unless the evaluator independently pins the Policy Authority fingerprint.
Replacing that fingerprint out of band is secure but operationally fragile when many offline verifiers share the same root.
A new authority key cannot safely authorize itself, and a trust policy signed by that new key cannot prove continuity from the old root.
Mandatory blockchain, certificate-authority, or server lookup would weaken the offline and zero-upload verification boundary.

## Decision

Airlock defines a bounded `agent-airlock/policy-authority-rotation` statement and separately signed envelope.
The currently pinned Policy Authority signs the domain-separated message `agent-airlock-policy-authority-rotation-v1\0 || rotationDigestBytes`.
The statement names exact previous and next authority fingerprints, includes the next Ed25519 public JWK, and defines issuance, effective, and optional expiry times.
The verifier derives the next authority only when the statement schema, canonical digest, both key fingerprints, old-authority signature, pinned-root membership, and evaluator-time window all pass.
The signed trust policy remains a separate artifact and must independently verify under the derived next key.
Version 1 supports one explicit transition from a pinned root and does not infer an unbounded authority chain.

## Consequences

Organizations can rotate a policy authority while preserving offline verification and the evaluator's original trust bootstrap.
The old authority, transition, new authority, and policy remain independently inspectable and fail independently.
A compromised old authority can forge a transition, so compromise response still requires an out-of-band root update or revocation decision.
The evaluator clock remains a local input rather than an externally trusted timestamp.
Long rotation chains require future explicit chain semantics, rollback policy, and bounded path validation rather than recursive self-discovery.

## Alternatives rejected

### Automatically trust the authority embedded in the newest policy

This restores self-authorization and makes key substitution indistinguishable from legitimate rotation.

### Replace the pinned fingerprint silently

This removes the evaluator-controlled trust bootstrap and provides no cryptographic continuity evidence.

### Require a blockchain or online certificate service

An external registry can publish transition data but still cannot choose the evaluator's root, and mandatory network access would break the offline verifier guarantee.
