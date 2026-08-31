# Agent Airlock one-page architecture

**Selected track:** Track 1 - Agent Launchpad: Design and Build Lightweight Agent Middleware.

## One reusable capability

Agent Airlock adds one transactional execution boundary to the starter kit's shared `AgentRunner` seam, so the same isolation, Validation, Promotion, Quarantine, and Repair rules apply to every Agent Run.
The official scoring lens is 40% end-to-end middleware behavior, 25% technical design and integration, 20% verification and robustness, and 15% demo and reproducibility.

![Agent Airlock one-page architecture](agent-airlock-one-page.png)

## Falsifiable guarantee

An Agent Run may freely mutate its isolated workspace, Codex session, SQLite data, and supported action outbox, but none can change Canonical State unless every required Validation passes.

```mermaid
%%{init: {"theme": "base", "flowchart": {"wrappingWidth": 420}, "themeVariables": {"fontSize": "24px", "lineColor": "#3c3a58"}}}%%
flowchart TB
    Title["AGENT AIRLOCK · TRACK 1<br/>Transactional execution middleware for every Agent Run"]

    subgraph Execute["1 · EXECUTE ONE STARTER-KIT PATH"]
        direction LR
        UI["React Playground<br/>Agent CRUD + lifecycle"]
        API["Fastify API<br/>AgentService"]
        Airlock["Shared Airlock wrapper<br/>AgentRunner seam"]
        Inference["Local Responses fixture<br/>or optional ModelArk"]
        Runtime["Pinned Codex CLI<br/>disposable container"]
        Candidate["Run-owned Candidate<br/>files + session + SQLite + outbox"]

        UI --> API --> Airlock
        Inference --> Runtime
        Airlock -->|TRUST BOUNDARY<br/>Candidate-only bindings| Runtime
        Runtime <--> Candidate
    end

    subgraph Decision["2 · TRUSTED OUTCOME CONTRACT DECISION"]
        direction LR
        Complete["Complete Candidate<br/>crosses back to control plane"]
        Contract{"GUARANTEE<br/>Only if every required check passes<br/>may Candidate become Canonical"}
        subgraph PassLane["PASS"]
            direction LR
            Promote["Durable Promotion journal<br/>atomic manifest advance"]
            Canonical["Canonical State<br/>accepted reality"]
            Effect["Typed external effect<br/>after Canonical advance"]
            Promote --> Canonical --> Effect
        end
        subgraph FailLane["FAIL"]
            direction LR
            Quarantine["Quarantine<br/>accepted state unchanged"]
            Repair["Bounded Repair child<br/>same contract + fresh outbox"]
            Reenter["RE-ENTER SAME PATH<br/>Airlock + Candidate + Contract"]
            Quarantine --> Repair --> Reenter
        end

        Complete --> Contract
        Contract -->|PASS| Promote
        Contract -->|FAIL| Quarantine
        Reenter -. "repeat until pass or depth limit" .-> Contract
    end

    subgraph Verify["3 · PRESERVE AND VERIFY EVIDENCE"]
        direction LR
        Decisions["Promotion + Quarantine + Repair<br/>persisted Run decisions"]
        Evidence["Redacted receipt + signed lineage<br/>evidence only, never Promotion authority"]
        Proof["JUDGE-VISIBLE PROOF<br/>harmless failure + recovery + verifier"]
        Decisions --> Evidence --> Proof
    end

    Title ~~~ Execute
    Execute -->|complete Candidate| Decision
    Decision -->|persist every disposition| Verify

    classDef trusted fill:#eeedff,stroke:#6558d9,color:#171333,stroke-width:2px;
    classDef untrusted fill:#fff3df,stroke:#bd6518,color:#3d250d,stroke-width:2px;
    classDef headline fill:#171333,stroke:#171333,color:#ffffff,stroke-width:2px;
    class API,Airlock,Complete,Contract,Promote,Canonical,Effect,Quarantine,Repair,Reenter,Decisions,Evidence trusted;
    class Inference,Runtime,Candidate untrusted;
    class Title,Proof headline;
```

The standalone Mermaid source is [agent-airlock-one-page.mmd](agent-airlock-one-page.mmd).
The complete implementation architecture remains in [agent-airlock.md](../architecture/agent-airlock.md).

## Five-step flow

1. The operator sends any Agent task through the existing React Playground, Fastify API, and `AgentService`, which route it through the shared Airlock wrapper at the `AgentRunner` seam.
2. Airlock copies the immutable Canonical workspace, Codex session, and SQLite snapshot into Run-owned Candidate State, creates a fresh outbox, and gives the disposable Codex container no mutable Canonical State path.
3. Airlock snapshots the Agent's versioned Outcome Contract and validates the complete Candidate, including file policy, SQLite integrity, bounded action intents, secret scanning, and constrained project commands.
4. A pass records durable approval, installs one immutable version, and atomically advances `canonical.json`, while a failure quarantines every Candidate resource and a Repair child must re-enter the same boundary with the original contract, exact failure evidence, verified Canonical reference, and fresh outbox.
5. Supported effects become claimable only after the manifest advances, while the receipt and optional signed decision chain preserve evidence without becoming Promotion authority.

## What is real in the canonical proof

The React UI, Fastify API, `AgentService`, `AgentRunner`, pinned Codex CLI, disposable container, Candidate file mutation, `.airlock/demo.sqlite` mutation, persistent session, outbox, Validation, Promotion journal, atomic manifest change, Quarantine, Repair, and browser-local verification are real.
Only remote inference is replaced by the disclosed local deterministic Responses fixture.
ModelArk remains a separate optional conformance path when free capacity is available and is not required for the Track 1 middleware proof.

## Trust and recovery boundary

The Fastify control plane, Airlock state manager, Outcome Contract source, Promotion journal, and atomic canonical manifest are trusted for this proof of concept.
The Agent Runtime, generated project content, project validation commands, and all Candidate resources are untrusted.
Canonical workspace, Codex-session, and SQLite versions are never mounted writable into the Runtime or validation container.
Startup recovery may finish only the exact durable approved decision recorded before interruption and fails closed on physical fingerprint contradiction.

## Deliberate limitations

- Exactly-once delivery ends at the supported atomic local consumer and is not a distributed transaction with arbitrary providers.
- Unrestricted Runtime traffic outside the typed outbox is not transactionally controlled.
- The journal targets one local control-plane process and does not claim distributed consensus or power-loss durability.
- Ordinary containers are not hardened multi-tenant isolation.
- Signatures prove artifact integrity and lineage, not Runtime correctness, signer identity, or policy sufficiency.
- Live ModelArk availability and model quality are not claimed by the deterministic core recording.
