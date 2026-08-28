# Agent Airlock outcome roadmap

**Status:** Outcome-gated product strategy

**Delivered:** Phases 0 through 11 on `post-hackathon/phases-8-11`, with later demo and Portable Trust refinements under release verification

**North-star promise:** Agents may explore many futures, but only validated futures become reality.

## Why this roadmap exists

Agent Airlock should not win by accumulating the largest feature list.
It should win by making one difficult promise visibly true, proving that promise under failure, and then extending the same model further than reviewers expect.

A phase is complete only when it creates an observable user outcome, produces repeatable evidence, and locks that outcome against regression.
Completing code without completing the evidence is not phase completion.

Every later phase must preserve every earlier guarantee.
If an ambitious phase destabilizes the accepted path, it has not earned its place in the submission.

## Product thesis

The CodeJam starter kit already gives an Agent a persistent workspace and session, but the disposable Runtime container does not make those persistent resources transactional.
Agent Airlock adds a trusted decision boundary around the Agent Run.

The winning story is:

1. The Agent works freely in an isolated future.
2. Airlock evaluates the result, not merely the Agent's stated intent.
3. A valid future is promoted as one coherent state change.
4. An invalid future remains inspectable without changing accepted reality.
5. The same contract applies to files, Agent continuity, data, and deferred external effects.

## Advancement rules

1. **Outcome before breadth.**
   Each phase must improve what the operator can safely accomplish, not only what the architecture contains.
2. **Evidence before claims.**
   Each guarantee needs an automated test and a visible demonstration.
3. **Failure is part of the product.**
   Every success path must have a paired rejection, interruption, or recovery path.
4. **The starter kit remains the product surface.**
   The Playground, Agent lifecycle, Runtime, persistent workspace, and Codex continuity must continue to work.
5. **No hidden heroics.**
   A fresh reviewer must be able to reproduce the result without undocumented setup or manual state repair.
6. **The next phase must be earned.**
   Work on a later phase may be explored, but it cannot enter the demo branch until the current phase's exit gate passes.

## Outcome ladder

| Phase                         | Product outcome                                                                                | Competitive level         | Irreversible proof                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0. Baseline locked            | The unmodified starter journey is understood and repeatable.                                   | Eligibility               | Browser acceptance flow and `npm run check` pass.                                                    |
| 1. Harmless failure           | A rejected Agent Run cannot change Canonical State.                                            | Qualifying                | Destructive candidate is quarantined and canonical hash is unchanged.                                |
| 2. Explainable decision       | The operator can understand exactly why a future was accepted or rejected.                     | Strong submission         | Outcome Contract, change summary, timeline, and bounded evidence agree.                              |
| 3. Whole-Agent continuity     | Workspace and Codex session advance or remain unchanged together.                              | Podium                    | Rejected work does not pollute the next turn, while promoted work continues correctly.               |
| 4. Transactional effects      | The model works across files, SQLite, and a deferred external action.                          | Podium plus               | Rejection changes none of them and promotion delivers the action exactly once.                       |
| 5. Recoverable intelligence   | Airlock can repair a quarantined future without contaminating Canonical State.                 | Winning target            | A Repair Run turns real failure evidence into a validated promoted result.                           |
| 6. Adversarial resilience     | Crashes and obvious bypass attempts fail closed.                                               | Winning target            | Fault injection, path escape, symlink, timeout, and duplicate-delivery tests pass.                   |
| 7. Judge-ready release        | A reviewer understands and believes the whole product in three minutes.                        | Submission release        | Fresh-clone setup, live demo, architecture, and full checks pass without hidden steps.               |
| 8. Transactional Resource SDK | Other developers can put new resources behind Airlock.                                         | Post-hackathon platform   | A provider adapter passes a shared conformance suite.                                                |
| 9. Competing futures          | Several Agents or models can attempt the same task and only the best valid future is promoted. | Category-defining product | Deterministic evaluation ranks isolated candidates without cross-contamination.                      |
| 10. Adaptive assurance        | Airlock learns which protections should be strengthened from observed failures.                | Intelligent control plane | Suggested contract changes are explainable, versioned, reviewed, and never silently weakened.        |
| 11. Portable trust            | Promotion evidence can be verified across runtimes and organizations.                          | Ecosystem standard        | A provider-neutral signed Promotion Receipt verifies independently of the original Airlock instance. |

