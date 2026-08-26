# Agent Airlock Product Requirements Document

**Status:** Phases 0 through 10 regression-locked; Phase 11 release candidate implemented

**Product:** Agent Airlock middleware for the CodeJam starter kit

**Primary user:** A developer or operator running coding Agents through the existing Playground

## Product summary

Agent Airlock gives every Agent Run a safe place to attempt work without immediately changing accepted platform state.
The Run executes against isolated Candidate State, produces an explainable change set, and becomes Canonical State only after its Outcome Contract passes.
Delivery follows the measurable exit gates in the [outcome roadmap](OUTCOME_ROADMAP.md).

The product promise is simple:

> Agents may explore many futures, but only validated futures become reality.

## Current release

Phases 0 through 10 are regression-locked, and Phase 11 is implemented at release-candidate verification.
The release makes workspace, Codex-session, and SQLite changes transactional, versions and snapshots each Outcome Contract, constrains configured Validation commands, and presents bounded Whole-Agent decision evidence in the existing Playground.
Typed notification intents use a candidate-owned outbox and an idempotent mock consumer that can claim an effect only after the canonical manifest advances.
An operator can now repair or discard a Quarantine, while bounded ancestry, canonical freshness checks, a fresh outbox, and the original Outcome Contract keep recovery fail-closed.
A platform-owned Promotion journal now reconciles every approved decision forward after process interruption, verifies physical fingerprints before repairing metadata, and fails closed on contradiction.
Positive Candidate and Quarantine retention windows remove only expired mutable state while preserving bounded decision evidence.
The judge-ready release adds a loopback-only deterministic launcher, one seeded hero Agent, a four-step guided Playground story, restart-safe fixture state, a dedicated production Chrome acceptance path, and an automated release audit.
The deterministic fixture replaces only paid model inference and is disclosed in the terminal, system API, sidebar, and main UI.
The Phase 8 release candidate adds a provider-neutral SDK, strict Capability Claims, a shared executable conformance suite, and a credential-free remote versioned-object provider.
Registered provider state now participates in the same Candidate preparation, required Validation, Promotion journal, Quarantine, Discard, Repair, canonical fingerprint, and restart-reconciliation decision as built-in resources.
Existing deployments add providers through a verified, additive, crash-recoverable Registry Transition, and Airlock commits a registry generation only after every Agent converges.
The existing Playground shows provider guarantees and bounded lifecycle evidence while explicitly refusing to claim distributed atomic commit.
Phase 9 adds durable Candidate Sets that evaluate two through eight isolated approaches from one exact Canonical State and snapshotted Outcome Contract.
Only Candidates that pass every required Validation enter a deterministic bounded-integer Selection Contract, and Airlock persists the complete scorecard and exact winner before Promotion begins.
The selected winner is re-verified and promoted through a decision-and-seal-bound journal authority, while losers are retained or discarded without dispatching their effects and can never become an automatic fallback.
Strict Candidate Set parsing, deterministic aggregate token reservations, terminal evidence for never-started siblings, authority-bound restart recovery, and provider-generation deferral keep the release fail-closed under corrupted or interrupted state.
Phase 10 adds deterministic Assurance Proposals that cite recurring bounded Run evidence, replay monotonic policy changes against retained history, and label unavailable inputs as unknown.
Advice has no policy authority until an explicit operator acceptance atomically creates the next Outcome Contract version.
Rejection remains durable without changing policy, rollback creates another immutable version, and Agent deletion archives proposal and contract-history digests in a crash-recoverable credential-free tombstone.
Phase 11 adds independently verifiable Portable Promotion Receipts derived only from complete versioned durable evidence.
Airlock signs a strict canonical receipt with a locally held Ed25519 identity, supports selective Merkle disclosure, explains supported and unsupported claims, and optionally records only the receipt digest in a signed local transparency log.
An offline verifier needs no Airlock database, server, ModelArk key, network, wallet, or public blockchain.

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
7. Let a developer add a capability-checked Transactional Resource Provider without editing core Run Transaction lifecycle branches.
8. Let an operator compare bounded isolated futures and promote exactly one reproducible valid winner.
9. Let an independent verifier check a bounded Promotion decision after it crosses a machine, team, or organization boundary.

