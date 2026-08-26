# Phases 8 through 11 execution plan

**Status:** Phase 10 is committed on the post-hackathon branch and Phase 11 implementation is complete at release verification; exact clean-clone, independent review, release-commit synchronization, and Wayfinder ratification remain pending

**Scope:** Transactional Resource SDK, Competing Futures, Adaptive Assurance, and Portable Trust

**Release boundary:** The Phase 7 judge release remains frozen on `main` by ADR 0009.

**Cost boundary:** Every automated and browser gate must remain runnable without paid ModelArk inference, a paid remote provider, or a public blockchain transaction.

## Outcome contract for this plan

Phases 8 through 11 extend the same accepted-state guarantee rather than creating adjacent products.
Each phase must produce an observable operator or developer outcome, direct failure evidence, an executable regression gate, an independent commit, and a reproducible local path before the next phase begins.
No phase may silently weaken Candidate State isolation, required Validation, Promotion recovery, External Action Intent deferral, evidence redaction, or the frozen Phase 7 demo.

The roadmap defines the required outcomes at `docs/product/OUTCOME_ROADMAP.md:323-418`.
The current core hard-codes resource kinds and evidence at `apps/server/src/types.ts:20-37` and `apps/server/src/types.ts:129-202`.
The current runner hard-codes SQLite and outbox orchestration at `apps/server/src/airlock-runner.ts:176-189` and `apps/server/src/airlock-runner.ts:202-360`.
The current canonical manifest and Promotion plan hard-code four fingerprints at `apps/server/src/workspace.ts:20-93`.
Those are the primary Phase 8 seams.

## Advancement rules

1. Work remains on the post-hackathon branch until the user explicitly chooses a merge strategy after the Phase 11 gate.
2. A later phase may be designed while an earlier phase runs, but it may not enter the implementation path until the earlier phase gate is green.
3. Every new persisted schema has a migration from every supported prior schema and a round-trip test.
4. Every new public contract has invalid-input, capability-mismatch, timeout, replay, crash, redaction, and size-bound tests where applicable.
5. Every new UI journey uses persisted backend evidence and never hard-codes a favorable outcome.
6. Every remote integration has a deterministic local provider fixture and a clearly bounded consistency claim.
7. The original `npm run demo -- --reset`, `npm run poc`, and `npm run check:phase7` paths remain unchanged and green.
8. GitHub Wayfinder state is authoritative when network access is available.
9. While `api.github.com` is unreachable, decision definitions remain in this plan and must be published before the corresponding phase is marked complete.

## Wayfinder structure

Create a new map titled `Wayfinder: Evolve Agent Airlock into a transactional platform` with label `wayfinder:map`.
Create all four decision tickets before adding sub-issue relationships.

1. `Define the Transactional Resource Provider contract` resolves Phase 8 lifecycle, capability, journal, and conformance semantics.
2. `Choose Competing Futures selection and Promotion semantics` resolves Phase 9 isolation, deterministic ranking, stale-source, and loser-retention behavior.
3. `Define Adaptive Assurance authority and historical simulation` resolves Phase 10 suggestion provenance, monotonic-strengthening rules, replay confidence, approval, rejection, and rollback.
4. `Standardize portable signed Promotion Receipts` resolves Phase 11 canonical encoding, signature, key identity, privacy, verification, and optional anchoring.

Each decision ticket must be assigned before work begins, resolved with a requirement-by-requirement evidence comment, closed, and linked back to the map.

## Domain model additions

These terms become canonical when their implementation decision is accepted.

**Resource Provider**:
An implementation that brings one kind of mutable resource under the Transactional Resource lifecycle.
_Avoid_: Adapter, plugin, state handler

**Capability Claim**:
A versioned machine-readable statement of the isolation, Promotion visibility, idempotency, reconciliation, and cleanup guarantees a Resource Provider can actually supply.
_Avoid_: Feature flag, support matrix, marketing claim

**Candidate Set**:
A bounded group of sibling Candidate States created from one exact Canonical State and one snapshotted Outcome Contract for the same objective.
_Avoid_: Agent race, batch, tournament

**Selection Contract**:
A versioned deterministic ranking definition that can compare only candidates whose required Validations passed.
_Avoid_: Judge prompt, scorer, preference