## Hackathon phases

### Phase 0: Baseline locked

**Outcome**

A developer can clone the repository, run the supported local container path, create an Agent, complete a coding task, continue the same session, restart the Agent, and find the workspace intact.

**Build only what is needed**

- Preserve the exact starter-kit frontend, Agent lifecycle, Fastify control plane, Codex Runtime, and local container path.
- Record a deterministic baseline fixture and expected state fingerprint.
- Identify the `AgentRunner`, workspace resolution, Run persistence, and polling seams that Airlock will extend.

**Exit gate**

- The documented browser acceptance journey passes.
- The follow-up turn proves that session continuity works.
- Stop and restart proves workspace persistence.
- `npm run check` passes.
- No secret appears in repository state or captured evidence.

**Beyond-expectations finish**

Capture the baseline as a repeatable regression test so every later phase proves that the starter kit still works.

**What this unlocks**

The team can change the execution boundary without guessing what the baseline promised.

### Phase 1: Harmless failure

**Outcome**

An Agent can attempt dangerous or incomplete work, but a failed attempt cannot alter the accepted workspace.

**Build only what is needed**

- Represent the accepted workspace as versioned Canonical State.
- Prepare isolated Candidate State for every Run Transaction.
- Pass only Candidate State paths to the Runtime.
- Evaluate one required-path Validation.
- Promote a passing candidate and quarantine a failing candidate.

**Exit gate**

- A successful task promotes exactly one new canonical version.
- A controlled task deletes a required file and is quarantined.
- The canonical content hash before and after rejection is identical.
- A failed, cancelled, or timed-out Run cannot reach `promoted`.
- Automated tests exercise the real runner seam rather than a static UI result.

**Beyond-expectations finish**

Show accepted reality and rejected future side by side in the Playground so the safety property is immediately visible.

**What this unlocks**

Airlock becomes real middleware instead of an observability layer wrapped around irreversible execution.

### Phase 2: Explainable decision

**Outcome**

The operator can determine what changed, what was evaluated, and why Airlock promoted or quarantined the Run.

**Build only what is needed**

- Add versioned Outcome Contracts with protected paths, required paths, change limits, secret scanning, and required commands.
- Persist each Validation name, status, duration, and bounded redacted evidence.
- Add a compact preparation, execution, validation, and disposition timeline.
- Add a semantic change summary and Promotion Receipt.

**Exit gate**

- The operator can locate the decisive failed Validation in less than ten seconds.
- The UI, persisted evidence, and final disposition cannot disagree.
- Validation output is time-bounded, size-bounded, and redacted before persistence.
- Contract updates are versioned and affect future Run Transactions only.
- Success and rejection are both covered through the HTTP and browser paths.

**Beyond-expectations finish**

Make the evidence feel like a flight recorder for Agent state, with the decisive moment highlighted instead of buried in logs.

**What this unlocks**

Reviewers can understand the trusted boundary, and operators can act on rejection without reading server internals.

### Phase 3: Whole-Agent continuity

**Status:** Delivered and regression-locked

**Outcome**

The Agent's working memory and workspace behave as one accepted future from the operator's perspective.

**Build only what is needed**

- Isolate the Codex session used by each Run Transaction with Candidate State.
- Advance workspace and session references together during promotion.
- Preserve the canonical session reference during rejection, cancellation, and timeout.
- Start the next Run from the current canonical workspace and session pair.

**Exit gate**

- A promoted Run is correctly understood by the next Playground turn.
- A rejected Run is not remembered as accepted work by the next Playground turn.
- Restart reconciliation preserves the last confirmed workspace and session pair.
- Tests prove that the Runtime receives no writable canonical workspace or canonical session path.

**Beyond-expectations finish**

Demonstrate a rejected future containing both file changes and Agent reasoning, then show the next turn continuing from the untouched accepted reality.
This is the moment that separates Airlock from ordinary file snapshots.

**What this unlocks**

Agent state becomes a coherent transaction rather than a folder rollback with contradictory memory.

### Phase 4: Transactional effects

**Status:** Delivered and regression-locked

**Outcome**

Airlock proves that its contract is a middleware abstraction for Agent effects, not merely a source-control feature.

**Build only what is needed**

- Add one SQLite Transactional Resource inside Candidate State.
- Add typed External Action Intents through a platform-controlled outbox.
- Assign stable idempotency keys and deliver intents only after promotion.
- Show file, database, and action changes in one Run Transaction summary.

