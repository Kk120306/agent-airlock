# Agent Airlock Product Requirements Document

**Status:** Wayfinding draft

**Product:** Agent Airlock middleware for the CodeJam starter kit

**Primary user:** A developer or operator running coding Agents through the existing Playground

## Product summary

Agent Airlock gives every Agent Run a safe place to attempt work without immediately changing accepted platform state.
The Run executes against isolated Candidate State, produces an explainable change set, and becomes Canonical State only after its Outcome Contract passes.

The product promise is simple:

> Agents may explore many futures, but only validated futures become reality.

## Problem

The starter kit creates a disposable Runtime container for each local turn but bind-mounts the persistent Agent workspace and shared Codex state into that container.
The container disappears after execution, while destructive or incomplete state changes remain.

Operators currently cannot answer these questions before accepting a Run:

- What did the Agent change?
- Does the resulting project still satisfy its required invariants?
- Did the Agent modify a protected resource?
- Can a failed Run be inspected without corrupting the accepted workspace?
- Can rejected work be repaired without starting again from nothing?
- Can irreversible external actions wait until the complete outcome is accepted?

## Goals

1. Prevent unvalidated Agent work from mutating Canonical State.
2. Evaluate outcomes rather than attempting to predict every command an Agent might execute.
3. Make promotion, quarantine, discard, and repair understandable from the existing Playground.
4. Preserve the starter kit's Agent lifecycle, Codex continuity, and local Runtime path.
5. Provide evidence that rejected Runs leave protected state unchanged.
6. Demonstrate that the transactional model can extend beyond files through a SQLite Transactional Resource and an External Action Intent outbox.

## Non-goals

- Production-grade multi-tenant isolation.
- General container orchestration.
- Production OAuth or enterprise identity management.
- Transparent transactions for arbitrary third-party APIs.
- Kernel-level filesystem virtualization.
- Distributed transactions across unrelated external providers.
- BytePlus ECS deployment as a judging requirement.
- Blockchain integration.

## Core user journey

1. The operator creates or selects an Agent through the starter UI.
2. The operator reviews or accepts the Agent's Outcome Contract.
3. The operator sends a normal coding task through the Playground.
4. Airlock prepares Candidate State and runs Codex against it.
5. Airlock shows the resulting file, database, and deferred-action changes.
6. Airlock executes every required Validation.
7. Airlock promotes the Candidate State automatically when the Outcome Contract passes.
8. Airlock quarantines the Candidate State when any required Validation fails.
9. The operator can inspect evidence, discard the Quarantine, or start a Repair Run from it.

## Functional requirements

### Run Transaction lifecycle

- Every new Run must receive a stable Run Transaction identifier.
- Airlock must prepare Candidate State before invoking the underlying AgentRunner.
- The underlying Runtime must receive only Candidate State paths.
- Airlock must record preparation, execution, validation, and disposition timestamps.
- A Run Transaction must end in exactly one of `promoted`, `quarantined`, `discarded`, or `cancelled`.
- Failed, cancelled, timed-out, and rejected Runs must not change Canonical State.
- Server startup must reconcile any Run Transaction interrupted during preparation, validation, or promotion.

### Outcome Contracts

- Each Agent must have a versioned Outcome Contract.
- The first version must support protected path patterns, required path patterns, validation commands, maximum changed files, maximum added bytes, and secret-pattern scanning.
- Every Validation must have a stable name, status, duration, and safely bounded output.
- Validation commands must execute inside a constrained container against Candidate State.
- Outcome Contract changes must affect future Run Transactions only.
- Promotion must require all validations marked as required to pass.

### Workspace and session isolation

- The Agent workspace must be represented as a versioned Transactional Resource.
- The Codex session used by a Run Transaction must be isolated with the Candidate State.
- A quarantined Run must not advance the Canonical State's Codex thread.
- A promoted Run must advance both the workspace and session together from the operator's perspective.
- Future Runs must resolve their starting state from the current Canonical State rather than from mutable global paths.

### Additional Transactional Resources

- The demonstration project must include a SQLite Transactional Resource stored within Candidate State.
- A rejected database mutation must leave the canonical SQLite contents unchanged.
- The demonstration project must accept typed External Action Intents through a platform-controlled interface.
- External Action Intents must remain deferred until promotion.
- Every External Action Intent must carry a stable idempotency key derived from the Run Transaction and intent identity.
- The POC must disclose that Agent-controlled network egress can bypass the outbox unless egress is restricted.

### Promotion and quarantine

