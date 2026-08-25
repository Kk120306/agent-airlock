# ADR 0007: Repair quarantined futures through bounded lineage

## Status

Accepted for Phase 5.

## Context

Quarantine prevents a rejected Run from changing Canonical State, but a useful candidate may contain substantial work alongside a small contract violation.
Starting a normal Run from Canonical State throws that work away.
Promoting the rejected candidate would violate Airlock's central guarantee.
A safe repair path must preserve the rejected workspace and Agent memory without replaying rejected external actions or overwriting newer accepted work.

## Decision

A Repair Run is a new Run Transaction that forks one selected Quarantine.
It copies the quarantined workspace and Codex home into a fresh Candidate State and resumes the quarantined Codex thread.
It always receives a fresh empty outbox, so rejected External Action Intents must be intentionally resubmitted.

Airlock permits repair only while the current canonical state identifier and composite fingerprint exactly match the source values recorded by the quarantined parent.
This freshness check runs before scheduling and again at promotion through the existing canonical source check.

The Runtime also receives a disposable copy of the matching Canonical workspace as a repair reference.
The container provider mounts this reference read-only.
The local-process provider exposes only the disposable copy and a required Validation proves its content hash was not changed.
Airlock removes the reference before installing the repaired Candidate as an immutable version.
The real Canonical workspace is never mounted writable into the Runtime.

The repair prompt contains the original objective, bounded failed Validation evidence, and a narrow remediation instruction.
Lineage records `rootRunId`, `parentRunId`, `depth`, and `maxDepth` in the Run Transaction and Promotion Receipt.
The default maximum repair depth is two, and each parent may have only one repair child.

Discard is an idempotent terminal transition from `quarantined` to `discarded`.
It removes only the platform-resolved `.quarantine/<run-id>` mutable directory while retaining output, hashes, lineage, bounded Validation evidence, timeline events, and a refreshed receipt.
API callers never provide a filesystem path.

## Consequences

Useful rejected work and rejected Agent reasoning can become the input to a new constrained attempt without becoming accepted state first.
Rejected action intents cannot replay implicitly.
A stale Quarantine fails closed instead of overwriting a newer canonical future.
Bounded single-child lineage prevents unbounded autonomous repair loops and deliberately defers competing repair branches to Phase 9.

The original Quarantine remains independently inspectable after a repaired child promotes until an operator discards it or a later retention policy expires it.
The local-process reference is not protected by an operating-system read-only mount, but it is a disposable copy whose integrity is required for promotion.
Durable reconciliation of a crash during promotion remains Phase 6 scope.