**Exit gate**

- A rejected database mutation leaves canonical query results unchanged.
- A rejected or discarded intent causes zero mock external effects.
- A promoted intent causes exactly one effect under duplicate dispatch attempts.
- The demo discloses that unrestricted network access can bypass the outbox.
- The three resources share one understandable final disposition.

**Beyond-expectations finish**

Use one task that edits code, migrates data, and prepares a notification, then prove that all three effects cross the Airlock together or none do.

**What this unlocks**

The architecture becomes credible as general Agent middleware and not a thin wrapper around Git.

### Phase 5: Recoverable intelligence

**Status:** Delivered and regression-locked

**Outcome**

A failed future becomes useful material for a safe repair instead of dead work or corrupted accepted state.

**Build only what is needed**

- Preserve quarantined Candidate State, Validation evidence, and Agent response.
- Start a Repair Run from a selected Quarantine.
- Give the repair attempt the failed Validation evidence and a bounded remediation objective.
- Preserve repair ancestry in the resulting Promotion Receipt.
- Allow discard without erasing the bounded decision evidence.

**Exit gate**

- A real destructive candidate is quarantined.
- A Repair Run corrects the failure and passes the original Outcome Contract.
- Canonical State remains unchanged until repair promotion.
- A failed repair remains quarantined and cannot loop without a configured bound.
- The complete lineage is understandable in the Playground.

**Beyond-expectations finish**

Turn Airlock from a passive gate into a safe recovery system that converts precise failure evidence into the next constrained attempt.

**What this unlocks**

Safety no longer means throwing useful work away, which gives the product a compelling productivity story as well as a security story.

### Phase 6: Adversarial resilience

**Status:** Delivered and regression-locked

**Outcome**

Airlock keeps its promise when execution is malicious, duplicated, interrupted, or partially completed.

**Build only what is needed**

- Add an idempotent promotion journal and startup reconciliation.
- Bound validation duration, output, resources, and credentials.
- Defend Candidate State against path traversal and symlink escape.
- Add configurable Candidate State and Quarantine retention.
- Inject failures before, during, and after the promotion decision.

**Exit gate**

- Every simulated crash point converges to one documented recoverable state.
- Replaying promotion, discard, or external dispatch is safe.
- Path traversal and symlink fixtures cannot reach canonical or unrelated host paths.
- Cleanup never removes current Canonical State or active Candidate State.
- The canonical fingerprint remains unchanged throughout the rejection and abuse matrix.
- `npm audit` reports zero known vulnerabilities and `npm run check` passes repeatedly.

**Beyond-expectations finish**

Present the abuse matrix as product evidence and trigger one failure live, making robustness visible rather than merely asserted.

**What this unlocks**

The submission can make a credible reliability claim instead of relying on the happy path.

### Phase 7: Judge-ready release

**Status:** Delivered and regression-locked

**Outcome**

A reviewer can understand, run, test, and remember Agent Airlock with almost no cognitive overhead.

**Build only what is needed**

- Create one deterministic hero scenario covering promotion, rejection, unchanged reality, and repair.
- Provide one-command local startup and seeded demo fixtures.
- Finish a one-page architecture diagram with the trust boundary and recovery point.
- Polish only the UI states that reveal middleware behavior.
- Document setup, rationale, tests, limitations, and recovery.

**Exit gate**

- A fresh clone reaches the hero scenario without undocumented steps.
- The complete live demonstration finishes within three minutes.
- A reviewer can state the problem, trusted boundary, failure guarantee, and differentiator after one viewing.
- The architecture diagram and running system tell the same story.
- The repository contains no secret, stale screenshot, broken link, lint failure, flaky test, or hidden manual repair.

**Beyond-expectations finish**

End the demo by showing that the Agent did something genuinely destructive, Airlock preserved reality, and the same rejected work was safely repaired and promoted.
The final impression should be a working product with a falsifiable guarantee, not a collection of infrastructure components.

**What this unlocks**

Agent Airlock becomes a coherent hackathon submission that directly addresses all four judging categories.

**Delivered evidence**

