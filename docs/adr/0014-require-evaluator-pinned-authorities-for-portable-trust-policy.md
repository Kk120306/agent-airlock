# ADR 0014: Require evaluator-pinned authorities for portable trust policy

## Status

Accepted locally after the browser-local receipt verifier demonstrated the remaining distinction between mathematical signature validity and organizational signer authority.

## Context

A receipt envelope contains the public key that signed it, which is sufficient to verify integrity but insufficient to grant that key organizational authority.
An unsigned imported trust policy can express an evaluator's local decision, but it cannot be safely forwarded across teams because recipients cannot detect substitution or determine who issued it.
A policy that includes and automatically trusts its own authority key has the same self-authorization flaw as a receipt that declares its own signer trusted.

## Decision

Airlock defines a strict bounded signing-key trust policy and a separately signed policy envelope.
The policy authority uses Ed25519 with the domain-separated message `agent-airlock-signing-key-trust-policy-v1\0 || policyDigestBytes`.
The policy authority key is operationally separate from receipt-signing and transparency-log keys.
The envelope carries its public JWK and verified fingerprint only as cryptographic material.
A verifier must receive an expected authority fingerprint through an evaluator-controlled channel and must reject a valid policy signature whose authority is not explicitly pinned.

Receipt verification, policy-envelope verification, authority-root matching, and signer-scope evaluation remain separate checks with separate visible verdicts.
A failed organizational trust decision never changes whether the historical receipt signature is mathematically valid.
Compromised receipt keys fail trust regardless of signer-claimed timestamps because the receipt clock is not an external timestamp proof.

## Consequences

Organizations can distribute portable signer policy without operating an Airlock server or publishing private evidence.
A receipt producer cannot authorize its own key merely by attaching another self-signed object.
The initial policy-authority fingerprint remains a deliberate trust bootstrap that must be delivered independently, such as through managed configuration, a verified release channel, or direct operator exchange.
Authority-key rotation requires an explicit new pinned fingerprint or the cross-signed transition protocol accepted in ADR 0015.

## Alternatives rejected

### Trust every authority key included in a policy envelope

This verifies key possession but permits any party to mint a policy that authorizes itself.

### Embed signer trust inside the receipt

This lets the statement being evaluated define its own authority and collapses integrity into authorization.

### Require a public blockchain for policy authority

A blockchain can publish a digest but cannot decide which governance root an evaluator trusts, and mandatory network access would weaken the offline demo and verification boundary.