**Assurance Proposal**:
An evidence-backed suggestion for a reviewed Outcome Contract change that has no authority until an operator accepts it.
_Avoid_: Learned policy, automatic rule, self-healing contract

**Portable Promotion Receipt**:
A provider-neutral, canonically encoded, signed statement of a Run Transaction decision and its committed evidence hashes.
_Avoid_: Blockchain record, certificate, audit log

## Cross-phase invariants

1. A Resource Provider never receives an unbounded application environment or a writable path to Canonical State.
2. Provider plans, references, evidence, and recovery state are serializable, bounded, schema-versioned, and free of credentials.
3. A provider cannot claim stronger atomicity than its declared Capability Claim and verified conformance level.
4. A Candidate Set shares one immutable source identifier, composite fingerprint, and Outcome Contract snapshot.
5. Only candidates that pass every required Validation may enter Selection.
6. Selection is deterministic from persisted evidence and cannot invoke an unrecorded model judgment.
7. An Assurance Proposal can tighten or preserve a contract but cannot silently weaken it or apply itself.
8. Historical simulation distinguishes exact, conservative, and unknown results instead of inventing missing evidence.
9. A Portable Promotion Receipt contains hashes and public metadata, never raw prompts, outputs, credentials, private files, or unredacted Validation output.
10. Receipt verification works offline with ordinary public-key infrastructure and does not require blockchain.
11. Optional anchoring commits only the receipt digest and never becomes required for Promotion.

## Phase 8: Transactional Resource SDK

### Product outcome

A developer can implement and register a new Transactional Resource without modifying the Run Transaction engine, then run an executable suite that verifies the provider's actual guarantees.

### Architecture decision

Use an in-process, dependency-injected Resource Provider registry with a provider-neutral package and serializable lifecycle values.
The core owns ordering, state transitions, journal persistence, evidence bounds, and capability enforcement.
Providers own resource-specific preparation, description, Validation, immutable installation, Quarantine, Discard, and reconciliation.

A provider may expose Candidate-only Runtime bindings, but the core derives environment names and Runtime mount paths from a validated provider identifier.
Providers never choose arbitrary host mounts, Runtime destinations, or environment names.

Promotion visibility supports these explicit levels:

- `canonical-manifest` means an immutable provider version becomes accepted only when Airlock records its reference in the canonical manifest.
- `post-promotion-reconciled` means provider-visible state advances after the Airlock manifest and must converge through journal recovery.
- `best-effort` is representable for inspection but is not eligible for required all-or-nothing Promotion.

The Phase 8 remote proof uses a versioned HTTP object resource with `canonical-manifest` visibility.
The control plane creates and validates a remote branch, installs an immutable version idempotently, and records its reference in Canonical State.
No provider-native mutable pointer is represented as atomically coordinated.

### Alternatives rejected

#### Publish types without integrating the engine

This would leave resource orchestration hard-coded and would fail the outcome that a developer can add a provider without changing the core.

#### Let each provider orchestrate its own lifecycle

This would permit contradictory ordering, unbounded evidence, hidden credentials, and inconsistent recovery semantics.

#### Require every provider to expose distributed atomic commit

Most remote systems cannot participate in one atomic local manifest replacement.
Requiring that claim would either exclude useful providers or encourage false guarantees.

#### Start with PostgreSQL-specific branching

A database-specific public contract would prematurely couple the SDK to SQL, credentials, and one provider's branch semantics.
The versioned HTTP object proof exercises a real process and network boundary with a smaller trusted surface.

### Batch 8.0: Lock the starting boundary

1. Run `npm run check:phase7` on the new branch before implementation.
2. Record the exact Phase 7 commit, test counts, browser timings, dependency audit, and release audit.
3. Confirm `main` remains at `36dc419` and the post-hackathon branch is the only mutable branch.
4. Attach the Phase 8 through 11 ADR evidence to the post-hackathon Wayfinder map and ratification ticket.

Verification:

- The Phase 7 gate passes without source changes.
- `git diff main...HEAD` is empty before Phase 8 implementation begins.

### Batch 8.1: Publish the provider-neutral contract

