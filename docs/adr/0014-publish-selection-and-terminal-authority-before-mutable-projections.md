# ADR 0014: Publish Selection and terminal authority before mutable projections

## Status

Accepted locally after remediation of the independent Phase 11 architecture, code, and security review findings.
Wayfinder ratification is tracked by [Ratify the Phase 8 through 11 trust boundaries](https://github.com/Kk120306/agent-airlock/issues/11).

## Context

A Candidate Run can reach a terminal disposition before its Candidate Set has a Selection Decision.
The terminal Run Transaction is already final at that point, but its final Candidate Set context does not exist yet.
Writing only a context-free Run authority makes a later portable receipt unable to prove the Selection Decision that classified the Run as winner or loser.

The Candidate Set Selection Decision and each terminal Run projection are stored in mutable control-plane data.
A process can stop after immutable authority publication but before either mutable projection is committed.
Recovery that recomputes or synthesizes a different terminal state in that window creates contradictory histories even when Canonical State remains safe.

The optional local transparency log also needs cross-process serialization.
A singleton lock pathname with stale-owner deletion has an identity race because a delayed reclaimer can unlink a new owner's lock after checking the previous owner.

## Decision

Airlock publishes a separate immutable Candidate Set Decision Authority record before persisting mutable Selection fields.
The record commits the exact shared source, Outcome Contract, Selection Contract, loser policy, bounded competitor evidence, Selection Decision, selected competitor, winner Run, and decision timestamp.
Only one immutable Selection authority record may exist for a Candidate Set.

After Selection authority exists, Airlock publishes a final Candidate Set-bound authority for every already-terminal competitor before exposing the mutable Selection projection.
A Run may therefore have both an earlier context-free authority and a later Candidate Set-bound authority for the same terminal transaction.
Authorities for the same Run must retain one exact parent authority digest and at most one non-null Candidate Set authority digest across every transaction hash.
An available Quarantine may later gain one authoritative Discard transaction before any provider or local physical removal begins.
An interrupted completed Promotion may later gain one recovery authority after the completed Promotion journal is verified.
The recovery authority changes `recoveredAfterRestart` from `false` to `true` and may append exactly one successful `reconcile` event for each provider already committed in the promoted transaction.
The earlier provider-event prefix and every other transaction field remain exact.
These are the only accepted transitions between different terminal transaction hashes for one Run.
The Discard transaction must preserve the immutable Run core and exact event prefixes, append one Discard event, and retain provider recovery handles.
Legacy Discard authorities may contain one exact successful Discard event per known provider, but new cleanup executes from the already-published Discard authority and does not rewrite that decision with mutable completion claims.
After every required provider confirms evidence-preserving Discard, Airlock publishes one immutable cleanup completion fact bound to the exact Discard authority before removing the local recovery root.
Any other conflicting history is ambiguous and fails closed.

Provider cleanup begins only after immutable Discard authority exists.
Startup retries provider and local cleanup from that exact Discard authority and never synthesizes Discard after local state disappears.
If the local recovery root is missing, startup accepts provider cleanup only when the exact authority-bound cleanup completion fact exists and passes complete provider coverage validation.
If Discard authority exists while local Candidate or Quarantine state remains, startup completes that authorized cleanup and atomically replays the Run plus Candidate competitor lifecycle.
A selected winner that fails before Promotion remains the historical Selection winner, while its terminal Quarantine or Discard authority controls only retained state and competitor cleanup lifecycle.

If startup finds Selection authority without the mutable Selection projection, it restores the exact authorized Selection rather than recomputing a new decision.
Startup audits terminal authority for every Run, including Runs that already look terminal in mutable storage.
If the newest valid authority is ahead of the mutable Run or Candidate Set competitor, startup verifies stable Run identity, source, contract, lineage, Selection authority, and physical Candidate disposition, then replays the exact terminal transaction and competitor lifecycle together.
Missing or contradictory evidence produces `recovery-error` and never a synthesized cancellation.

Terminal Run status and its competitor lifecycle projection are one child-level publication boundary.
The final child transaction plus competitor lifecycle are committed in one control-plane mutation after immutable authority exists and physical cleanup succeeds.
If authority publication fails, no provider or local physical removal begins.
If cleanup fails after publication, the retained local root and immutable Discard authority make idempotent roll-forward retryable.
If the root disappears before provider cleanup completes, the missing cleanup completion fact keeps recovery, Agent execution, and provider onboarding closed.
The Agent remains `busy` until the complete Candidate Set reaches a safe aggregate terminal state because selection, winner Promotion, and loser cleanup are still part of the same Agent operation.
Terminal authority recovery failure leaves the Agent and Resource Registry admission closed.

The local transparency log uses an append-only queue of immutable lock turns.
Every contender publishes one numbered turn directory, waits for every lower turn to contain one validated completion marker, and may mark a dead stale predecessor as abandoned.
Each completion marker is fully written and synchronized off-path, then atomically published with a non-overwriting hard link.
No contender unlinks or reuses a successor's lock pathname.
The older singleton lock format is handled only as a compatibility barrier inside the acquired queue turn and before the log operation begins.

## Consequences

Mutable Candidate Set and Run projections can be repaired from independent immutable authority after a process interruption.
Portable receipts can bind promoted, retained, discarded, and cancelled Candidate Runs to the final Selection Decision.
Direct export uses the latest valid authority, while an ancestry edge continues to reference the exact historical parent authority digest captured when the child was decided.
Receipt export remains unavailable while any Candidate disposition is unresolved.

The append-only authority and lock histories consume bounded local storage.
The proof-of-concept enforces explicit record and turn limits and fails closed when either boundary is reached.

The Candidate Set Decision Authority does not authorize physical Promotion by itself.
Winner Promotion still requires the deterministic Selection replay, selected seal, exact source, and matching Promotion-journal authority defined by ADR 0011.
The transparency queue serializes a local optional anchor but does not make that anchor globally observed or trusted.

## Alternatives rejected

### Recompute Selection after restart

Recomputation cannot distinguish a legitimate missing projection from coordinated mutable evidence changes after an authority decision.

### Rewrite the first Run authority with final Candidate Set context

Replacing authority would destroy the evidence that the terminal transaction existed before Selection and would make interruption recovery depend on mutable timing.

### Keep one removable stale-lock pathname

Nonce checks do not make a separate pathname unlink atomic with ownership validation, so a delayed reclaimer can still delete a successor's lock.

### Hold the Agent-level status update until every child terminal decision

That would hide useful completed child evidence and still would not make the filesystem journal and JSON aggregate one atomic storage transaction.