## Non-goals

- Production-grade multi-tenant isolation.
- General container orchestration.
- Production OAuth or enterprise identity management.
- Transparent transactions for arbitrary third-party APIs.
- Kernel-level filesystem virtualization.
- Distributed transactions across unrelated external providers.
- BytePlus ECS deployment as a judging requirement.
- Required public-blockchain deployment, wallet custody, token issuance, or on-chain execution.

## Target product journey

This journey describes the complete product direction, including later roadmap phases.

1. The operator creates or selects an Agent through the starter UI.
2. The operator reviews or accepts the Agent's Outcome Contract.
3. The operator sends a normal coding task through the Playground.
4. Airlock prepares Candidate State and runs Codex against it.
5. Airlock shows the resulting file, database, and deferred-action changes.
6. Airlock executes every required Validation.
7. Airlock promotes the Candidate State automatically when the Outcome Contract passes.
8. Airlock quarantines the Candidate State when any required Validation fails.
9. The operator can inspect evidence, discard the Quarantine, or start a Repair Run from it.
10. The operator can instead ask Airlock to explore several bounded strategies from the current Canonical State.
11. Airlock excludes every future that fails required Validation, explains a deterministic scorecard, persists one Selection Decision, and promotes only that sealed winner.
12. The operator can export a private-by-default Portable Promotion Receipt and choose whether to include selected redacted evidence, a local transparency proof, or offline EVM calldata.
13. An independent verifier can validate the envelope and understand both the claims it proves and the claims it cannot prove.

## Product target requirements

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
- A provider-neutral SDK must define bounded JSON-safe lifecycle values and strict runtime validators.
- Every registered provider must publish a machine-readable Capability Claim and fixed failure semantics.
- The trusted core must own lifecycle order, exact provider membership, Runtime path derivation, evidence bounds, journal persistence, and the final disposition.
- Provider Candidate bindings must never expose a mutable Canonical path or provider credential to Runtime.
- Airlock must reject a provider access claim that the selected Runtime cannot enforce.
- Airlock must revalidate Candidate provider paths after Runtime and before trusted provider lifecycle hooks.
- Provider Promotion must be idempotent from one deterministic Run key and install an exact immutable target reference.
- Restart reconciliation must verify the provider target fingerprint before canonical advancement.
- Adding a provider to an existing deployment must verify its exact immutable source and use a recoverable per-Agent Registry Transition.
- A Resource Registry generation must advance only after every existing Agent converges.
- Historical Promotion and Quarantine recovery must use the exact provider subset persisted by that transaction, and any unresolved prior-generation recovery must defer provider onboarding and generation commit.
- Agent creation and Run execution must remain unavailable while a Resource Registry generation is uncommitted.
- Creating a new Agent must verify every configured initial provider version before writing its first canonical manifest.
- Phase 8 provider evolution must be additive and must reject removal, identity replacement, or Capability Claim replacement.
- Unsupported native-pointer atomicity and distributed atomic commit must remain explicit in machine evidence and the Playground.

### Promotion and quarantine

- Promotion must use a durable state record that identifies every promoted resource version.
- Promotion must be idempotent and safe to reconcile after interruption.
- Quarantine must preserve the Candidate State, Validation evidence, and Agent response.
- Discard must remove quarantined mutable state while retaining the bounded Promotion Receipt and Validation evidence.
- A Repair Run must start from Quarantine and must not alter Canonical State unless the repaired candidate passes.

### Competing Futures