1. Add `packages/transactional-resource-sdk` as a workspace package with no dependency on the server application.
2. Define schema-versioned JSON-safe identifiers, Capability Claims, Candidate handles, change evidence, Validation evidence, Promotion plans, immutable version references, Quarantine handles, recovery results, and typed lifecycle errors.
3. Define hooks for `prepare`, `describe`, `validate`, `planPromotion`, `promote`, `quarantine`, `discard`, and `reconcile`.
4. Add runtime-access declarations limited to `none`, `read-only`, or `read-write` while leaving path derivation to the core.
5. Add strict runtime validators that reject unknown fields, unsafe identifiers, duplicate kinds, oversized metadata, credentials, non-finite values, and capability-hook contradictions.
6. Export a framework-neutral conformance runner that returns structured case evidence rather than assuming Vitest.
7. Publish generated API documentation from source comments only if the generation is deterministic and checked in through an automated command.

Verification:

- The package builds, type-checks, and can be imported from an external fixture package.
- Compile-time fixtures prove invalid provider shapes fail TypeScript.
- Runtime tests reject forged capability levels and unsafe metadata.
- The SDK source contains no import from `apps/server`.

### Batch 8.2: Integrate a deterministic Resource Coordinator

1. Add a server-owned `ResourceRegistry` that validates providers once at startup and rejects duplicate or incompatible providers.
2. Add a `ResourceCoordinator` that calls providers in stable identifier order and records a bounded event for every lifecycle result.
3. Extend Candidate and canonical manifests with schema-versioned provider references while preserving migration from manifest versions 1 through 3.
4. Include sorted provider version references in the canonical composite fingerprint.
5. Extend Promotion plans and journal records with bounded provider plans and immutable target references.
6. Reconcile provider installation before canonical advancement and reconcile post-Promotion providers only after canonical advancement.
7. Quarantine or discard every prepared provider candidate when the Run reaches the matching terminal disposition.
8. Add provider cleanup protection for active Runs, journal-protected Runs, canonical versions, and retained Quarantine.
9. Keep workspace, Codex session, SQLite, and External Action Intent behavior byte-compatible while moving their capability descriptions into the same evidence vocabulary.

Verification:

- Registering a new provider requires only composition-root configuration and no edit to `AirlockRunner` lifecycle branches.
- Provider prepare failure prevents Runtime invocation and leaves Canonical State unchanged.
- Provider Validation failure quarantines every resource under one disposition.
- Provider Promotion replay creates one immutable version.
- A crash at every provider lifecycle seam converges or fails closed with a named capability-aware error.
- Manifest version 1 through 3 fixtures migrate with no invented provider references.
- Reordering provider registration does not change lifecycle order, fingerprints, or receipts.

### Batch 8.3: Ship the remote versioned-object provider

1. Add `packages/http-object-resource` as a third-party-style package that depends only on the SDK.
2. Implement a bounded HTTP client with explicit timeouts, response-size limits, content-type checks, retry classification, and mandatory redaction.
3. Add a deterministic provider fixture process that supports source reads, candidate branches, immutable version installation, idempotency keys, tamper injection, and crash replay.
4. Expose one Candidate-only `object.json` Runtime binding whose host and Runtime paths are derived by the core.
5. Validate JSON shape, payload size, source fingerprint, and provider version lineage before Promotion.
6. Install immutable remote versions with a deterministic run-scoped idempotency key.
7. Keep provider-native mutable-pointer atomicity declared unsupported and use the Airlock canonical manifest as the acceptance authority.
8. Add startup reconciliation that verifies an installed remote version by fingerprint before repairing journal or Canonical State metadata.

Verification:

- The remote provider runs in a separate local process and crosses a real HTTP boundary.
- A rejected remote-object mutation never changes the canonical provider reference.
- A promoted mutation advances exactly one remote immutable version and one canonical reference.
- Duplicate and concurrent Promotion calls return the same version.
- Timeout, oversized response, malformed JSON, source mismatch, tampering, and provider unavailability fail closed.
- Repeated restart reconciliation neither duplicates versions nor rewrites a contradictory Canonical State.

### Batch 8.4: Make provider guarantees visible and executable