- Promotion must use a durable state record that identifies every promoted resource version.
- Promotion must be idempotent and safe to reconcile after interruption.
- Quarantine must preserve the Candidate State, Validation evidence, and Agent response.
- Discard must remove quarantined mutable state while retaining the bounded Promotion Receipt and Validation evidence.
- A Repair Run must start from Quarantine and must not alter Canonical State unless the repaired candidate passes.

### Operator experience

- The existing Playground must remain the primary task-entry surface.
- The active Run must show preparation, execution, validation, and disposition as a compact timeline.
- A promoted Run must show an outcome summary and resulting state version.
- A quarantined Run must identify the failed Validation and show the protected Canonical State as unchanged.
- The operator must be able to inspect a bounded file-change summary and Validation output.
- The operator must be able to discard Quarantine or request a Repair Run.
- The interface must not display credentials, environment values, or unredacted sensitive content.

## Reliability requirements

- Promotion processing must be idempotent.
- Duplicate delivery of an External Action Intent must not duplicate its mock external effect.
- Validation output must respect the existing bounded-output philosophy.
- Candidate and Quarantine retention must be configurable.
- Cleanup must never delete the current Canonical State version.
- A corrupted Candidate State must fail closed and preserve Canonical State.
- Failure to establish the state of an interrupted promotion must place the Agent in an understandable recoverable error state.

## Security requirements

- Canonical State paths must not be writable from the Agent Runtime.
- Validation commands must not run directly on the host.
- Candidate State must not inherit unnecessary credentials.
- Sensitive values must be redacted before evidence is persisted or displayed.
- Path validation must prevent traversal outside the Candidate State root.
- Symlink handling must prevent Candidate State from reaching canonical or unrelated host paths.
- External actions outside the controlled outbox are a documented residual risk for the POC.

## Success metrics

- A successful Run promotes a valid workspace and the next Playground message continues from that promoted state.
- A destructive Run that deletes required files is quarantined and leaves the Canonical State content hash unchanged.
- A rejected SQLite mutation leaves canonical query results unchanged.
- A deferred mock external action executes once after promotion and zero times after rejection.
- A quarantined Run can be repaired and subsequently promoted without modifying the original Canonical State before promotion.
- The complete success, rejection, and recovery story fits in a three-minute live demonstration.
- `npm run check` passes.

## Release scope

### P0: Judging path

- Transactional workspace execution.
- Codex session isolation.
- Versioned Outcome Contract with required validators.
- Promotion, Quarantine, Discard, and Repair Run lifecycle.
- Playground evidence timeline and semantic change summary.
- SQLite Transactional Resource fixture.
- Mock External Action Intent outbox.
- Automated positive, rejection, recovery, restart, and bypass tests.

### P1: Hardening

- Retention and cleanup controls.
- Richer secret detection.
- Exportable Promotion Receipts.
- Operator-selected repair guidance.
- Stronger network-egress enforcement.

### P2: Extension ecosystem

- PostgreSQL branching adapter.
- Remote object-store adapter.
- Payment and communication outbox adapters.
- Provider-neutral Transactional Resource SDK.
- Cryptographic or blockchain anchoring of Promotion Receipts.

## Known limitations

- The POC supports one local control-plane process.
- Full atomicity across local state and arbitrary external providers is not claimed.
- The outbox only controls actions routed through the platform interface.
- Copy-based Candidate State preparation may be slower for very large workspaces.
- Codex session storage behavior must be validated against the pinned CLI version before its isolation design is finalized.

## Open Wayfinder decisions

- [Choose the Canonical State and Promotion model](https://github.com/Kk120306/agent-airlock/issues/2).
- [Prove safe Codex session isolation](https://github.com/Kk120306/agent-airlock/issues/3).
- [Freeze Outcome Contract semantics and defaults](https://github.com/Kk120306/agent-airlock/issues/4).
- [Choose Validation containment and evidence limits](https://github.com/Kk120306/agent-airlock/issues/5).
- [Define Promotion journal and crash recovery semantics](https://github.com/Kk120306/agent-airlock/issues/6).
- [Define External Action Intent delivery guarantees](https://github.com/Kk120306/agent-airlock/issues/7).
- [Design Quarantine and Repair Run experience](https://github.com/Kk120306/agent-airlock/issues/8).
- [Set the P0 scope cutoff and judging acceptance bar](https://github.com/Kk120306/agent-airlock/issues/9).

The [Wayfinder map](https://github.com/Kk120306/agent-airlock/issues/1) is the canonical index for these decisions.
