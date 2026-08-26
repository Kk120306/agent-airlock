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
An available Quarantine may later gain one authoritative Discard transaction after provider cleanup and physical removal complete.
An interrupted completed Promotion may later gain one recovery authority whose only transaction change is `recoveredAfterRestart` from `false` to `true` after the completed Promotion journal is verified.
These are the only accepted transitions between different terminal transaction hashes for one Run.
The Discard transaction must preserve the immutable Run core and exact event prefixes, append one Discard event, and retain or extend provider cleanup evidence.
Any other conflicting history is ambiguous and fails closed.

If startup finds Selection authority without the mutable Selection projection, it restores the exact authorized Selection rather than recomputing a new decision.
Startup audits terminal authority for every Run, including Runs that already look terminal in mutable storage.
If the newest valid authority is ahead of the mutable Run or Candidate Set competitor, startup verifies stable Run identity, source, contract, lineage, Selection authority, and physical Candidate disposition, then replays the exact terminal transaction and competitor lifecycle together.
Missing or contradictory evidence produces `recovery-error` and never a synthesized cancellation.

Terminal Run status and its competitor lifecycle projection are one child-level publication boundary.
Provider cleanup progress is persisted before local Candidate or Quarantine removal, and the final child transaction plus competitor lifecycle are committed in one control-plane mutation after immutable authority exists.
Intermediate Quarantine cleanup progress is not a new terminal decision and must preserve the authoritative Quarantine core, receipt, lifecycle events, and provider-event prefix.
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