1. Add a compact Transactional Resources panel to the existing Playground rather than creating a separate administration surface.
2. Show provider label, version, disposition, fingerprint transition, conformance level, Promotion visibility, and degraded or unsupported guarantees.
3. Add a provider details disclosure with bounded Validation and reconciliation evidence.
4. Add a CLI command that runs the exported conformance suite against a provider package and emits human-readable plus JSON evidence.
5. Add a production browser journey that promotes and rejects the remote object alongside the existing four resources.
6. Add a clean-clone fixture that installs, starts the provider process, runs the browser proof, and tears down without orphan processes or state.
7. Update the PRD, roadmap, architecture, recovery guide, security policy, README, and demo evidence.
8. Record the accepted provider contract in ADR 0010 because it is public, hard to reverse, and encodes a real consistency trade-off.

### Phase 8 exit gate

- `npm run check:phase8` includes every Phase 7 gate plus SDK build, external-consumer compile, provider conformance, remote-provider integration, crash matrix, and production browser proof.
- The third-party package imports only the SDK and registers without changing `AirlockRunner`.
- Built-in capability fixtures and the remote provider pass the same isolation, idempotency, bounded-evidence, Quarantine, Discard, and reconciliation cases.
- Unsupported native-pointer and distributed atomicity guarantees are machine-readable and visible in the Playground.
- The remote provider performs no paid request and requires no credential.
- A clean clone passes the full gate twice without leaked processes, ports, state, or credentials.
- Phase 7 demo output and browser evidence remain unchanged.
- Git contains one Phase 8 commit on the post-hackathon branch and the Wayfinder decision is resolved.

### Phase 8 commit

`feat: open Airlock to transactional resource providers`

## Phase 9: Competing Futures

### Product outcome

An operator can ask Airlock to explore several isolated approaches to one objective, compare only valid candidates through a deterministic Selection Contract, and promote exactly one reproducible winner.

### Decision boundary

Phase 9 must resolve the tension between ADR 0007's single-child Repair lineage, the service's one-active-Run rule, and the roadmap's sibling Candidate States.
The selected design must preserve one operator-visible Agent lifecycle while allowing bounded internal competitors from one exact source.
ADR 0011 accepts a durable Candidate Set, a reversible evaluation boundary, a deterministic lexicographic Selection Contract, one persisted winner decision, and existing Promotion-journal reuse.
The implemented architecture and adversarial acceptance matrix are recorded in `docs/architecture/competing-futures.md`.
The implementation remains isolated from the frozen Phase 7 judge release, and its production Chrome journey now passes in the current local environment.
The final Phase 11 clean-clone gate will reprove every inherited Phase 8 gate before release.

### Batch 9.1: Model Candidate Sets and Selection Contracts

**Delivery status:** Complete.

1. Add canonical domain terms only after the Wayfinder decision resolves.
2. Define Candidate Set, competitor, selection criterion, selection evidence, winner decision, and loser disposition types.
3. Version and snapshot the Selection Contract at Candidate Set admission.
4. Limit competitor count, per-competitor duration, aggregate tokens, aggregate changed bytes, and aggregate evidence.
5. Define deterministic tie-breaking by persisted competitor identifier after all declared criteria.
6. Prohibit any failed required Validation from entering ranking.

### Batch 9.2: Separate evaluation from Promotion

**Delivery status:** Complete.

1. Split candidate execution and Validation from the irreversible Promotion decision inside the Airlock engine.
2. Prepare every sibling from one exact canonical identifier, composite fingerprint, Outcome Contract, and provider-version vector.
3. Run siblings with isolated workspaces, Codex homes, outboxes, provider candidates, and Runtime bindings.
4. Persist a Candidate Set decision journal before promoting the selected winner.
5. Recheck source freshness immediately before the winner's Promotion.
6. Reconcile an interrupted selection to exactly one winner or an explicit stale or contradictory terminal state.

### Batch 9.3: Rank, retain, and explain

**Delivery status:** Complete.

1. Support deterministic criteria for required-Validation eligibility, operator-supplied quality assertions, changed-file count, added bytes, latency, and token usage.
2. Normalize criteria into bounded integer scores to avoid floating-point drift.
3. Persist every input, normalized score, tie-break, exclusion, and final decision.
4. Support explicit loser policy of retain as Quarantine or evidence-preserving Discard.
5. Never reuse a losing outbox or provider branch in the winner.
6. Add stale-source and concurrent-Candidate-Set conflict handling.

