---
status: accepted
---

# Use bounded, versioned Outcome Contracts

## Context

Agent Airlock needs a stable definition of an acceptable result before it can promote Candidate State.
A general policy language would add ambiguous evaluation semantics, unsafe extensibility, and a much larger trusted surface than the qualifying proof requires.
The contract must also preserve historical truth when an operator changes the rules for later Runs.

## Decision

Each Agent owns an immutable sequence of Outcome Contract versions using schema version 1.
Every Run Transaction snapshots the complete active contract when the Run is admitted.
Updating an Agent's contract increments its version and affects future Runs only.

Schema version 1 contains only these bounded fields:

- Required path patterns.
- Protected path patterns.
- A maximum changed-file count.
- A maximum added-byte count.
- Named secret regular expressions.
- Named validation commands with required or optional severity and a timeout.

The default contract requires `AGENTS.md` and `README.md`, protects `AGENTS.md`, permits at most 200 changed files, permits at most 2 MiB of candidate payload across added or modified files, and scans for Ark key assignments and bearer tokens.
Default contracts do not execute project commands until the operator explicitly configures them.
Every structural Validation is required.
A failed or errored required Validation quarantines Candidate State.
A failed optional command remains visible as evidence but does not prevent Promotion.

## Alternatives considered

### A general policy language

This was rejected because arbitrary policy code would need its own parser, sandbox, compatibility model, and debugging experience.
The POC needs a small falsifiable acceptance contract, not another programming language.

### Mutable rules referenced by identifier

This was rejected because evaluating an older Run against a newer rule set would rewrite the meaning of its decision.

### Required commands only

This was rejected because useful advisory checks should be visible without forcing every warning to block Promotion.

## Consequences

The decision for a historical Run remains reproducible from its stored contract snapshot and evidence.
The version 1 schema is intentionally less expressive than enterprise policy systems.
Changing schema semantics requires a new schema version rather than silently changing existing evaluations.
Regular expressions are operator-controlled configuration and are evaluated only against changed files up to the documented scan limit.
