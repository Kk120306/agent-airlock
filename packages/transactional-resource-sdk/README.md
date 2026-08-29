# Agent Airlock Transactional Resource SDK

This package defines the provider-neutral lifecycle used to bring a mutable resource under Agent Airlock.
It contains JSON-safe public types, strict Capability Claim validation, fixed fail-closed lifecycle semantics, and a framework-neutral executable conformance suite.

The SDK does not grant a Resource Provider authority over Run Transaction ordering, canonical path resolution, journal persistence, evidence bounds, or required-Validation policy.
Those responsibilities remain in the trusted Agent Airlock core.

## Lifecycle

A Resource Provider implements preparation, description, Validation, Promotion planning, idempotent Promotion, Quarantine, Discard, and reconciliation.
All persisted handles, plans, references, and evidence must be bounded, serializable, and credential-free.

## Capability Claims

A Capability Claim states only guarantees the provider can prove.
Only providers with `canonical-manifest` visibility, run-keyed idempotent Promotion, forward reconciliation, retained Quarantine, idempotent Discard, and Repair fork support are eligible as required all-or-nothing resources.

The SDK deliberately represents unsupported distributed atomicity instead of hiding it behind a generic `transactional` label.

## Conformance

`runTransactionalResourceConformance` executes eight provider-neutral cases covering required capabilities, Candidate isolation, bounded evidence, idempotent Promotion, Quarantine and Discard, prepare replay with run-scoped cleanup, Repair fork semantics, and restart reconciliation.
The caller supplies a deterministic fixture so the same suite can verify local, container, or remote providers.

Build a provider package whose fixture module exports `createConformanceFixture`, then run:

```bash
agent-airlock-resource-conformance your-provider/conformance-fixture
```

The command writes a readable case report to standard error and the schema-versioned JSON report to standard output.
It exits with status 1 when a conformance case fails and status 2 when the fixture cannot be loaded or executed.

The stable Promotion key helper derives `airlock:v1:<sha256>` from the Run, provider, and resource identities.
A provider must use that key for every replay of the same Promotion plan and must reject a contradictory target.

The trusted composition root supplies the initial immutable version reference when it registers a provider.
The SDK does not allow a provider to discover, create, or silently substitute the Canonical reference.
Phase 8 treats every registered provider as required because mixed optional failure policies would make a single Run Transaction disposition ambiguous.