### Batch 9.4: Deliver the operator journey

**Delivery status:** Implementation, exact clean-clone verification, and the production Chrome journey are complete.

1. Add one bounded `Explore competing futures` action to the existing Playground.
2. Show competitor progress, Validation eligibility, deterministic score components, winner reason, and loser dispositions.
3. Keep ordinary single Runs and Repair Runs unchanged.
4. Add a deterministic fixture with three strategies: one invalid, one valid but lower quality, and one reproducible winner.
5. Add browser proof, restart proof, sibling isolation probes, race tests, and a clean-clone gate.
6. Record the accepted selection semantics in ADR 0011.

### Phase 9 exit gate

- No competitor can read, write, mount, or resume a sibling's Candidate State.
- All competitors share the exact recorded source and contract snapshots.
- Required Validation failure makes a competitor ineligible regardless of score.
- Replaying selection produces the same ordered scorecard and winner.
- Exactly one winner advances Canonical State and supported effects.
- Crash recovery before and after the selection decision converges without a second winner.
- The complete competing-futures browser journey is understandable without inspecting server logs.
- `npm run check:phase9` passes twice and includes every Phase 8 gate.
- Git contains one Phase 9 commit and the Wayfinder decision is resolved.

### Phase 9 implementation evidence

- Database version 9 migration and recursive strict parsing, Candidate Set admission, provider-boundary token capability gating, deterministic Selection, aggregate token reservation, scoped duration cancellation, authority-bound Promotion recovery, deletion safety, Registry Transition blocking, and real zero-cost HTTP-to-CodexRunner acceptance pass in 31 focused tests.
- The Runner seals validated Candidates before Promotion planning and re-verifies the exact selected seal before reusing the existing Promotion journal.
- Selected-winner tamper, all-invalid, cancellation, restart, historical-provider onboarding, loser cleanup, and exactly-one-effect paths pass without network or paid inference.
- The `Explore futures` production UI, responsive layout, and Playwright contract are implemented.
- `npm run check:phase9:selection`, `npm run check:phase9:boundaries`, server and web typechecks, and the production web build pass.
- `npm run demo:phase9 -- --reset`, `npm run test:phase9:ui`, and two clean-clone gate repetitions pass without paid inference.
- ADR 0011 is accepted locally and included in the post-hackathon Wayfinder ratification ticket.
- The reviewed source diff is synchronized between the main workspace and the temporary writable Git clone, where the Phase 9 release commit is recorded because the main workspace Git metadata is sandbox-read-only.

### Phase 9 commit

`feat: select among competing Agent futures`

## Phase 10: Adaptive Assurance

### Product outcome

Airlock converts repeated failure evidence into explainable, simulated, operator-controlled Outcome Contract improvements without acquiring authority to change acceptance rules by itself.

ADR 0012 now accepts the closed monotonic operation set, exact or conservative or unknown simulation semantics, trusted rule catalogs, optimistic acceptance boundary, explicit rejection, and version-preserving rollback.
The implemented derivation, simulation, authority, API, and adversarial design is recorded in `docs/architecture/adaptive-assurance.md`.

### Batch 10.1: Define evidence-backed proposals

**Delivery status:** Complete.

1. Add Assurance Proposal states `draft`, `ready`, `accepted`, `rejected`, and `superseded`.
2. Permit only a closed set of monotonic-strengthening operations in generated proposals.
3. Cite exact Run Transaction identifiers, Validation names, change paths, counts, and evidence hashes.
4. Deduplicate recurring patterns deterministically and enforce minimum support thresholds.
5. Bound proposal count, citation count, path length, regex complexity, and retained explanation.

### Batch 10.2: Simulate historical impact honestly

**Delivery status:** Complete.

1. Evaluate each proposed change against every compatible retained Run Transaction.
2. Mark each replay result `exact`, `conservative`, or `unknown` according to available evidence.
3. Never infer file contents, secrets, command results, or untruncated paths that were not retained.
4. Report prior dispositions that would stay the same, become stricter, or remain unknowable.
5. Hash the proposal, source evidence set, simulator version, and complete impact report.