- `npm run demo -- --reset` builds production, binds to loopback, seeds one Agent, and requires no ModelArk credential or container engine.
- The terminal, `/api/system`, sidebar, and main UI identify deterministic fixture mode and no paid inference.
- The four-step guide stages the complete Promotion, Quarantine, Repair, and continuity story through real backend behavior.
- The dedicated production Chrome path completed in 6.3 seconds and asserted the 390-pixel viewport without document overflow.
- Launcher integration proves port conflicts, reset, graceful stop, restart persistence, and deterministic seeding.
- `npm run demo:runtime -- --reset` productizes the real pinned-Codex container path as an interactive no-cost proof with a required content Validation and explicit local Responses fixture disclosure.
- Its guided controls run a valid Candidate, a deliberately invalid Candidate, and a bounded Repair Run through that same real Runtime.
- The proof compares Canonical State advancement with an unchanged rejection fingerprint, then links the quarantined parent to the promoted repair child in one signed decision chain.
- The real Runtime UI now reduces the transaction to an evidence-backed `Run`, `Validate`, `Promote`, and `Verify` judge path, while retaining the complete resource, journal, Validation, and change record behind one inspection control.
- Its final action generates a private-by-default two-decision chain and verifies both signatures and the Canonical State handoff locally before download.
- `npm run demo:modelark -- --reset` adds a strict credentialed judge profile that preflights ModelArk, seeds one falsifiable file-content Outcome Contract, and refuses to start a live-proof UI when the provider is unavailable.
- The live guide reduces provider conformance to one action and independently checks the resulting Candidate artifact before showing canonical advancement or signed proof.
- The guided launcher forces the live preflight even when the generic POC skip flag is present, and its tested seed contract rejects persisted policy drift until the operator explicitly resets the managed demo.
- ADR 0009 freezes P0 scope and separates the deterministic release proof from credentialed ModelArk conformance.
- The credential-safe live preflight currently reaches the BytePlus Asia Pacific Responses API but receives HTTP 429 because configured free quota or the inference limit is unavailable.
- Live ModelArk conformance must be rerun at judging time because provider quota, capacity, and model availability are external and time-varying.

## Post-hackathon phases

### Phase 8: Transactional Resource SDK

**Status:** Delivered and regression-locked on published release commit `cb9b63f9caa4ad9ade6d9d76d99d604edcba0d84`; later refinements are being reverified independently.

**Outcome**

Developers can bring a new resource under Airlock without changing the core Run Transaction engine.

**Build**

- Define lifecycle hooks for prepare, diff, validate, promote, quarantine, discard, and reconcile.
- Publish adapter capability declarations and failure semantics.
- Build a provider conformance suite from the workspace, SQLite, and outbox behavior.
- Add one remote-resource adapter, such as PostgreSQL branching or object storage versioning.

**Exit gate**

- A third-party adapter passes the same isolation, idempotency, evidence, and crash-recovery tests as built-in resources.
- Unsupported atomicity guarantees are explicitly represented rather than hidden.

**Beyond-expectations finish**

Make the conformance suite executable so provider claims can be verified, not merely documented.

**Delivered evidence**

- The zero-runtime-dependency SDK exports strict JSON-safe lifecycle contracts, Capability Claim validation, deterministic Promotion keys, and eight provider-neutral conformance cases.
- The server registers providers once, enforces exact required capability compatibility, derives Candidate-only Runtime bindings, and persists a sorted provider version vector in canonical manifest schema 4.
- Existing deployments add providers through independently verified, additive Registry Transitions with per-Agent crash journals and a globally committed registry generation.
- Historical Promotions and retained Quarantines recover against their persisted provider subset before any additive Registry Transition or generation commit can proceed.
- Registry Transition recovery rejects forged identifiers, fingerprints, fields, or verification sets before any immutable state path can be removed.
- New Agents independently verify every configured immutable provider source before their first Canonical State is created.
- Promotion journal validation bounds provider plans and lifecycle evidence, and provider crash recovery verifies exact immutable target fingerprints before canonical advancement.
- The SDK and core share one exact Promotion-plan admission rule, including rejection of a reused source version identifier with a changed fingerprint.
- Every provider-controlled persisted or displayed string is bounded and credential-checked, including identifiers, Runtime-relative paths, keyed assignments, summaries, reconciliation evidence, and multiline raw errors.
- The credential-free HTTP object provider depends only on the SDK and fails closed for timeout, oversized, malformed, wrong-content-type, unavailable, source-mismatch, and tampered responses.
- Provider preparation failure prevents Runtime invocation, provider-only rejection quarantines the whole Candidate, and repeated Promotion installs one immutable version.
- Lost prepare responses, partial multi-provider progress, cancellation cleanup outages, and post-Runtime symbolic-link substitutions retain retryable evidence while Canonical State remains unchanged.
- Immutable Discard authority is persisted before ordinary provider or local removal, successful provider cleanup gains an authority-bound immutable completion fact before local removal, prepare-abort authority embeds exact cleanup proof, and missing contradictory state becomes `recovery-error`.
- Provider removal and contract replacement fail closed until an explicit export-and-retire migration exists.
- `npm run check:phase8:conformance` emits readable and JSON evidence from the public CLI.
- `npm run demo:phase8 -- --reset` and the dedicated production Chrome specification exercise remote Promotion and Quarantine while leaving the Phase 7 judge launcher unchanged.
- ADR 0010 records the public provider contract and its explicit canonical-manifest consistency boundary.

