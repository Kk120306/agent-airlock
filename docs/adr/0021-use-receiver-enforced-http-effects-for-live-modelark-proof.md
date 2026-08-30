# ADR 0021: Use receiver-enforced HTTP effects for the live ModelArk proof

## Status

Accepted on 2026-08-30.

## Context

ADR 0006 deliberately bounded Phase 4 effect delivery to an atomic local mock consumer.
That consumer makes the canonical recording deterministic and gives the middleware a precise exactly-once proof boundary.
It does not prove that a promoted intent can cross a real network protocol and remain safe under retry.

The optional live ModelArk conformance path is the narrow place where a real external protocol materially improves the demonstration.
Letting the Agent select an arbitrary URL would turn candidate content into network authority and create an SSRF boundary.
Sending directly to a third-party notification service would add credentials, cost, availability risk, and provider-specific semantics to the judging path.

## Decision

The canonical no-cost Runtime recording will keep the atomic local consumer.
The managed live ModelArk profile will instead map the logical `demo-console` destination to one trusted loopback HTTP endpoint selected by the control plane.
The Agent Runtime receives only the candidate-owned outbox path and never receives the receiver URL or receiver credentials.

Airlock will POST each validated intent only after Canonical State advances.
The request will carry the stable Run-scoped idempotency key in both the bounded request body and the `Idempotency-Key` header.
The receiver will recompute the payload and idempotency commitments, atomically persist one bounded receipt, and return the same receipt for an exact replay.
An idempotency-key conflict or contradictory receipt will fail closed.

The control plane will persist only bounded receipt evidence and will retry the same key during Promotion recovery.
The one-command live proof will refuse success unless the active system profile declares receiver-enforced HTTP delivery and `/api/effects` returns the exact matching HTTP receipt for the promoted Run.

## Consequences

The live proof now exercises a real HTTP side effect without giving the untrusted Agent authority to choose a network destination.
An interruption after receiver acceptance but before local journal advancement converges by replaying the same key and receiving the original receipt.
The receiver stores no message body, provider credential, model identifier, or endpoint identifier.

The guarantee is at-least-once HTTP transport to an idempotent consumer with one accepted effect identity.
Agent Airlock does not claim distributed exactly-once delivery for arbitrary third-party services.
The loopback receiver proves protocol behavior and retry semantics, but it is not evidence that an email, Slack message, or public webhook was sent.

Provider-backed inference and HTTP effect delivery remain an optional conformance encore.
The canonical Track 1 recording stays offline, deterministic, and free.

## Rejected alternatives

### Replace the canonical mock consumer

Rejected because it would add a network dependency to the strongest reproducible safety proof.

### Let the Agent specify the webhook URL

Rejected because candidate data must not grant network authority or choose trusted infrastructure.

### Call a third-party notification provider

Rejected because credentials and provider availability add no value to the transactional middleware guarantee.

### Publish the effect on a public blockchain

Rejected because chain publication is unnecessary for Track 1, adds cost and latency, and cannot authorize Promotion.