### Batch 10.3: Preserve operator authority and reversibility

**Delivery status:** Complete.

1. Require an explicit operator action to accept or reject every proposal.
2. Revalidate monotonic strengthening at acceptance time against the current Outcome Contract.
3. Accept by creating a normal new immutable Outcome Contract version.
4. Reject without modifying the contract and retain the decision reason.
5. Roll back through another explicit versioned operator change while preserving every historical contract and receipt.
6. Prohibit an automated path from deleting required paths, removing protected paths or secret patterns, increasing resource limits, downgrading required commands, or mutating historical evidence.

### Batch 10.4: Make learning inspectable

**Delivery status:** Implementation and production Chrome journey complete; the inherited clean-clone repetition runs as part of the final Phase 11 release gate.

1. Add a compact Assurance inbox to the existing Agent surface.
2. Show motivation, cited Runs, exact or uncertain replay impact, proposed diff, and authority boundary.
3. Add a deterministic failure corpus that produces useful and deliberately un-actionable proposals.
4. Add tamper, sparse-evidence, truncated-evidence, duplicate-pattern, stale-contract, rejection, acceptance, and rollback tests.
5. Add browser proof that a suggestion has no effect until acceptance and affects only future Runs afterward.
6. Record the accepted authority model in ADR 0012.

### Phase 10 exit gate

- Every proposal cites enough retained evidence to reproduce its derivation.
- The simulator labels missing evidence unknown rather than guessing.
- Generated proposals are monotonic-strengthening by construction and by acceptance-time validation.
- No proposal can apply itself or rewrite a historical Outcome Contract, Run Transaction, Validation, or Promotion Receipt.
- Accept, reject, and rollback actions are explicit, versioned, persisted, restart-safe, and visible.
- `npm run check:phase10` passes twice and includes every Phase 9 gate.
- Git contains one Phase 10 commit and the Wayfinder decision is resolved.

### Phase 10 implementation evidence

- Database version 10 migration, restart-stable version 1 through 9 normalization, versioned assurance evidence, exact nested parsing, append-only Outcome Contract history, deterministic derivation, root-lineage support deduplication, honest simulation, acceptance-time rederivation, stale-base rejection, catalog confinement, and tamper rejection pass in the focused Phase 10 suite.
- The operator-only acceptance transaction creates one future-only contract version, rejection persists without policy mutation, and rollback creates another immutable version with explicit provenance.
- The Playground Assurance inbox and rollback history present the proposed diff, base version, citations, support lineages, historical impact, unknown inputs, authority boundary, decisions, and weakening warning.
- The Agent deletion journal closes the archive-before-database crash window, preserves its mutation lock across later I/O failures, rejects symbolic-link workspace substitution, validates decision and contract provenance semantics, and retains bounded proposal, decision, contract-history, Run, Candidate Set, and receipt digests in the archived tombstone.
- The deterministic local fixture produces a three-lineage failure corpus without a network model, and `npm run demo:phase10 -- --reset` exposes the complete operator journey.
- `npm run check`, `npm run check:phase10:assurance`, server and web typechecks, and the production build pass.
- `npm run test:phase10:ui` passes twice against the exact production bundle, including the future-only authority sequence and 390-pixel layout.
- ADR 0012 is accepted locally and included in the post-hackathon Wayfinder ratification ticket.

### Phase 10 commit

`feat: propose evidence-backed assurance changes`

**Delivery status:** Committed on the isolated post-hackathon branch after code-review approval, architecture clearance, exact clean-clone verification, and the full free local gate.

## Phase 11: Portable Trust

### Product outcome

An independent verifier can validate the integrity, authorship, resource-version commitments, contract commitment, Validation commitment, disposition, and ancestry of an exported Promotion decision without the original Airlock database.

ADR 0013 accepts strict canonical JSON, domain-separated SHA-256 receipt commitments, Ed25519 signatures, public JWK key identities, selective evidence disclosure, offline verification, and strictly optional anchoring for the local implementation.
The implementation-ready protocol, privacy boundary, key lifecycle, transparency log, offline EVM payload, and golden-vector matrix are recorded in `docs/architecture/portable-trust.md`.