### Phase 9: Competing futures

**Outcome**

Airlock can ask several Agents, models, or strategies to solve the same objective, evaluate their isolated results, and promote only the best valid future.

**Build**

- Fork several Candidate States from one canonical version.
- Apply the same Outcome Contract to every candidate.
- Rank passing candidates with deterministic quality, cost, latency, and operator-defined criteria.
- Show the evidence for both rejection and selection.
- Promote one winner and discard or retain the remaining candidates according to policy.

**Exit gate**

- No candidate can observe or alter a sibling candidate.
- The selected winner is reproducible from recorded criteria and evidence.
- A lower-quality candidate cannot win by bypassing a required Validation.
- Promotion still advances Canonical State exactly once.

**Beyond-expectations finish**

Turn transactional safety into an optimization primitive: safe parallel exploration of possible Agent futures.
This is Agent Airlock's category-defining expansion because ordinary sandboxes isolate one attempt, while Airlock can compare and choose among many accepted possibilities.

**Delivered evidence**

- Database version 9 persists the Candidate Set aggregate, exact shared source, snapshotted contracts, per-competitor Run links, scorecard, Selection Decision, and loser cleanup progress with a tested version 8 migration.
- The Runner now seals a validated Candidate before any Promotion plan or journal exists, then exposes separate seal-verifying winner Promotion and loser-disposition operations.
- Two through eight competitors receive unique workspace, Codex-home, outbox, provider Candidate, and Runtime execution identities while one Agent-level lease prevents lifecycle conflicts.
- A real per-competitor duration timer cancels only the over-budget execution identity, preserves healthy siblings, and records explicit exclusion evidence.
- Required Validation failure is an absolute exclusion, and the deterministic Selection engine uses only closed bounded integer criteria plus ascending UTF-8 competitor identifiers.
- The complete ordered scorecard, one-winner or no-winner result, tie-break rule, and SHA-256 decision digest are persisted before the existing Promotion journal begins.
- A changed or contradictory selected winner enters `recovery-error`; Airlock never falls through to a runner-up and never dispatches a losing External Action Intent.
- Restart recovery finishes the exact persisted winner, reconciles loser retention or Discard idempotently, and completes older-generation Candidate Sets before onboarding a newly configured provider.
- Discard authority is published before provider and local loser cleanup, then an immutable authority-bound provider-cleanup completion fact is published before local removal, so restart never trusts mutable cleanup claims.
- The real no-cost HTTP-to-CodexRunner fixture launches three isolated processes, excludes `unsafe-fast`, selects `focused-valid`, advances Canonical State once, and delivers exactly one supported effect.
- The Playground `Explore futures` journey shows shared-source evidence, competitor eligibility, normalized scores, winner rationale, decision digest, and loser disposition at desktop and 390-pixel layouts.
- `npm run check:phase9:selection` and `npm run check:phase9:boundaries` lock the schema migration, admission bounds, deterministic replay, scoped duration cancellation, operator cancellation, tamper, recovery, provider-generation, and irreversible-boundary guarantees without credentials or paid inference.

### Phase 10: Adaptive assurance

**Outcome**

Airlock uses patterns in rejected Runs and production incidents to recommend stronger Outcome Contracts without silently taking authority from operators.

**Build**