- A Candidate Set must snapshot one exact Canonical State identifier, content hash, Codex thread, provider-version vector, Outcome Contract, Selection Contract, and loser policy before evaluation starts.
- A Candidate Set must contain two through eight unique competitors and a bounded concurrency and aggregate execution budget.
- Admission must reserve a positive trusted Runtime total-token allowance for every competitor before any Runtime starts, and the sum of those allowances must not exceed the aggregate token budget.
- Admission must reject a Runner that cannot enforce its reserved allowance before or at the model-provider boundary, before creating a Candidate Set or starting any competitor.
- Missing or over-budget trusted Runtime usage evidence must exclude that competitor and fail closed before Selection.
- Every competitor must receive its own Run Transaction, workspace, Codex home, outbox, provider Candidate State, and Runtime execution identity.
- No competitor may observe a sibling path, handle, thread artifact, outbox, provider Candidate, or Runtime result.
- Reversible evaluation may execute Runtime and required Validations but must not plan Promotion, create a Promotion journal, advance Canonical State, or dispatch an External Action Intent.
- Required Validation failure must exclude a Candidate from Selection regardless of every ranking value.
- Selection must use a snapshotted ordered list of closed, bounded integer criteria and ascending byte-order competitor identifier as the final tie-break.
- Every criterion input, normalized score, exclusion, rank, tie-break, and decision digest must be persisted before Promotion begins.
- The selected sealed Candidate must be re-verified against its source and exact resource fingerprints immediately before Promotion.
- A selected-winner contradiction must fail recovery closed and must never authorize a runner-up.
- Only the selected winner may advance Canonical State or dispatch an External Action Intent.
- Every losing Candidate must be retained or discarded according to the snapshotted policy, and a retained loser must not become a Repair source.
- Restart recovery must preserve a durable Selection Decision, finish only its exact winner, and reconcile loser cleanup idempotently across historical provider generations.
- A Candidate Set Promotion journal must bind the Candidate Set, competitor, winner Run, Selection Decision digest, seal digest, and exact source before recovery may install state, advance Canonical State, or dispatch effects.
- Any unresolved Candidate Set recovery failure must defer Resource Registry onboarding and generation commit.

### Adaptive Assurance

- An Assurance Proposal is durable advice and has no execution, Promotion, or Outcome Contract authority.
- Proposal derivation must use only bounded persisted transaction fields and trusted versioned catalogs, never raw prompts, Runtime output, environment values, expired Candidate files, or provider-private metadata.
- Generated operations must come from the closed monotonic-strengthening set and may never remove a rule, raise a limit, alter an existing command, make a required command optional, or introduce an arbitrary command or regular expression.
- Every operation must cite distinct root Run lineages, exact evidence selectors, evidence hashes, and one closed derivation rule at or above its minimum support threshold.
- Historical simulation must classify each retained compatible Run as exact, conservative, or unknown and must never treat missing or truncated evidence as a pass, failure, benefit, or avoided incident.
- Equivalent base contracts, operations, citations, and simulation evidence must produce the same proposal identifier, order, and digest.
- Acceptance must rederive the proposal from retained evidence, verify all digests and catalog references, enforce exact-base optimistic concurrency, and prove structural monotonic strengthening in one store transaction.
- Only an explicit operator action may accept or reject a ready proposal.
- Acceptance must create an ordinary future-only Outcome Contract version and must not alter a Run already admitted under an earlier snapshot.
- Rejection must preserve the proposal and byte-bounded credential-free operator reason without changing any Outcome Contract field.
- Rollback must require explicit confirmation, disclose removed required paths, protected paths, secret detectors, required Validation commands, and raised limits, and create another immutable Outcome Contract version without mutating historical Runs, contracts, proposals, or receipts.
- Database version 10 must strictly reject unknown or malformed nested Assurance Proposal, simulation, decision, and Outcome Contract history fields before startup recovery.
- Agent deletion must be crash-recoverable and preserve bounded proposal, decision, contract-version, and lifecycle digests in its archived tombstone.

### Portable Trust

