# ADR 0020: Sign a separate receiver custody closure

## Status

Accepted on 2026-08-28.

## Context

Agent Airlock already exports a producer-signed Portable Promotion Envelope and Federated Work Bundle.
The receiving Airlock then persists a local Federated Admission Record, an optional Federated Approval Decision, receiver-owned Validation evidence, a terminal Portable Decision Authority, and a receiver Portable Promotion Envelope.

Those records preserve each local decision, but no portable artifact authenticates their complete ordered relationship.
Extending the producer receipt with receiver fields would make one signature appear to speak for two independent authority domains.
Signing a narrative copy of every fact would likewise obscure which claims came from producer evidence, receiver policy, the operator, Validation, and Promotion Authority.

The source-backed analysis is recorded in [Portable receiver chain-of-custody packet research](../research/portable-receiver-chain-of-custody.md).

## Decision

Agent Airlock will add a separate receiver-signed custody closure for completed federated work.

The closure will:

- Sign one strict canonical manifest of typed record descriptors, required roles, and explicit transition edges.
- Carry exact bounded canonical records needed for offline digest recomputation.
- Preserve and independently verify every nested producer and receiver signature.
- Evaluate producer and receiver signing identities under separate evaluator-supplied trust policies.
- Declare one complete terminal profile so omission cannot be interpreted as a shorter valid history.
- Bind the producer receipt and artifact to receiver Admission, exact reviewed context when present, receiver Run identity, Outcome Contract, Validation commitment, terminal Decision Authority, and receiver Promotion or Quarantine receipt.
- Keep trust policies, Authority Trust Roots, private keys, credentials, prompts, Runtime output, mutable local paths, and unredacted sensitive content outside the packet.

The first implementation profile is full-audit, offline, additive, and network-free.
It may reuse the existing operator-held Ed25519 key material, but it uses a distinct signature domain and is evaluated as a receiver custody role rather than a producer receipt role.

Optional transparency, timestamp, or blockchain evidence may commit only the custody manifest digest.
Such evidence is reported separately and never grants Admission, satisfies Validation, or grants Promotion Authority.

## Consequences

An independent verifier can authenticate the receiver's commitment to one closed evidence set without reading either application database.
The verifier can detect missing records, substituted decisions, stale reviewed contexts, broken state handoffs, and conflicting terminal claims when the contradictory evidence is presented.

The closure cannot prove that a previously unsigned receiver journal existed before export.
It cannot prove that Validation logic was correct or sufficient.
It cannot provide global replay prevention, universally trusted time, or split-view resistance without independent receiver state or witnesses.

Existing receipt, evidence packet, decision chain, federated import, and judging paths remain unchanged.
Unsupported packet versions and legacy profiles fail closed unless the evaluator explicitly enables them.

## Rejected alternatives

### Extend the producer Portable Promotion Receipt

Rejected because it conflates producer provenance with receiver Admission and Promotion authority.

### Sign one aggregate narrative

Rejected because it erases claimant boundaries and makes independent verification of nested evidence ambiguous.

### Sign every receiver journal record independently

Rejected for the first slice because it adds many recovery-critical signing boundaries but still needs an authenticated completeness declaration.

### Make blockchain the custody authority

Rejected because publication evidence cannot determine signer authorization, Admission, human approval, Validation, or Promotion.
