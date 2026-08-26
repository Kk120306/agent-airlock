# Adaptive Assurance architecture

## Purpose

Phase 10 converts repeated bounded failure evidence into explainable Outcome Contract proposals while keeping every policy change explicit, simulated, versioned, and reversible by an operator.

ADR 0012 is proposed and this document is an implementation-ready design, not yet accepted behavior.

## Authority flow

```mermaid
flowchart LR
    E[Retained Run evidence] --> D[Deterministic pattern detector]
    C[Trusted rule catalogs] --> D
    D --> P[Draft Assurance Proposal]
    P --> S[Historical simulator]
    S --> R[Ready proposal with exact, conservative, and unknown results]
    R --> O{Operator decision}
    O -->|Reject| X[Retained rejection]
    O -->|Accept| V[Fresh monotonic validation]
    V --> N[New Outcome Contract version]
    N --> F[Future Runs only]
```

No arrow leads directly from detection or simulation to the active Outcome Contract.
The proposal worker has write authority only over proposal records.
The operator acceptance handler is the only path that may create a new contract version from a proposal.

## Durable proposal model

An Assurance Proposal contains:

- Schema version, proposal identifier, Agent identifier, and lifecycle state.
- Exact base Outcome Contract version, canonical encoding hash, and creation timestamp.
- Generator identifier and version.
- Sorted monotonic operation list with catalog references where required.
- Sorted citations with Run identifier, disposition, evidence selector, evidence hash, and derivation rule.
- Simulation engine identifier and version.
- Complete ordered historical impact results and simulation digest.
- Stable proposal digest over every field that can affect meaning.
- Operator decision, bounded reason, decision timestamp, and resulting contract version when accepted.

Proposal states are `draft`, `ready`, `accepted`, `rejected`, `superseded`, and `stale`.
Only `ready` may be accepted or rejected.
A current-contract mismatch changes `ready` to `stale` and requires a new derivation instead of mutation.

## Detection rules

The initial deterministic detector uses only persisted fields and closed rule identifiers.
It never scans raw prompts, Runtime output, environment values, arbitrary logs, expired Candidate files, or provider-private metadata.

| Evidence pattern | Minimum support | Proposed operation |
| --- | --- | --- |
| Same required path missing in at least three Runs | Three distinct Run Transactions | Add required path from retained safe path evidence. |
| Same protected path changed in at least three Runs | Three distinct Run Transactions | Add protected path. |
| Repeated changed-file overflow with successful work below a lower percentile | Five compatible Runs | Lower `maxChangedFiles` to a supported integer bound. |
| Repeated added-byte overflow with successful work below a lower percentile | Five compatible Runs | Lower `maxAddedBytes` to a supported integer bound. |
| Same catalog secret detector reports a leak in at least two Runs | Two distinct Run Transactions | Add that exact catalog secret pattern. |
| Same optional Validation fails in at least three otherwise eligible Runs | Three distinct Run Transactions | Make that unchanged command required. |
| Same trusted catalog Validation would cover at least three cited failures | Three distinct Run Transactions | Add that exact required catalog Validation. |

Support counts use unique Run Transaction identifiers and exact evidence hashes so duplicated records cannot inflate confidence.
A repair lineage contributes at most one support unit per root lineage for the same pattern.
The generator bounds proposals per Agent, operations per proposal, citations per operation, path length, explanation length, and total serialized bytes.

## Monotonic-strengthening relation

Given base contract `B` and proposed contract `P`, acceptance requires all of these conditions:

- Every required path in `B` appears unchanged in `P`.
- Every protected path in `B` appears unchanged in `P`.
- `P.maxChangedFiles` is less than or equal to `B.maxChangedFiles`.
- `P.maxAddedBytes` is less than or equal to `B.maxAddedBytes`.
- Every secret rule in `B` appears with the same name and pattern in `P`.
- Every Validation command in `B` appears with the same name, command, and timeout in `P`.
- A required command in `B` remains required in `P`.
- Every added secret rule or command exactly matches its trusted catalog entry and catalog version.
- At least one field is strictly stronger.

