# Agent Airlock

Agent Airlock is transactional execution middleware that separates an Agent's speculative work from accepted platform state.
This glossary defines the language used across product documentation, code, tests, and issues.

## Language

**Run Transaction**:
One speculative Agent execution from preparation through promotion, quarantine, or discard.
_Avoid_: Job, attempt, sandbox run

**Canonical State**:
The accepted resource versions that future Runs and users observe.
_Avoid_: Live state, production state, real state

**Candidate State**:
The isolated resource versions mutated by one Run Transaction before a decision is made.
_Avoid_: Shadow state, duplicate state, temporary state

**Outcome Contract**:
The versioned set of post-conditions that Candidate State must satisfy before promotion.
_Avoid_: Policy file, command allowlist, safety rules

**Validation**:
One named evaluation of Candidate State against part of an Outcome Contract.
_Avoid_: Check, gate, test

**Promotion**:
The recoverable operation that makes validated Candidate State the new Canonical State.
_Avoid_: Commit, deploy, merge

**Quarantine**:
Preserved Candidate State that was not promoted and remains available for evidence or repair.
_Avoid_: Failure folder, rejected copy

**Discard**:
The deliberate removal of Candidate State after it is no longer needed.
_Avoid_: Rollback, delete run

**Repair Run**:
A Run Transaction that continues from Quarantine with validation evidence supplied as corrective context.
_Avoid_: Retry, rerun

**Transactional Resource**:
A mutable resource that Airlock can prepare as Candidate State and later promote or discard.
_Avoid_: Adapter, database copy, state handler

**External Action Intent**:
A validated description of an irreversible external operation that remains deferred until promotion.
_Avoid_: Tool call, queued action, side effect

**Promotion Receipt**:
The durable evidence connecting a Run Transaction, its Outcome Contract version, its Validation results, and the resulting Canonical State version.
_Avoid_: Log entry, audit row

