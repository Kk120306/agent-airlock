# ADR 0019: Resume pending federated admissions with append-only local decisions

## Status

Accepted and implemented for receiver-owned federated approval and denial.

## Context

ADR 0018 requires an import to remain outside Candidate State when its matched producer rule requires local approval.
The resulting Federated Admission Record is immutable and must retain the exact policy generation, machine evaluation, receiver evidence, and `approval-required` result.
Mutating that record from pending to admitted would erase what the receiver knew when it first evaluated the transfer.
Re-evaluating the transfer after approval would let a newer policy generation silently change the meaning of the operator's decision.
Keeping only an in-memory approval flag would make Candidate creation ambiguous after interruption.

## Decision

Define a **Federated Approval Decision** as a separate immutable receiver-controlled record bound to one pending Federated Admission Record.
The record commits the exact pending Admission digest, import identity, local Agent, receiver-derived operator identity, approve or deny choice, bounded operator reason, decision time, and its own digest.
The first valid decision is authoritative for that pending Admission.
An exact retry returns the existing decision, while a contradictory choice, operator identity, or reason fails closed.

The receiver persists the verified Federated Work Bundle in a bounded immutable staging area before it exposes the pending Admission as resumable.
The staged bundle is public verification material and may not contain credentials, environment values, or provider-private content.
Approval recovery verifies the staged bundle again and requires its receipt and artifact commitments to match the immutable pending Admission.

Approval uses a separate monotonic recovery plan.
An approved plan derives exactly one Candidate Run identity from the pending Admission and Approval Decision digests, prepares exactly one isolated Candidate State, and then completes.
A denied plan never receives a Candidate Run identity and completes after publishing the immutable denial.
Startup and exact retry resume any interrupted approved plan without creating a second Candidate.

The original Federated Admission Record remains pending forever as historical machine-evaluation evidence.
The Federated Approval Decision grants only authority to resume Candidate preparation.
The receiver still runs its own Outcome Contract and retains sole Promotion Authority.

Promotion recovery uses a distinct federated-approval authority that commits both the pending Admission Record digest and the Federated Approval Decision digest.
A pending Admission Record by itself can never authorize Promotion recovery.

The HTTP decision endpoint is a trusted backend boundary.
It derives the operator identity from receiver configuration or authenticated control-plane context rather than accepting an identity claimed by the request body.
The request carries only the approve or deny choice and a bounded human reason.

## Consequences

The receiver can pause sensitive imports for human judgment without weakening immutable admission evidence.
Approval and denial remain inspectable after policy rotation, restart, and exact retry.
No producer signature, trust policy, transparency proof, or blockchain anchor can supply local approval.
The receiver must retain bounded staged bundles and append-only decision evidence until its evidence-retention policy removes the complete closed record set.

## Alternatives rejected

### Rewrite the pending Admission Record

This destroys the original machine decision and makes historical verification dependent on mutable state.

### Re-submit the import with `localApprovalGranted`

This changes receiver evidence for an already consumed transfer identity and allows policy drift to reinterpret the transfer.

### Create Candidate State before approval

This contradicts the explicit pending-outside-Candidate boundary and expands the attack surface before operator authority exists.

### Accept an operator identifier from the producer or browser body

An untrusted caller could forge the actor identity recorded in receiver evidence.