The comparison is structural and does not rely on names such as `strict` or `secure`.
Catalog evolution creates new immutable catalog versions and cannot change a proposal already in `ready` state.

## Historical simulation

The simulator evaluates each retained Run against each proposed operation independently and then combines only compatible exact results.

| Operation | Exact when | Otherwise |
| --- | --- | --- |
| Add protected path | Complete change evidence proves whether that path changed. | `unknown` when paths were truncated or absent. |
| Add required path | A matching historical required-path Validation result exists under the same semantics. | `unknown` because change evidence does not prove final existence. |
| Lower changed-file limit | `totalChangedFiles` is retained under the same counting semantics. | `unknown` on incompatible schema. |
| Lower added-byte limit | `totalAddedBytes` is retained and not truncated under the same semantics. | `unknown` when byte evidence is incomplete. |
| Add catalog secret pattern | A matching detector result and detector version are retained. | `unknown` because redacted evidence cannot be rescanned. |
| Make existing command required | That exact command name, command hash, timeout, and result are retained. | `unknown` when command semantics differ. |
| Add catalog command | An identical catalog evaluator result is already retained. | `unknown` because commands are never rerun during simulation. |

The simulator does not reopen a workspace, rerun a command, recover a secret, or infer a file from an unrelated summary.
Each Run result records its evidence classification, prior disposition, counterfactual disposition when exact, named missing inputs, and result hash.

## Acceptance transaction

Acceptance uses optimistic concurrency:

1. Load the `ready` proposal and current Agent contract inside one store mutation boundary.
2. Verify proposal and simulation digests from canonical fields.
3. Require the current contract version and hash to equal the proposal base.
4. Resolve every catalog reference to the exact snapshotted catalog version.
5. Apply operations to a copy and re-run ordinary Outcome Contract validation.
6. Prove the structural monotonic relation.
7. Create the next immutable contract version through the existing contract update path.
8. Mark the proposal `accepted` with the resulting version and decision evidence.

An interruption before the store mutation leaves both proposal and contract unchanged.
The atomic JSON store mutation updates both records together in the current POC.
A later database backend must preserve the same transaction boundary.

## Rollback

Rollback selects a historical Outcome Contract version and creates a new version with the same rule content and new provenance fields.
The UI must show which protections are removed or limits raised compared with current policy and require explicit confirmation.
Rollback cannot delete or relabel the proposal, the accepted version, or any Run that used it.

## API and interface

The initial HTTP boundary is:

```text
GET  /api/agents/:agentId/assurance-proposals
POST /api/agents/:agentId/assurance-proposals/derive
POST /api/assurance-proposals/:proposalId/accept
POST /api/assurance-proposals/:proposalId/reject
POST /api/agents/:agentId/outcome-contract/rollback
```

The Playground Assurance inbox shows the proposed contract diff, exact base version, motivating Runs, support counts, simulator classifications, counterfactual dispositions, unknown inputs, authority boundary, and decision history.
It never shows raw secret matches, unredacted Validation output, expired Candidate files, or arbitrary command output.

## Required acceptance matrix

- Identical evidence sets produce the same proposal identifier, operation order, citation order, and digest.
- Duplicate Runs, duplicate citations, and repair siblings cannot inflate support.
- A generated operation that removes a rule, raises a limit, changes a command, or makes a command optional is rejected.
- Arbitrary command strings and regular expressions cannot enter a generated proposal.
- Truncated path, byte, secret, or command evidence becomes `unknown` rather than a counterfactual pass or failure.
- A stale base contract cannot be accepted or silently rebased.
- Proposal acceptance has no effect on a Run already admitted under an older contract snapshot.
- Proposal acceptance affects the next Run through an ordinary new contract version.
- Rejection changes no contract field and survives restart.
- Rollback creates a later version and changes no historical contract or receipt.
- Tampering with an operation, citation, simulation result, catalog version, or digest fails before acceptance.
- Proposal and simulation evidence remains credential-free and within every count and byte bound.
- All proofs run with deterministic local evidence and no paid inference or external service.