- Detect recurring failure, protected-path, secret, and resource-limit patterns.
- Propose new or tightened Validations with evidence and expected impact.
- Simulate a proposed contract against historical Promotion Receipts before adoption.
- Require review for contract changes and preserve version history.

**Exit gate**

- Every suggestion cites the Runs and evidence that motivated it.
- Historical simulation identifies which prior Runs would change disposition.
- The system cannot automatically weaken a required Validation.
- Operators can reject or roll back a policy version without changing prior evidence.

**Beyond-expectations finish**

Make safety improve from experience while keeping the acceptance boundary explicit, reviewable, and reversible.

**Delivered evidence**

- Database version 10 persists strict recursively parsed Assurance Proposals and append-only Outcome Contract version records with a tested version 9 migration.
- The deterministic detector uses only bounded retained transaction fields, applies per-rule support thresholds, deduplicates Repair siblings by root lineage, and emits stable operation and citation order.
- The historical simulator records exact, conservative, or unknown results for every bounded retained Run and never reopens Candidate State, reruns a command, recovers a secret, or invents missing evidence.
- Proposal identifiers, evidence hashes, result hashes, simulation digests, and proposal digests reproduce from the same evidence independently of input order or creation time.
- Acceptance rederives advice from retained evidence, verifies its exact base, catalogs, digests, and structural monotonic relation, then atomically creates the next ordinary Outcome Contract version.
- Stale proposals cannot be rebased, rejection changes no contract field, and rollback creates a later immutable version while retaining the rule content and provenance of every prior version.
- The Playground Assurance inbox explains the proposed diff, base version, supporting lineages, historical disposition changes, unknown inputs, citations, decision history, and explicit operator authority.
- Agent deletion now uses a durable two-phase journal, converges after interruption between archive rename and database mutation, and archives credential-free Assurance and contract-history digests.
- The deterministic local fixture can create the three-lineage README failure corpus and demonstrate derivation, simulation, acceptance, rejection, and rollback without ModelArk credentials, paid inference, or a public blockchain transaction.
- `npm run check:phase10:assurance` locks deterministic derivation, lineage deduplication, unknown evidence, stale-base rejection, catalog confinement, tamper detection, strict HTTP input, restart persistence, rollback, strict database parsing, and deletion recovery.

### Phase 11: Portable trust

**Outcome**

A Promotion Receipt can be independently verified after it crosses a machine, team, Runtime, or organization boundary.

**Build**

- Define a strict provider-neutral receipt schema for contract version, resource versions, Validation evidence commitments, disposition, ancestry, Candidate Selection, and accepted Assurance provenance.
- Sign receipts with an operator-held Ed25519 identity and publish a self-contained offline verifier.
- Add deterministic selective disclosure and a signed local transparency log without making either necessary for receipt verification.
- Produce optional EVM calldata over the receipt digest without a wallet, RPC, transaction, or funds.
- Keep private inputs and sensitive evidence out of envelopes, anchors, fixtures, logs, and browser downloads.
- Bundle the envelope and selected optional proofs into one strict Portable Evidence Packet without bundling evaluator trust roots.
- Bundle complete Repair ancestry into one strict Portable Decision Chain with exact signed parent and Canonical State continuity checks.

**Exit gate**

- An independent verifier can confirm receipt integrity without access to the original Airlock database.
- An independent verifier can confirm a complete Repair lineage without importing parent receipts one at a time.
- Private evidence is not included, while the signed Merkle root commits to the complete bounded evidence set and selected redacted leaves can be verified.
- The design works without blockchain and uses blockchain only where shared governance creates a real trust gap.
- Key rotation preserves historical verification, while loss, substitution, unsafe permissions, and symbolic links fail closed.
- A one-bit change to content, proof, signature, public key, algorithm, or checkpoint fails verification.
- Cross-process protocol checks, server acceptance, the prior phase gates, and the clean-clone release gate pass without paid inference.

**Beyond-expectations finish**

Establish Outcome Contracts and Promotion Receipts as a portable trust protocol for Agent execution rather than a feature owned by one application.

**Delivered evidence**