- Portable Promotion Receipt export must derive only from complete, versioned, contradiction-free durable Run evidence and must never reinterpret incomplete or legacy evidence as authority.
- A strict schema-versioned receipt must commit to the Run disposition, exact resource before-and-after versions, Outcome Contract, required Validation evidence, repair ancestry, and prior receipt when present.
- Every terminal Candidate Set Run must commit to the exact persisted Selection Decision and its own promoted, retained, discarded, or cancelled disposition.
- One immutable Candidate Set Decision Authority must be published before mutable Selection, and every final Candidate Set-bound terminal Run authority must exist before that Selection becomes visible.
- Restart must restore an authorized missing Selection and replay an authorized terminal Run exactly, while any contradiction fails closed.
- A Run admitted under an operator-accepted Assurance Proposal must commit to the exact source proposal and resulting Outcome Contract version.
- The signer must use Ed25519 with domain separation, strict canonical JSON, SHA-256 commitments, an included public JWK, and a stable public-key fingerprint.
- A private key must remain outside Git, the JSON store, browser responses, logs, receipts, anchors, and test vectors.
- The key and its non-secret identity marker must be owner-readable regular files, and key loss or substitution must fail closed instead of silently rotating identity.
- The portable envelope must exclude prompts, Runtime output, raw Validation output, file contents, environment values, credentials, local paths, provider-private metadata, and undisclosed evidence.
- Selective disclosure must use deterministic bounded Merkle leaves and reject duplicate identities, ambiguous encodings, path-like private fields, wrong proof order, unknown algorithms, and malformed proofs.
- Offline verification must distinguish mathematical integrity from Runtime isolation, Validation correctness, policy sufficiency, signer-clock accuracy, and organizational trust in the signing key.
- Optional local transparency must append only receipt digests, produce signed checkpoints and inclusion proofs, detect tested split views, serialize writers through immutable numbered turns without unlinking successor ownership, and remain unnecessary for signature verification.
- Optional EVM calldata generation must be an offline reference encoding over the receipt digest, make zero network calls, spend zero funds, and claim neither publication nor Promotion correctness.
- Export must be deterministic and retryable, return a conflict for incomplete evidence, and fail without changing Canonical State, Run evidence, or Outcome Contract authority.

### Operator experience

- The existing Playground must remain the primary task-entry surface.
- The active Run must show preparation, execution, validation, and disposition as a compact timeline.
- A promoted Run must show an outcome summary and resulting state version.
- A quarantined Run must identify the failed Validation and show the protected Canonical State as unchanged.
- The operator must be able to inspect a bounded file-change summary and Validation output.
- The operator must be able to discard Quarantine or request a Repair Run.
- The interface must not display credentials, environment values, or unredacted sensitive content.
- The interface must show registered provider identity, source and target fingerprints, disposition, conformance profile, Promotion visibility, and bounded lifecycle evidence.
- The Playground must provide one bounded `Explore futures` action and show the shared source, Validation eligibility, normalized score components, stable tie-break, winner decision digest, and loser dispositions.
- Eligible terminal Runs must offer a private-by-default Portable Trust export that previews available evidence before any disclosure is selected.
- The interface must require regeneration after disclosure or anchor settings change and must download only the independently verifiable envelope.
- The interface must explain signature status, receipt digest, signing-key fingerprint, verified commitments, unsupported claims, optional local transparency evidence, and optional zero-network EVM calldata.
- Recovery-error and incomplete Runs must not present a misleading export action.

### Judge-ready release experience

- `npm run demo -- --reset` must build and start the production application on loopback with no required credential or container engine.
- The launcher must seed exactly one named Agent and print the URL, persistent state root, four-step path, restart behavior, reset behavior, and no-paid-inference disclosure.
- The Web UI must disclose deterministic fixture mode without obscuring normal Agent lifecycle or Playground controls.
- The guided story must stage Promotion, destructive Quarantine, Repair, and continuity actions without hard-coding middleware outcomes in the frontend.
- Demo progress must be derived from persisted assistant messages and actual Run results.
- Restart without reset must preserve the Agent identifier, conversation, Canonical State, and evidence.
- The credentialed `npm run poc` path must remain separate and unchanged.
- A reviewer must be able to distinguish reproducible middleware proof from pending live ModelArk conformance.

## Reliability requirements

