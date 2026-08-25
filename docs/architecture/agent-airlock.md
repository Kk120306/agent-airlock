# Agent Airlock architecture

## Architectural intent

Agent Airlock adds one transactional execution seam around the starter kit's existing `AgentRunner` contract.
The control plane continues to own Agent lifecycle and Run orchestration, while Airlock owns preparation, validation, promotion, quarantine, and recovery of mutable Agent state.

## Baseline observation

The existing `AgentService` passes the persistent workspace path and canonical Codex thread directly to `AgentRunner` in `apps/server/src/agent-service.ts:235`.
The local Runtime then bind-mounts that workspace and the shared Codex home as writable container paths in `apps/server/src/container-codex-runner.ts:38`.
Container disposal therefore contains the process but does not make its persistent state changes transactional.

## Implemented Phase 2 architecture

```mermaid
flowchart LR
    UI["Existing React Playground"] --> API["Existing Fastify API"]
    API --> AS["AgentService"]
    AS --> AR["AirlockRunner"]
    AR --> SR["Workspace State Registry"]
    SR --> CS["Candidate State"]
    AR --> RR["Existing AgentRunner"]
    RR --> RC["Disposable Runtime container"]
    RC --> CS
    AR --> VE["Outcome Validator"]
    VE --> VC["Constrained validation container"]
    VE --> CS
    AR --> PR["Promotion or Quarantine"]
    PR --> ST["Run evidence and Promotion Receipt"]
    ST --> UI
```

## Primary seam

`AirlockRunner` remains compatible with the existing `AgentRunner` interface from `apps/server/src/types.ts:78`.
It substitutes Candidate State paths before delegating to the existing local-process or container implementation.
The wrapper returns bounded execution output plus transactional evidence required by `AgentService`.

The target caller-facing shape is intentionally small:

```ts
interface AirlockRunner {
  run(request: AirlockRunRequest): Promise<AirlockRunResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
```

Preparation, workspace coordination, validators, and receipts remain inside the module.
Recovery journals, retention, and additional Transactional Resource adapters remain later-phase extension seams.

## State layout

ADR 0002 selects immutable state-version directories with an atomically replaced canonical manifest:

```text
workspaces/
├── <agent-id>/
│   ├── canonical.json
│   └── versions/<state-id>/workspace/
├── .candidates/<run-id>/
│   ├── candidate.json
│   └── workspace/
└── .quarantine/<run-id>/
    ├── candidate.json
    └── workspace/
```

`canonical.json` identifies the accepted resource versions.
A Candidate State is mutable only while its Run Transaction is active.
A promoted state version becomes immutable and may be used as the source for a later candidate.
Phase 1 verifies the manifest content hash whenever Canonical State is resolved.
Codex session state and additional resource versions join the canonical manifest in later phases.

## Run Transaction lifecycle

```mermaid
stateDiagram-v2
    [*] --> Preparing
    Preparing --> Executing: Candidate State ready
    Preparing --> Cancelled: preparation fails or is cancelled
    Executing --> Validating: AgentRunner completes
    Executing --> Quarantined: Runtime fails or times out
    Executing --> Cancelled: operator stops Run
    Validating --> Promoting: all required Validations pass
    Validating --> Quarantined: any required Validation fails
    Promoting --> Promoted: Canonical State advances
    Promoted --> [*]
    Quarantined --> [*]
    Cancelled --> [*]
```

Crash-journal reconciliation, explicit discard, and Repair Runs remain later roadmap phases.

## Outcome Contract evaluation

Validation proceeds in a deterministic order so evidence remains understandable:

1. Validate candidate path containment and symlink safety.
2. Calculate the bounded workspace and resource change set.
3. Reject changes to protected paths.
4. Confirm required paths and structural invariants.
5. Enforce change-count and added-byte limits.
6. Scan changed content for configured secret patterns.
7. Execute operator-defined validation commands in a constrained container.
All required Validations must pass before promotion begins.