- The standalone `@agent-airlock/portable-promotion-receipt` package implements strict bounded parsing, canonical JSON, domain-separated SHA-256 commitments, Ed25519 signatures, public JWK fingerprints, Merkle disclosures, and a network-free verifier CLI.
- The published golden vector passes in a separate process, and adversarial mutations to signed content, public material, disclosure proofs, algorithms, or signatures are rejected.
- Private signing keys remain in owner-only regular files outside application metadata, and adjacent non-secret identity markers make missing or substituted keys fail closed instead of silently rotating identity.
- Historical envelopes continue to verify under their included public JWK after an explicit key rotation.
- The server exports only complete versioned durable evidence and binds exact provider versions, Outcome Contract, required Validations, Repair ancestry, prior receipts, Candidate Selection, and accepted Assurance provenance when applicable.
- Promoted, retained, discarded, and cancelled Candidate Runs can each export an independently verifiable receipt after the Candidate Set completes.
- Every terminal path publishes immutable Run authority before its mutable child projection, and one immutable Candidate Set Decision Authority is published before mutable Selection.
- Candidate Set authority binds loser policy before irreversible cleanup, and an available Quarantine may advance only through one evidence-preserving authoritative Discard.
- Completed Promotion recovery may add only its exact restart marker plus one successful reconciliation event for every provider already committed by the promoted transaction.
- Startup audits active and already-terminal Runs, restores missing Selection from exact authority, and replays the newest valid Run plus competitor lifecycle instead of synthesizing a contradictory decision.
- Child Run and competitor status become visible together, while the Agent deliberately remains busy until the Candidate Set completes Selection, winner Promotion, and loser cleanup.
- Discard authority precedes provider and local physical removal, and terminal authority or authorized cleanup failure keeps Agent execution plus Resource Registry admission closed.
- Promotion and provider-onboarding history reuse timestamps from their durable source evidence, which makes recovery after history publication byte-identical and lets installed Registry Transitions roll forward safely.
- Incomplete or contradictory evidence returns a retryable conflict without changing Canonical State or durable Run evidence.
- The Playground starts with no evidence disclosed, previews safe evidence identities, requires regeneration after privacy settings change, and offers one evidence-packet download plus separate expert downloads for each component.
- The global browser-local verifier accepts an exported envelope or packet without an API call, checks canonical digest, Ed25519 signature, included key identity, disclosed Merkle proofs, transparency inclusion, and EVM digest binding, and visibly rejects tampered or cross-receipt content.
- The verifier accepts a separately signed bounded trust policy only after its authority matches an evaluator-pinned out-of-band fingerprint, then reports whether the valid receipt signer is active, historically trusted, unknown, compromised, expired, outside its signing window, or outside its Agent and disposition scope.
- The verifier can extend that pinned root through one bounded cross-signed Policy Authority Rotation without allowing the next key or policy to self-authorize.
- The verification report separates mathematical integrity from Runtime isolation, policy sufficiency, Validation correctness, signer-clock accuracy, and organizational trust.
- The optional local transparency log signs chained checkpoints and proves inclusion and consistency, while tested split views fail verification and signature-only export remains complete.
- Concurrent transparency writers use immutable numbered lock turns, recover dead predecessors through one validated completion marker, never unlink a successor's pathname, and reject malformed or discontinuous queue evidence.
- The optional EVM encoder produces a frozen `anchor(bytes32)` payload with zero network calls and zero funds spent and does not claim publication or Promotion correctness.
- The production Docker image builds every workspace, resolves all three runtime packages through the pruned workspace installation, starts as the non-root runtime user, and passes its live health boundary.
- `npm run check:phase11:protocol` and the Phase 11 server acceptance matrix require no ModelArk credential, paid inference, provider purchase, wallet, or public blockchain transaction.
- `npm run check:phase11:docker` turns the production-image build, runtime package imports, and live health probe into a repeatable release gate.

## Hackathon cut lines

### Qualifying proof

Phases 0 through 2 are the non-negotiable floor.
They prove real middleware behavior, integration, failure containment, and visible evidence.

### Podium target

Phases 3 and 4 create the strongest technical differentiation.
They prove that Agent memory and multiple side effects participate in one coherent acceptance decision.

### Winning target

Phases 5 through 7 turn the architecture into a memorable product.
They add safe repair, adversarial confidence, and a flawless three-minute story.

### Future vision

Phases 8 through 11 are implemented on an isolated post-hackathon branch and remain outside the frozen Phase 7 judging path.

## Three-day execution allocation

### Day 1: Make failure harmless

- Complete Phase 0 before changing the execution path.
- Build the thinnest end-to-end slice of Phase 1 through the real `AgentRunner` seam.
- Finish the day only when one passing candidate promotes and one destructive candidate leaves the canonical fingerprint unchanged.