### Batch 11.1: Freeze a provider-neutral receipt schema

1. Define Portable Promotion Receipt schema version 1 in a standalone package with JSON Schema and TypeScript types.
2. Include stable identifiers, timestamps, Outcome Contract commitment, sorted provider version commitments, Validation evidence commitment, disposition, repair ancestry, Selection decision commitment when present, and prior receipt link when present.
3. Use a specified canonical JSON encoding and SHA-256 digest with published test vectors.
4. Exclude prompts, Runtime output, raw Validation output, file contents, credentials, environment values, local paths, and private provider metadata.
5. Add explicit algorithm and schema identifiers for future agility without accepting unknown algorithms silently.

### Batch 11.2: Sign, export, and verify offline

1. Use Ed25519 keys from Node's ordinary public-key infrastructure.
2. Store private signing keys outside repository and application metadata with restrictive permissions.
3. Export the public key as JWK plus a stable key fingerprint.
4. Sign the canonical receipt digest and package the receipt, signature, and public verification material in one bounded envelope.
5. Add a standalone verifier library and CLI that require no server, database, ModelArk access, or network.
6. Support key rotation by identifying the signing key without treating an old valid receipt as invalid.

### Batch 11.3: Add privacy-preserving evidence disclosure

1. Build deterministic Merkle commitments over bounded evidence leaves.
2. Let an exporter include selected redacted evidence plus inclusion proofs without revealing undisclosed leaves.
3. Verify disclosed leaves against the signed receipt's evidence root.
4. Reject duplicate leaves, ambiguous encodings, path-like private fields, and proof-order confusion.
5. Publish one stable golden envelope vector and an adversarial matrix for disclosure modes, tampering, wrong keys, wrong order, and unknown algorithms.

### Batch 11.4: Keep anchoring optional and honest

1. Define an anchor interface over the portable receipt digest only.
2. Implement a local append-only transparency log with hash chaining, signed checkpoints, inclusion proofs, and split-view test detection.
3. Add an optional EVM reference contract or transaction-payload encoder only if it can be verified locally without funding or deploying a transaction.
4. Never put prompts, outputs, evidence, provider metadata, user identity, or credentials in an anchor payload.
5. Make receipt signature verification complete without any anchor.
6. Label anchoring as retained-checkpoint consistency evidence rather than a trusted timestamp or Promotion correctness proof.

### Batch 11.5: Deliver the trust workflow

1. Add export controls to promoted, quarantined, discarded, and selected-winner receipts where schema requirements are satisfied.
2. Add a standalone verification page or CLI report that explains every verified claim and every unsupported claim.
3. Add cross-process and clean-clone verification fixtures.
4. Add a key-compromise and rotation runbook without claiming revocation can rewrite historical signatures.
5. Update the PRD, roadmap, architecture, security, recovery, README, and protocol documentation.
6. Record the receipt protocol decision in ADR 0013.

### Phase 11 exit gate

- A fresh clone can verify exported receipt fixtures offline without the Airlock server or database.
- Any one-bit change to signed content, commitments, disclosure proofs, signature, or public key fails verification.
- Private and undisclosed evidence does not appear in the portable envelope or optional anchor.
- Key rotation preserves verification of historical receipts and uses the correct key fingerprint.
- Signature-only verification passes with anchoring disabled.
- Transparency-log verification and split-view detection pass without a public blockchain.
- Optional blockchain payload generation, if included, performs no network call and spends no funds.
- The production Docker image resolves all package workspaces after pruning and passes its live health boundary as the non-root runtime user.
- `npm run check:phase11` passes twice from the working tree and once from a clean clone.
- Every prior phase gate remains green.
- Git contains one Phase 11 commit and every Wayfinder decision is resolved.

### Phase 11 commit

`feat: make Promotion Receipts independently verifiable`

