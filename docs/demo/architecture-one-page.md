# Agent Airlock one-page architecture

## Falsifiable guarantee

An Agent Run may freely mutate its isolated workspace and reasoning, but it cannot change accepted workspace or memory unless every required Validation in the snapshotted Outcome Contract passes.

```mermaid
flowchart LR
    Operator["Operator"] --> UI["Starter-kit React Playground"]

    subgraph Trusted["Trusted control plane"]
        API["Fastify API and AgentService"]
        Airlock["Agent Airlock Run Transaction"]
        Contract["Versioned Outcome Contract snapshot"]
        Validate["Deterministic Validators"]
        Decision{"All required Validations pass?"}
        Manifest["Atomic canonical.json recovery point"]
        Receipt["Bounded and redacted Promotion Receipt"]
        API --> Airlock
        Contract --> Airlock
        Airlock --> Validate
        Validate --> Decision
        Decision -->|Yes| Manifest
        Decision -->|No| Receipt
        Manifest --> Receipt
    end

    UI --> API

    subgraph Untrusted["Untrusted execution"]
        Runtime["Starter-kit Codex Runtime"]
        Candidate["Run-owned workspace plus Codex home"]
        Check["Disposable validation copy in constrained container"]
        Ark["ModelArk Responses API"]
        Runtime <--> Candidate
        Runtime <--> Ark
        Candidate --> Check
    end

    Airlock -->|Candidate path only| Runtime
    Candidate --> Validate
    Check --> Validate

    subgraph Accepted["Accepted Whole-Agent state"]
        Versions["Immutable workspace and session versions"]
        Canonical["Canonical workspace plus Codex thread"]
        Versions --> Canonical
    end

    Manifest -->|Advance exactly once| Versions
    Canonical -->|Copy at Run start| Candidate
    Receipt --> UI
```

## One Run, one decision

1. Airlock resolves and verifies the current immutable Canonical State.
2. Airlock copies its workspace and Codex home into Run-owned Candidate State and gives only those paths to the existing Runtime.
3. The Agent uses Codex and ModelArk normally and may change files, tools, and reasoning inside Candidate State.
4. Airlock calculates a bounded change set and evaluates path safety, protected and required paths, change limits, secret patterns, and configured commands.
5. Project commands run against a disposable copy with no network, no application credentials, a read-only root, dropped capabilities, and resource limits.
6. A pass moves the complete workspace and session candidate into a new immutable version and atomically advances `canonical.json`.
7. A failure, Runtime error, or cancellation quarantines or removes both resources while the canonical identifier, thread, and fingerprints remain unchanged.
8. The Playground receives a terminal receipt whose disposition, evidence hash, timeline, change summary, and decisive failure agree with persisted state.

## Trust and recovery boundary

The Fastify control plane, Airlock state manager, and canonical manifest are trusted in this proof of concept.
The Agent Runtime, generated project content, and project validation commands are untrusted.
The atomic canonical manifest is the Phase 2 recovery point and the only source of accepted state.
Canonical workspace and Codex-session versions are never mounted writable into the Runtime or validation container.

## Implemented and tested in Phases 0-3

- Starter-kit Agent CRUD, lifecycle controls, Playground chat, persistence, Codex runner seam, and container path remain intact.
- Promotion, destructive Quarantine, Runtime failure, and cancellation preserve the documented canonical-state invariant.
- Outcome Contracts are versioned and snapshotted per Run.
- Validation evidence is size bounded, duration bounded, and redacted before persistence.
- A production-browser journey proves safe Promotion followed by destructive Quarantine and unchanged accepted reality.
- The same journey stores rejected reasoning in Quarantine and proves that the next turn resumes only accepted reasoning.
- A Whole-Agent resource ledger shows the shared workspace and Agent-memory disposition.
- An opt-in real-container suite proves validation containment without an Ark key or writable canonical mount.

## Deliberate non-claims

This phase does not yet transact SQLite, dispatch external actions, repair quarantined candidates, or reconcile promotion through a crash journal.
Those are explicit later phases rather than hidden assumptions in the qualifying guarantee.
