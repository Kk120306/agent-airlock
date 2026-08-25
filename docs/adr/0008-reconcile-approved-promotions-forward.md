# ADR 0008: Reconcile approved Promotions forward

## Status

Accepted for Phase 6.

## Context

Promotion crosses four persistence boundaries: the Candidate directory, the immutable version directory, `canonical.json`, and the supported external-effect store.
A process interruption between those writes can leave physical state ahead of control-plane metadata.
Rolling Canonical State backward after an approved decision would create another partial transaction and could contradict an effect that already happened.
The recovery mechanism must also avoid persisting arbitrary Runtime output or credentials in a second database.

## Decision

Airlock records an approved promotion decision in one platform-owned journal file under `APP_DATA_DIR/promotion-journal` before moving Candidate State.
The Runtime cannot mount or write this directory.
Each per-Run record advances atomically and monotonically through `validated`, `version-installed`, `canonical-advanced`, `effects-delivered`, and `completed`.

The journal stores stable identifiers, the exact source fingerprints, the planned target state, bounded redacted transaction evidence, the returned thread identifier, and token usage.
It deliberately replaces the original Runtime response with a neutral recovery message instead of duplicating arbitrary generated content.

Recovery runs before generic active-Run cleanup at server startup.
It treats the journal as the durable approved decision, the immutable version as installed physical state, `canonical.json` as accepted reality, and the atomic mock-delivery store as supported effect truth.
When those sources agree, recovery completes the decision forward and reconstructs the Run, Agent reference, assistant message, Promotion Receipt, and effect status idempotently.
When they contradict, recovery changes neither the canonical manifest nor external effects and places the Run Transaction and Agent in an explicit `recovery-error` state.

Interrupted Runs without an approved journal are not promoted.
A structurally valid Candidate is moved into Quarantine, while a Run with no Candidate is cancelled.

Candidate and Quarantine cleanup uses positive configured retention windows, fixed platform-owned roots, safe Run identifiers, and an explicit protected-Run set.
Cleanup never traverses symbolic links and never targets immutable canonical version directories.
When mutable Quarantine expires, its bounded control-plane evidence remains with a `discarded` disposition.

## Consequences

An approved Promotion converges to one target canonical version and at most one supported mock effect after any tested process interruption.
Repeated startup reconciliation and repeated phase acknowledgement are safe.
Airlock never infers success from JSON metadata when physical fingerprints disagree.
Airlock does not claim power-loss durability, multi-process coordination, distributed exactly-once delivery, or rollback of arbitrary third-party effects.
Configuration-only Agent updates reuse the physical promotion primitives but do not create Agent Run recovery journals.