The Day 1 demo should already communicate the core invention even if every later phase is removed.

### Day 2: Make the decision understandable and Agent-aware

- Complete the Phase 2 contract, evidence, API, and minimum Playground presentation.
- Complete Phase 3 session isolation and prove the next-turn behavior after both promotion and rejection.
- Begin Phase 4 only after the browser path and automated regression path are green.

The Day 2 demo should show a complete browser-to-Runtime success and rejection story with no static middleware result.

### Day 3: Prove breadth, recovery, and polish

- Complete the deterministic SQLite and mock outbox fixture for Phase 4.
- Add the single Repair Run journey from Phase 5.
- Select the highest-risk abuse and crash cases from Phase 6 instead of attempting an unlimited hardening sweep.
- Freeze behavior for the final four hours and spend that time completing Phase 7 rehearsal, documentation, cleanup, and reproducibility.

If Phase 4 is not stable by the Day 3 midpoint, freeze new capabilities and submit the strongest fully proven Phase 3 product.
A smaller falsifiable guarantee scores better than a larger unreliable claim.

## Judging strategy

| Judging category                 | Weight | Evidence designed into the roadmap                                                                                        |
| -------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------- |
| End-to-end middleware behavior   |    40% | Browser-to-Runtime Candidate State, real Validation, promotion, quarantine, repair, SQLite, and outbox effects.           |
| Technical design and integration |    25% | A narrow `AgentRunner` seam, versioned contracts, Transactional Resource boundaries, and recoverable promotion.           |
| Verification and robustness      |    20% | Paired positive and negative tests, canonical fingerprints, fault injection, redaction, cleanup, and bypass disclosure.   |
| Demo and reproducibility         |    15% | One-command startup, deterministic fixtures, one-page architecture, three-minute hero scenario, and explicit limitations. |

The roadmap intentionally spends most implementation effort on the 40% behavior category while using the same artifacts to earn the design and robustness points.
The final polish phase protects the remaining 15% instead of treating presentation as last-minute decoration.

## The three-minute hero scenario

1. Select an existing Agent with a visible Outcome Contract.
2. Ask it to update application code, migrate SQLite data, and prepare a mock deployment notification.
3. Trigger a controlled mistake that deletes a required file.
4. Show the candidate diff, failed Validation, quarantined database change, deferred notification, and unchanged canonical fingerprint.
5. Start a Repair Run using the captured failure evidence.
6. Show every required Validation pass and promote the repaired workspace, session, database, and notification intent.
7. Send a follow-up message that proves the Agent continues from the promoted state.

This one scenario demonstrates useful behavior, a trusted boundary, an Agent-specific failure, recovery, multiple resources, evidence, and continuity without changing the starter kit's core experience.

## Product scorecard

Review the scorecard at every phase boundary.
A phase does not advance while any critical row is red.

| Dimension        | Green condition                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| User outcome     | The operator can accomplish the phase promise through the normal Playground journey.            |
| Safety invariant | Rejection, cancellation, timeout, and interruption preserve the last confirmed Canonical State. |
| Evidence         | The final disposition can be explained from persisted bounded evidence.                         |
| Automation       | The phase's success and failure claims have deterministic automated coverage.                   |
| Baseline         | Agent CRUD, lifecycle, Playground, model execution, persistence, and follow-up still work.      |
| Reproducibility  | A teammate can reproduce the phase from documented setup.                                       |
| Demo clarity     | The new value can be shown in one concise visual beat.                                          |
| Scope control    | No unproven later-phase dependency is required for the current promise.                         |

## Product decisions this roadmap makes

- Airlock wins through transactional Agent state, not through blockchain, generic authorization, or a broad observability dashboard.
- The POC uses local containers because the track rewards the smallest infrastructure that proves the middleware.
- UI work exists to reveal real backend behavior and evidence, not to replace it.
- SQLite and the mock outbox are proof of abstraction, not separate product directions.
- Repair is the hackathon's highest-value stretch because it turns containment into productive recovery.
- Competing futures are the strongest post-hackathon expansion because they convert the same isolation boundary into a quality optimizer.
- Portable receipts use ordinary cryptography for independent verification and keep blockchain anchoring optional, digest-only, and limited to genuine shared-governance needs.