- Promotion processing must be idempotent.
- Duplicate delivery of an External Action Intent must not duplicate its mock external effect.
- Validation output must respect the existing bounded-output philosophy.
- Candidate and Quarantine retention must be configurable.
- Cleanup must never delete the current Canonical State version.
- A corrupted Candidate State must fail closed and preserve Canonical State.
- Failure to establish the state of an interrupted promotion must place the Agent in an understandable recoverable error state.
- Failure after a Candidate Set winner is selected must preserve that decision, dispatch no losing effect, and never silently select another competitor.

## Security requirements

- Canonical State paths must not be writable from the Agent Runtime.
- Validation commands must not run directly on the host.
- Candidate State must not inherit unnecessary credentials.
- Sensitive values must be redacted before evidence is persisted or displayed.
- Path validation must prevent traversal outside the Candidate State root.
- Symlink handling must prevent Candidate State from reaching canonical or unrelated host paths.
- External actions outside the controlled outbox are a documented residual risk for the POC.
- Portable receipts and anchors must never contain private signing keys, credentials, prompts, Runtime output, raw Validation output, file contents, environment values, local paths, or provider-private metadata.
- Receipt verification must not imply that the signer is organizationally trusted or that an optional anchor proves Promotion correctness.

## Implemented success metrics

- A successful Run promotes a valid workspace and the next Playground message continues from that promoted state.
- A destructive Run that deletes required files is quarantined and leaves the Canonical State content hash unchanged.
- The complete success and rejection story fits in a three-minute live demonstration.
- `npm run check` passes.
- A rejected SQLite mutation leaves canonical query results unchanged.
- A deferred mock external action executes once after promotion and zero times after rejection.
- A quarantined destructive Run can be repaired and promoted without changing Canonical State before the repaired promotion.
- The repaired Run preserves useful rejected work, restores protected canonical content, uses a fresh outbox, and records bounded lineage.
- Discard removes mutable Quarantine state idempotently while retaining bounded decision evidence.
- Interruption at each Promotion seam converges after restart to one canonical version, one assistant message, and at most one supported mock effect.
- A contradictory journal, installed version, or canonical manifest produces an explicit `recovery-error` without rewriting Canonical State.
- A malformed or forged Registry Transition journal must be rejected before it can authorize deletion or Canonical State rewriting.
- Agent deletion must refuse unresolved Promotion recovery or retained Quarantine and must preserve a credential-free lifecycle evidence tombstone in the archived workspace.
- Candidate and Quarantine cleanup is root-confined, symlink-safe, active-Run-aware, and evidence preserving.
- A third-party-style provider package imports only the SDK and passes the same eight-case conformance suite used by built-in fixtures.
- Provider prepare failure prevents Runtime invocation and either completes idempotent cleanup or retains a retryable composite Quarantine.
- Provider-only Validation rejection leaves the complete canonical composite fingerprint unchanged.
- Duplicate provider Promotion installs one immutable version, and every tested interruption converges without replaying Runtime.
- Provider cleanup evidence is durable before local mutable state removal, and missing contradictory state fails recovery closed.
- Provider onboarding preserves every built-in Canonical fingerprint, fails closed on an unverifiable source, and converges after interruption at every Registry Transition seam.
- A lost prepare response, partial multi-provider failure, cancellation cleanup outage, oversized source, redirect, or post-Runtime symbolic-link substitution cannot change Canonical State or erase the recovery handle.
- Provider-controlled identifiers, summaries, metadata, lifecycle evidence, reconciliation evidence, and errors must remain bounded and credential-free before persistence or display.
- A production browser journey promotes and quarantines the remote resource while showing its real persisted evidence.
- A standalone process verifies the published golden Portable Promotion Envelope without the Airlock server or database and rejects any one-bit mutation.
- A promoted Run, Repair ancestry chain, selected Candidate Set winner, and future Run under an accepted Assurance Proposal export the exact matching provenance commitments.
- Key rotation preserves historical mathematical verification, while key loss, substitution, unsafe permissions, and symbolic links fail closed.
- Selective disclosures, local transparency inclusion and consistency, tested split-view detection, and offline EVM calldata pass without a ModelArk credential, network request, wallet, transaction, or funds.
- The Portable Trust UI begins with no evidence disclosed and explains every supported and unsupported verification claim before download.