**Delivery status:** Implemented in the working tree with the standalone protocol, HTTP export, operator UI, key runbook, one published golden vector, adversarial and cross-process checks, real durable-evidence acceptance flows, a production Docker gate, and no paid dependency.
The mock production-bundle specification and the real browser-to-Fastify-to-verifier journey pass, including receipt, transparency-anchor, and EVM-calldata downloads at desktop and mobile widths.
The exact clean-clone and independent review gates run after the Phase 11 commit is synchronized to the isolated post-hackathon branch.
The post-hackathon Wayfinder map and one architecture-ratification sub-issue are live, and they close only after the clean-clone and independent review evidence is recorded.

## Expanded verification matrix

### Unit

- Schema parsing, identifier safety, evidence bounds, canonical encoding, hashing, scoring, monotonic proposal operations, and Merkle proofs.
- Capability and hook consistency, deterministic provider ordering, deterministic tie-breaking, and signature algorithm allowlists.

### Integration

- Resource Provider lifecycle through the real coordinator and journal.
- Remote HTTP provider isolation, timeout, replay, tamper, and recovery.
- Candidate Set sibling isolation, selection replay, stale-source conflict, and crash recovery.
- Assurance Proposal derivation, simulation, acceptance, rejection, rollback, migration, and restart.
- Receipt export, selective disclosure, key rotation, transparency log, and cross-process verification.

### Browser

- Remote resource Promotion and Quarantine inside the existing Playground.
- Three competing futures with one invalid competitor and one reproducible winner.
- Assurance suggestion inspection and explicit acceptance with future-only effect.
- Portable receipt export and independent verification report.
- Desktop, 390-pixel mobile, keyboard-only, loading, error, retry, long-evidence, and restart paths.

### Adversarial and recovery

- Path traversal, symlink, SSRF, DNS rebinding assumptions, oversized payload, slow response, malformed response, credential-like data, duplicate lifecycle calls, reordered calls, and capability forgery.
- Crash injection before and after provider installation, Candidate Set decision, contract proposal acceptance, receipt export response, and anchor append.
- Contradictory provider, manifest, journal, receipt, signature, and transparency-log state must fail closed.

### Reproducibility

- Fresh install with no untracked `.env` dependency.
- Loopback-only deterministic providers and fixed fixture data.
- No paid inference, paid database, paid object storage, funded wallet, or public-chain transaction.
- Release audit covers source, generated protocol vectors, Git history, Markdown links, package exports, and secret patterns.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A generic SDK weakens the trusted boundary. | Keep ordering, validation aggregation, journal persistence, path derivation, evidence bounds, and capability enforcement in the core. |
| Remote resources create false distributed-atomicity claims. | Model Promotion visibility explicitly and reject `best-effort` providers from required all-or-nothing transactions. |
| Provider metadata becomes a credential store. | Require JSON-safe bounded metadata, scan it before persistence, and keep connection secrets in control-plane configuration only. |
| Provider installation succeeds before a crash. | Use deterministic plans, immutable versions, idempotency keys, and journal reconciliation before canonical advancement. |
| Competing candidates contaminate one another. | Derive isolated roots and provider branches from sibling Run identifiers and probe mounts, sessions, outboxes, and remote handles. |
| Ranking becomes an opaque model opinion. | Use a versioned Selection Contract, integer normalization, recorded inputs, and deterministic tie-breaking. |
| Adaptive Assurance silently gains policy authority. | Generate only proposals, enforce monotonic strengthening twice, and require explicit operator actions. |
| Historical simulation overclaims missing evidence. | Persist replay confidence and use `unknown` whenever retained evidence cannot prove the counterfactual. |
| Portable receipts leak private data. | Commit to hashes, use allowlisted public fields, add selective disclosure, and scan exported envelopes and anchors. |
| Signature support creates key-management debt. | Use Ed25519, explicit key fingerprints, rotation support, restrictive permissions, and a documented compromise runbook. |
| Blockchain distracts from the product. | Keep signature verification complete without it and treat anchoring as an optional digest-only plugin. |
| Post-hackathon work destabilizes judging. | Keep all work off `main` until an explicit merge decision and run Phase 7 first in every later phase gate. |

## Completion definition

The post-hackathon goal is complete only when all four phases meet their exit gates, their independent commits exist on the post-hackathon branch, every prior phase gate remains green, the clean-clone Phase 11 gate passes, the Wayfinder map contains resolved evidence for every decision, and the user receives an explicit merge or release choice.
