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

**Outcome Contract Version Record**:
The immutable historical record of one Agent's exact Outcome Contract rules, provenance, and version identity.
_Avoid_: Mutable policy history, backup policy, settings snapshot

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

**Resource Provider**:
An implementation that brings one kind of mutable resource under the Transactional Resource lifecycle.
_Avoid_: Adapter, plugin, state handler

**Capability Claim**:
A versioned statement of the isolation, Promotion visibility, idempotency, reconciliation, and cleanup guarantees a Resource Provider can supply.
_Avoid_: Feature flag, support matrix, marketing claim

**Resource Registry Generation**:
The persisted additive set of exact Resource Provider contracts accepted by one Airlock deployment.
_Avoid_: Plugin list, enabled integrations, adapter config

**Registry Transition**:
A recoverable per-Agent operation that verifies a new provider's immutable source and adds its version reference to Canonical State before a Resource Registry generation is accepted.
_Avoid_: Auto-migration, provider toggle, manifest patch

**Historical Provider Subset**:
The exact Resource Provider vector persisted by an earlier Promotion or Quarantine and used to recover that work after the configured registry expands additively.
_Avoid_: Current providers, best-effort providers, inferred generation

**Candidate Set**:
A bounded group of sibling Candidate States created from one exact Canonical State and one snapshotted Outcome Contract for the same objective.
_Avoid_: Agent race, batch, tournament

**Sealed Candidate**:
A validated Candidate State whose exact built-in resources, provider resources, deferred intents, and Runtime result are committed for deterministic Selection and later re-verification.
_Avoid_: Winner, approved state, frozen sandbox

**Selection Contract**:
A versioned deterministic ranking definition that can compare only Candidates whose required Validations passed.
_Avoid_: Judge prompt, scorer, preference

**Selection Decision**:
The durable scorecard and exact one-winner or no-winner result produced by applying a Selection Contract to one Candidate Set.
_Avoid_: Model choice, vote, race result

**Candidate Set Decision Authority**:
The single immutable record of one exact Selection Decision, its Candidate Set source, contracts, bounded competitor evidence, winner links, and decision timestamp published before mutable Selection metadata.
_Avoid_: Selection cache, winner hint, Promotion journal

**Decision Authority**:
An append-only immutable record of one exact terminal Run Transaction, its frozen Repair parent, and its final Candidate Set context when applicable, used to authorize portable receipt interpretation but never physical Promotion.
_Avoid_: Promotion Authority, mutable receipt row, reconstructed audit

**Promotion Authority**:
The versioned journal evidence that names either an ordinary Run or the exact Candidate Set decision, competitor, winner Run, seal, and source allowed to recover Promotion.
_Avoid_: Winner hint, selected flag, recovery guess

**Assurance Proposal**:
Durable evidence-backed advice that proposes a closed set of monotonic Outcome Contract strengthenings against one exact base version but has no policy authority until an operator accepts it.
_Avoid_: Automatic policy, learned rule, self-editing contract

**Historical Simulation**:
The deterministic counterfactual evaluation of an Assurance Proposal against bounded retained Run evidence, with every result classified as exact, conservative, or unknown.
_Avoid_: Replay, prediction, synthetic test run

**Trusted Rule Catalog**:
A versioned control-plane set of exact secret detectors or Validation commands that an Assurance Proposal may reference without accepting generated executable text or regular expressions.
_Avoid_: Model-generated rule, dynamic allowlist, prompt policy

**External Action Intent**:
A validated description of an irreversible external operation that remains deferred until promotion.
_Avoid_: Tool call, queued action, side effect

**Promotion Receipt**:
The durable evidence connecting a Run Transaction, its Outcome Contract version, its Validation results, and the resulting Canonical State version.
_Avoid_: Log entry, audit row

**Portable Promotion Receipt**:
The provider-neutral canonical commitment to one durable Airlock decision, its before and after state, policy, evidence root, effects, provenance, and ancestry.
_Avoid_: Blockchain record, correctness proof, exported database row

**Portable Promotion Envelope**:
A bounded Portable Promotion Receipt together with its digest, Ed25519 signature, public JWK, verified key fingerprint, and optional selective evidence disclosures.
_Avoid_: Certificate, credential bundle, raw evidence archive

**Evidence Disclosure**:
One redacted evidence leaf and Merkle inclusion proof intentionally included without revealing undisclosed leaves.
_Avoid_: Validation output, full audit dump, secret proof

**Transparency Checkpoint**:
An optional signed Merkle root over an append-only sequence of receipt digests that adds shared log evidence without becoming Promotion authority.
_Avoid_: Canonical State, blockchain truth, correctness attestation
