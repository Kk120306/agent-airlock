# ADR 0012: Keep Adaptive Assurance monotonic and operator-controlled

## Status

Proposed for Phase 10 pending Wayfinder decision synchronization and all prior phase gates.

## Context

Airlock retains structured evidence explaining why Candidate States were promoted, quarantined, discarded, or failed recovery.
Repeated failures can reveal that an Agent's Outcome Contract should be stronger, but letting the system edit that contract automatically would move acceptance authority from the operator into an opaque feedback loop.

Historical Run evidence is intentionally bounded and redacted.
It may prove some counterfactual policy outcomes exactly, support only a conservative conclusion for others, or contain too little information to answer.
An assurance system that fills those gaps by guessing would rewrite historical meaning.

## Decision

Airlock introduces an `Assurance Proposal` as durable advice with no execution or policy authority.
Every proposal identifies one Agent, one exact base Outcome Contract version and hash, one generator version, a closed list of proposed operations, cited Run evidence, a historical simulation report, a stable proposal digest, and a lifecycle state.

Generated proposals may contain only these monotonic-strengthening operations:

- Add a required path.
- Add a protected path.
- Lower `maxChangedFiles` to a positive bound.
- Lower `maxAddedBytes` to a non-negative bound.
- Add an exact secret pattern from a trusted control-plane rule catalog.
- Change an existing Validation command from optional to required without changing its command or timeout.
- Add an exact required Validation command from a trusted control-plane validation catalog.

A generated proposal cannot remove a rule, raise a resource limit, change a command string, make a required command optional, introduce an arbitrary regular expression, mutate a historical contract, or apply itself.

Proposal derivation is deterministic from a bounded ordered evidence set.
Every cited fact names its Run Transaction, evidence location, evidence hash, and the derivation rule that used it.
Equivalent proposals for the same Agent, base contract, operation set, evidence set, and generator version share one digest and are deduplicated.

Historical simulation classifies every compatible Run result as `exact`, `conservative`, or `unknown`.
`Exact` means retained evidence is sufficient to reproduce the proposed rule's result.
`Conservative` means retained evidence proves the proposed rule could not make the historical disposition less strict but cannot reproduce the complete Validation.
`Unknown` means required inputs were not retained, were truncated, or were produced under incompatible semantics.
Unknown never counts as a rejection, pass, benefit, or avoided incident.

Only an explicit authenticated operator action may accept or reject a proposal.
Acceptance revalidates the proposal digest, exact base contract hash, trusted catalog entries, monotonic relation, and complete simulation digest before creating an ordinary next Outcome Contract version.
A stale proposal must be regenerated and cannot be silently rebased.
Rejection retains the proposal, decision timestamp, and bounded operator reason without changing the contract.

Rollback is an explicit operator action that creates another normal immutable Outcome Contract version from a selected historical version.
Rollback may weaken the current contract because that authority belongs to the operator, but it is never generated or applied automatically and it never changes prior Run evidence.

## Consequences

Airlock can learn from repeated evidence while preserving a visible separation between recommendation, simulation, approval, and enforcement.
The proposal generator remains intentionally less expressive than the Outcome Contract editor.
Some useful suggestions will remain unknown or require direct operator configuration because bounded historical evidence is more important than artificial confidence.

The store requires append-only proposal and decision records, generator and simulator versioning, trusted rule catalogs, optimistic concurrency at acceptance, and migrations.
Promotion behavior remains unchanged until an accepted proposal creates a new Outcome Contract version for future Runs.

## Alternatives rejected

### Apply high-confidence proposals automatically

Confidence is not authority, and a false positive could block future work without an accountable decision.

### Generate arbitrary commands and regular expressions

That would create command-injection and regular-expression denial-of-service risk inside the trusted Validation boundary.

### Replay historical Candidate files

Retained mutable state may have expired, secrets must remain redacted, and replaying arbitrary old code would be expensive and unsafe.

### Treat missing evidence as a pass or failure

Either choice would invent historical facts and produce misleading impact claims.

### Rewrite the current contract during rollback

An immutable new version preserves which rules governed every historical Run.