Outcome Contract schema version 1 is a bounded data model rather than a policy language.
Its default requires `AGENTS.md` and `README.md`, protects `AGENTS.md`, limits a Run to 200 changed files and 2 MiB of candidate payload across added or modified files, scans for Ark key assignments and bearer tokens, and defines no command Validations until the operator adds them.
The complete contract is snapshotted into the Run Transaction, so a later contract update cannot change a historical decision.
Operator-defined commands run against disposable Candidate State copies in fresh containers with no network, no application credentials, a read-only root, dropped capabilities, and resource limits.
Command build artifacts are deleted with the validation copy and can never enter Promotion.

Candidate inventory is limited to 10,000 entries and persisted change evidence is limited to 200 paths.
Changed files larger than 1 MiB fail the secret scan.
Command output is terminated above 65,536 bytes, redacted, and persisted up to 16,384 bytes.
Command duration is bounded by the contract between 1 second and 300 seconds.

## Transactional Resource direction

The current release implements the workspace lifecycle directly.
The planned Transactional Resource seam will apply the same lifecycle to other mutable resources:

```ts
interface TransactionalResource {
  prepare(context: PrepareContext): Promise<CandidateResource>;
  describe(candidate: CandidateResource): Promise<ResourceChangeSet>;
  validate(candidate: CandidateResource, contract: ResourceContract): Promise<Validation[]>;
  finalize(candidate: CandidateResource): Promise<ResourceVersion>;
  discard(candidate: CandidateResource): Promise<void>;
}
```

Workspace is the only implemented Transactional Resource in Phase 2.
Codex Session, SQLite, and External Action Intent adapters remain later roadmap work.

## Planned External Action Intent outbox

The planned design requires the Agent to submit irreversible operations as typed intents through a platform-controlled interface.
An intent will be stored with Candidate State and validated before promotion.
After promotion, a dispatcher will execute the intent with a stable idempotency key and record delivery evidence.

The planned POC will provide at-least-once dispatch with idempotent mock consumers.
It will not claim to intercept arbitrary network traffic from the Agent Runtime.

## Persistence model

The version 3 JSON store remains the control-plane metadata source for Agents, messages, Runs, Outcome Contracts, and operator-visible evidence.
Immutable state versions and quarantined candidates live on disk outside the JSON document.
Phase 2 Promotion moves a candidate to an immutable version and atomically replaces `canonical.json`.
A durable promotion journal and startup reconciliation remain later work.

Schema evolution must increment the database version and include a tested migration path from the starter kit's version 1 data.

## Failure semantics

| Failure | Required result |
| --- | --- |
| Candidate preparation fails | Do not invoke the AgentRunner and leave Canonical State unchanged. |
| AgentRunner fails or times out | Quarantine bounded evidence and leave Canonical State unchanged. |
| Validation fails | Quarantine Candidate State and identify the failing Validation. |
| Evidence persistence fails before promotion | Fail closed without promotion. |

Interruption during Promotion does not yet have full journal-based reconciliation and is a documented Phase 2 limitation.

## Trust boundaries

- The Agent Runtime is untrusted and receives Candidate State only.
- Validation code from the candidate project is untrusted and runs from a disposable copy inside a constrained container.
- The Fastify control plane and Airlock state manager form the trusted POC boundary.
- The existing ordinary container remains a POC isolation mechanism rather than a hardened multi-tenant sandbox.
- The planned outbox will protect only external actions routed through its interface.

## Evidence model

Each Run Transaction records:

- Agent, Run, Candidate State, Canonical State, and Outcome Contract identifiers.
- Lifecycle timestamps and terminal disposition.
- Bounded resource change summaries.
- Validation names, statuses, durations, and redacted output.
- Resulting canonical version for promoted Runs.

Promotion journal position, external action delivery, and Repair Run ancestry join this model in later phases.

## Open architectural decisions

The [Wayfinder map](https://github.com/Kk120306/agent-airlock/issues/1) owns unresolved decisions about Codex session isolation, Promotion recovery, outbox delivery, the operator experience, and the judging cutoff.
Outcome Contract semantics and Validation containment are resolved by ADR 0003 and ADR 0004.
This document must be revised when those tickets close.
