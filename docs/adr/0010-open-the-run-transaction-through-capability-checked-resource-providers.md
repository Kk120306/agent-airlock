# ADR 0010: Open the Run Transaction through capability-checked Resource Providers

## Status

Accepted for Phase 8.

## Context

Agent Airlock originally coordinated workspace, Codex session, SQLite, and External Action Intent state through resource-specific branches inside the trusted Run Transaction engine.
That proved the product guarantee, but adding a new remote resource required modifying the core lifecycle and its recovery code.

Remote systems cannot generally participate in the same atomic filesystem replacement as the Airlock canonical manifest.
A provider contract that simply claimed `transactional` behavior would hide important differences in isolation, Promotion visibility, idempotency, Quarantine, Discard, Repair, and reconciliation.
Letting providers choose Runtime mount paths or lifecycle ordering would also expand the trusted surface and could expose mutable Canonical State.

## Decision

Airlock defines a provider-neutral Transactional Resource SDK with schema-versioned JSON-safe lifecycle values and strict runtime validation.
A Resource Provider implements `prepare`, `describe`, `validate`, `planPromotion`, `promote`, `quarantine`, `discard`, and `reconcile` under fixed fail-closed semantics.
The trusted core owns provider ordering, exact provider-set checks, Candidate path derivation, Runtime environment names, evidence bounds, journal persistence, the final disposition, and canonical manifest acceptance.

Each provider publishes a machine-readable Capability Claim.
Phase 8 admits only required providers whose claims include isolated Candidate state, canonical-manifest Promotion visibility, run-keyed idempotency, retained Quarantine, idempotent Discard, Repair fork support, and forward reconciliation.
Optional providers are rejected because a provider-specific failure policy would make the whole Run Transaction outcome ambiguous.
Best-effort visibility and non-idempotent Promotion remain representable for inspection but are not eligible for required all-or-nothing composition.

Provider Promotion installs an immutable target version before Airlock advances the canonical manifest.
The provider reference becomes accepted only through that manifest.
Recovery verifies the installed version against the durable provider Promotion plan and exact fingerprint before advancing or reconstructing Canonical State.
The design does not claim a distributed atomic commit or atomic coordination of a provider-native mutable pointer.

The initial immutable version reference is supplied by trusted composition configuration and independently verified through provider reconciliation before onboarding.
Adding a provider to an existing deployment is an explicit Registry Transition, not an incidental canonical-manifest schema migration.
Airlock records the planned per-Agent transition before installing a new immutable Whole-Agent state, verifies the exact provider identity, version identifier, and fingerprint, and advances `canonical.json` only after the installed target matches the plan.
A persisted Resource Registry generation is committed only after every existing Agent has converged.
Restart either removes an unaccepted installed target and retries, or accepts an exact target already named by `canonical.json`.
Before either action can remove a target, Airlock strictly validates the Registry Transition journal's exact fields, deterministic identifiers, source and target fingerprints, additive provider vectors, and one exact verification per addition.
Provider registration is additive in Phase 8.
Removal, identity replacement, or Capability Claim replacement is rejected until a separate export-and-retire migration exists.
Providers do not bootstrap, discover, or silently replace Canonical references.
The first reference provider is a credential-free versioned HTTP JSON object package that depends only on the SDK.

## Consequences

A third-party provider can register at the composition root without changing `AirlockRunner` lifecycle branches.
Every registered provider participates in one required all-or-nothing Airlock disposition.
Provider failures before Runtime abort execution, Validation failures quarantine the complete Candidate State, Promotion contradictions fail recovery closed, and Discard evidence is persisted before mutable local state is removed.
Accepted provider Candidate, Quarantine, and Discard progress is persisted one provider at a time so a later provider failure cannot erase earlier recovery evidence.
Cancellation removes local mutable state only after every provider Discard succeeds.
When cleanup is unavailable, Airlock retains a cleanup-only composite Quarantine for retry.
An interrupted Promotion or retained Quarantine is recovered against its persisted historical provider vector rather than the latest expanded registry.
Airlock does not commit or begin an additive Registry Transition while any prior-generation Promotion recovery remains unresolved.

The public contract is deliberately narrower than a general plugin system.
Providers receive bounded lifecycle context rather than application services or arbitrary environment access.
The core derives Candidate-only bindings and never exposes a mutable Canonical path to the Runtime.

The SDK conformance suite verifies declared required guarantees through eight executable cases: required capabilities, Candidate isolation, bounded evidence, idempotent Promotion, Quarantine and Discard, prepare replay with Run-scoped cleanup, Repair fork isolation, and restart reconciliation.
Every lifecycle result is parsed by the same strict SDK validators used at core admission.
Passing the suite demonstrates those bounded cases, not security of an external service, availability of its network, or distributed serializability.
Every provider-controlled identifier, Runtime-relative path, summary, metadata value, lifecycle result, reconciliation result, and error is bounded and credential-checked before persistence or display.
Provider credentials, if a future provider needs them, must remain in the trusted control plane and outside persisted evidence, Runtime bindings, logs, and browser responses.

The core admits a provider only when the selected Runtime can implement its declared access mode.
The local-process Runtime cannot faithfully enforce read-only provider bindings, so it rejects that combination before execution.
After Runtime exits, Airlock rescans every provider root for symbolic links and re-resolves the declared binding before invoking trusted lifecycle hooks.