## Later-phase success metrics

- The complete success, rejection, repair, and continuity story finishes in 6.3 seconds under deterministic production-browser automation and fits in a rehearsed three-minute live demonstration.

## Release scope

### Qualifying proof

Phases 0 through 2 of the [outcome roadmap](OUTCOME_ROADMAP.md) are the minimum submission.
They preserve the starter baseline, isolate Agent execution, prove that rejection leaves Canonical State unchanged, and make the promotion decision explainable.

### Podium target

Phases 3 and 4 are the primary technical differentiators.
They make Codex continuity transactional with the workspace and prove the same acceptance boundary across SQLite and a deferred External Action Intent.

### Winning target

Phases 5 through 7 add recoverable Repair Runs, adversarial resilience, and a deterministic three-minute release experience.
All three phases are delivered and regression-locked.
Later-phase work cannot enter the judging path before submission.

### Post-hackathon expansion

Phase 8 delivers the Transactional Resource SDK on the isolated post-hackathon branch.
Phase 9 delivers competing Agent futures with deterministic one-winner Selection on the same branch.
Phase 10 delivers deterministic, operator-controlled Adaptive Assurance on the same branch.
Phase 11 delivers independently verifiable Portable Promotion Receipts on the same branch.
These capabilities are not dependencies of the frozen Phase 7 hackathon release.

## Known limitations

- The POC supports one local control-plane process.
- Full atomicity across local state and arbitrary external providers is not claimed.
- The outbox only controls actions routed through the platform interface.
- Copy-based Candidate State preparation may be slower for very large workspaces.
- Exactly-once delivery is claimed only for the atomic local mock consumer, not arbitrary third-party providers.
- Local transparency provides append-only and split-view evidence to observers that retain checkpoints, not a globally witnessed timestamp.
- Offline EVM calldata generation does not submit, fund, confirm, or monitor a blockchain transaction.

## Wayfinder decisions

- The P0 cutoff and judging acceptance bar are resolved in [ADR 0009](../adr/0009-freeze-the-judge-release-boundary.md) and tracked through [Wayfinder issue 9](https://github.com/Kk120306/agent-airlock/issues/9).

Codex session isolation is resolved in [ADR 0005](../adr/0005-version-codex-home-with-candidate-state.md).
External Action Intent delivery is resolved in [ADR 0006](../adr/0006-defer-external-actions-until-promotion.md).
Quarantine repair, lineage, freshness, and discard semantics are resolved in [ADR 0007](../adr/0007-repair-quarantined-futures.md).
Promotion journal, forward recovery, contradiction handling, and retention semantics are resolved in [ADR 0008](../adr/0008-reconcile-approved-promotions-forward.md).
The deterministic judge path, fixture disclosure, and post-hackathon cutoff are resolved in [ADR 0009](../adr/0009-freeze-the-judge-release-boundary.md).
The Resource Provider lifecycle, capability eligibility, and canonical-manifest consistency model are resolved in [ADR 0010](../adr/0010-open-the-run-transaction-through-capability-checked-resource-providers.md).
Deterministic Candidate Selection and exact-winner recovery are resolved in [ADR 0011](../adr/0011-select-one-sealed-candidate-from-a-durable-candidate-set.md).
Monotonic evidence-backed assurance and explicit operator authority are resolved in [ADR 0012](../adr/0012-keep-adaptive-assurance-monotonic-and-operator-controlled.md).
Canonical portable receipts, key identity, selective disclosure, and optional anchoring are resolved locally in [ADR 0013](../adr/0013-sign-canonical-portable-receipts-and-keep-anchoring-optional.md), with remote Wayfinder synchronization pending network availability.
Authority-first Selection, exact terminal replay, and append-only transparency lock turns are resolved locally in [ADR 0014](../adr/0014-publish-selection-and-terminal-authority-before-mutable-projections.md).

The [Wayfinder map](https://github.com/Kk120306/agent-airlock/issues/1) is the canonical index for these decisions.
