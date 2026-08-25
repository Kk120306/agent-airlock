# Phases 5 through 7 execution plan

**Status:** Phase 5 implementation and no-cost exit gate complete; Phases 6 and 7 pending

**Scope:** Recoverable intelligence, adversarial resilience, and judge-ready release

**Cost boundary:** All automated and browser work uses deterministic local fixtures until organizer-provided ModelArk credentials arrive.

**Phase 5 evidence:** `npm run check:phase5` passed with 73 server tests, one production Chrome journey, zero dependency vulnerabilities, the pinned Codex session-isolation probe, and three constrained validation-container tests.

## Requirements summary

Phase 5 must turn a retained Quarantine into a bounded Repair Run without advancing Canonical State before validation.
The selected Quarantine already retains the candidate workspace, Codex home, outbox, candidate manifest, Validation evidence, and Agent output through the existing runner and JSON store paths in `apps/server/src/airlock-runner.ts:251-276` and `apps/server/src/types.ts:152-171`.

Phase 6 must make the promotion decision convergent across process interruption, replay, path abuse, and retention cleanup.
The current promotion implementation renames Candidate State and then replaces `canonical.json` in `apps/server/src/workspace.ts:332-385`, while post-promotion action delivery can currently stop at `delivery-error` in `apps/server/src/airlock-runner.ts:286-340`.
Those are the exact seams that require a durable journal and startup reconciliation.

Phase 7 must package the complete promotion, rejection, unchanged-reality, repair, and continuity story into a deterministic local release that a fresh reviewer can run without paid inference.
The existing production Playwright journey already covers creation, promotion, rejection, unchanged Canonical State, continuation, restart, SQLite, and deferred effects in `tests/e2e/baseline.spec.ts:6-206`.
Phase 7 extends that same real browser path instead of creating a disconnected presentation fixture.

## Cross-phase invariants

1. The Runtime receives only Candidate State workspace, Codex home, and outbox paths, preserving the request boundary in `apps/server/src/airlock-runner.ts:157-204`.
2. A failed, cancelled, stale, corrupt, or interrupted attempt cannot change the canonical manifest or canonical composite fingerprint.
3. Workspace, Agent memory, SQLite, and deferred External Action Intents retain one coherent disposition.
4. Promotion remains automatic only after every required Validation passes.
5. External delivery remains deferred until the canonical manifest advances, and exactly-once remains scoped to the atomic local mock consumer.
6. Persisted and displayed evidence remains bounded and redacted.
7. No Phase 5 through 7 verification path calls ModelArk or another paid inference endpoint.
8. Each phase ends in a dedicated green check, independent commit, push, Wayfinder resolution, and map context pointer before the next phase begins.

## Architecture decisions

### Repair lineage

A Repair Run copies the selected quarantined workspace and Codex home into a new Candidate State.
It receives a fresh candidate identifier and a fresh empty outbox, so rejected intents cannot replay accidentally.
The repair prompt includes only bounded failed Validation evidence, the original objective, and a narrow remediation instruction.

A repair may start only when the current canonical state identifier and composite fingerprint still match the parent transaction's `canonicalStateIdBefore` and `canonicalContentHashBefore` from `apps/server/src/types.ts:157-160`.
If Canonical State advanced, the API returns a conflict and directs the operator to start a new normal Run against current reality.

Lineage records a root Run identifier, parent Run identifier, repair depth, and configured maximum depth on every transaction and Promotion Receipt.
One non-terminal child is allowed per quarantined parent, and the default maximum repair depth is two.
This intentionally avoids competing repair branches, which remain Phase 9 scope.

### Discard semantics

Discard is an idempotent terminal transition from `quarantined` to `discarded`.
It deletes only the mutable directory resolved internally as `.quarantine/<run-id>` and retains the Run, Agent output, bounded Validation evidence, timeline, hashes, lineage, and a refreshed disposition receipt.
API callers never supply a filesystem path.

### Promotion journal

The platform owns an atomic per-Run journal under `APP_DATA_DIR`, outside every Runtime mount.
The journal records stable identifiers, source and target state fingerprints, the bounded transaction snapshot, and these monotonic phases: `validated`, `version-installed`, `canonical-advanced`, `effects-delivered`, and `completed`.

Recovery treats the canonical manifest as the authority for accepted reality, the immutable version directory as installed but not necessarily accepted state, and the mock delivery store as the authority for delivered effects.
Reconciliation is idempotent and either completes the already-recorded promotion decision or produces an explicit recoverable error when physical evidence contradicts the journal.
It never silently rolls Canonical State backward.

Interrupted preparation, execution, or validation is quarantined when a valid candidate exists and cancelled when no candidate exists.
Interrupted promotion is reconciled from the journal before generic active-Run cleanup.

### Retention

Candidate and Quarantine retention windows are configuration values with safe positive defaults.
Cleanup accepts the current active Run identifiers as protected inputs and never traverses outside the two platform-owned state roots.
Expired Quarantine removes mutable candidate data while converting the retained transaction evidence to `discarded` with a timeline explanation.
Canonical version directories are outside both cleanup roots and are never eligible.

### Deterministic release mode

`npm run demo` builds the production application and starts a loopback-only fixture runtime with isolated demo data and no network inference.
The script prints the URL, fixture disclosure, hero prompts, and cleanup location.
The normal `npm run poc` path remains the credentialed starter-kit and ModelArk path.

## Phase 5: Recoverable intelligence

### Batch 5.1: Model repair and discard as explicit lifecycle operations

1. Extend shared server and web transaction types in `apps/server/src/types.ts` and `apps/web/src/types.ts` with `discarded`, repair lineage, Quarantine availability, and receipt ancestry.
2. Add a schema migration in `apps/server/src/store.ts` that supplies original lineage to all prior Runs without changing their recorded safety evidence.
3. Add `AIRLOCK_MAX_REPAIR_DEPTH` to `apps/server/src/config.ts`, defaulting to two and bounded to a small positive integer.
4. Update receipt construction and resource finalization in `apps/server/src/airlock-runner.ts:405-480` so discard and ancestry remain cryptographically tied to the Validation evidence.

Verification:

- Versions 1 through 5 migrate to the new database schema with original lineage and unchanged prior dispositions.
- A receipt for a repaired promotion contains root, parent, and depth values that match the transaction.
- A discarded receipt retains the same Validation evidence hash as its quarantined predecessor.

### Batch 5.2: Prepare and execute a bounded Repair Run

1. Add safe Quarantine inspection, repair preparation, discard, and availability methods to `apps/server/src/workspace.ts` beside the existing candidate lifecycle at `apps/server/src/workspace.ts:258-429`.
2. Copy the quarantined workspace and Codex home into a new `.candidates/<repair-run-id>` root, write a new candidate manifest, and create an empty outbox.
3. Extend `AirlockRunner.run` with an explicit prepared-candidate source so normal Runs fork Canonical State while Repair Runs fork Quarantine through the same Runtime, Validation, promotion, and evidence pipeline.
4. Add service operations that atomically enforce Agent readiness, parent disposition, Quarantine availability, single-child lineage, maximum depth, and canonical freshness before scheduling a repair.
5. Build the repair prompt from the original objective and bounded failed Validation evidence, with an explicit instruction to fix only the cited contract failures and preserve useful candidate work.
6. Add idempotent discard behavior that cannot race an active repair child.

Verification:

- A destructive original Run remains quarantined with its original workspace, session, SQLite change, outbox, output, and evidence.
- A Repair Run begins from that exact quarantined workspace and session, receives a fresh outbox, restores the required path, passes the original snapshotted contract, and promotes all four resources.
- Canonical fingerprint remains byte-for-byte unchanged between the original rejection and repaired promotion.
- A failed repair remains quarantined and can continue only until the configured depth.
- A stale parent, duplicate child, exhausted depth, missing Quarantine, wrong Agent, stopped Agent, and busy Agent each fail closed with a stable HTTP response.
- Replaying discard returns the same terminal result and cannot remove any unrelated directory.

### Batch 5.3: Make lineage operable in the Playground

1. Add `POST /api/runs/:id/repair` and `POST /api/runs/:id/discard` routes with no caller-controlled path in `apps/server/src/app.ts:163-166`.
2. Add typed API methods in `apps/web/src/api.ts` and action state in `apps/web/src/App.tsx:287-495`.
3. Add a compact Quarantine action bar, repair depth, parent link, root lineage, mutable-state availability, and discard confirmation to the Airlock evidence card at `apps/web/src/App.tsx:49-284`.
4. Make actions keyboard accessible, disable them during in-flight work, and show conflict reasons without erasing the existing card.
5. Extend the deterministic Codex fixture and production Playwright path to exercise rejection, repair, repaired promotion, lineage, and restart persistence.
6. Record the decision in an ADR and update the PRD, roadmap status, architecture, demo script, and Wayfinder issue.

### Phase 5 exit gate

- `npm run check:phase5` passes the complete prior suite plus Repair Run unit, HTTP, production browser, migration, restart, stale-state, depth, and idempotent-discard coverage.
- The browser shows one understandable path from destructive Quarantine to repaired promotion.
- The original canonical fingerprint remains unchanged until the repaired candidate promotes.
- Git contains one Phase 5 commit pushed to `origin/main`.

### Phase 5 commit

`feat: repair quarantined Agent futures`

## Phase 6: Adversarial resilience

### Batch 6.1: Separate promotion into durable idempotent phases

1. Introduce a `PromotionJournal` in `apps/server/src` with atomic write-then-rename persistence under `APP_DATA_DIR/promotion-journal`.
2. Split `WorkspaceManager.promoteCandidate` from `apps/server/src/workspace.ts:332-385` into idempotent planning, version installation, and canonical-manifest advancement operations.
3. Have `AirlockRunner` persist `validated` before moving Candidate State, `version-installed` after the immutable state is present, `canonical-advanced` after manifest verification, `effects-delivered` after idempotent dispatch, and `completed` after final evidence is durable.
4. Persist enough bounded transaction data to restore the JSON store without copying credentials or arbitrary Runtime output into the journal.
5. Keep configuration-update promotions on the same physical primitives while excluding them from Agent Run recovery metadata.

Verification:

- Repeating any journal phase returns the same target state and never creates a second version or effect.
- A stale source canonical state fails before installation.
- A journal, candidate, version, or manifest mismatch enters a named recovery error without changing Canonical State.

### Batch 6.2: Reconcile every interruption point on startup

1. Reconcile open promotion journals before the existing generic active-Run restart handling in `apps/server/src/agent-service.ts:72-125`.
2. Complete already-decided promotion when the journal and physical state agree.
3. Reparse the immutable accepted outbox and use the atomic mock dispatcher to recover delivery after canonical advancement.
4. Rebuild the final transaction, receipt, Agent canonical reference, message output, and Run status when the JSON store lags physical promotion.
5. Quarantine valid candidates interrupted before a recorded promotion decision, and cancel only Runs with no candidate state to retain.
6. Surface an understandable Agent error state when reconciliation cannot establish one safe physical truth.

Verification:

- Deterministic fault injection after each monotonic phase converges after restart to one documented terminal state.
- Crashes before the decision preserve Canonical State and retain the candidate when available.
- Crashes after the decision converge to exactly one promoted canonical version and at most one mock delivery.
- Restarting reconciliation repeatedly is safe.

### Batch 6.3: Add bounded retention and the abuse matrix

1. Add candidate and Quarantine retention settings to `apps/server/src/config.ts` and document their units and defaults.
2. Add root-confined cleanup methods to `WorkspaceManager` that protect active Run identifiers and never inspect or remove canonical version roots.
3. Convert expired Quarantine evidence to `discarded` without removing receipt, Validation evidence, output, or lineage.
4. Extend path traversal, symlink, corrupt-manifest, timeout, oversized-output, secret, duplicate-dispatch, duplicate-discard, and interrupted-promotion tests.
5. Add an abuse-matrix evidence panel or compact recovery event treatment in the Playground without turning the primary card into a generic observability dashboard.
6. Record the promotion-journal decision in an ADR and resolve its Wayfinder issue.

### Phase 6 exit gate

- `npm run check:phase6` passes Phase 5 plus the complete crash matrix, retention suite, path and symlink abuse suite, repeated full checks, and `npm audit` with zero known vulnerabilities.
- Every fault point has a documented and asserted terminal state.
- Cleanup cannot remove current Canonical State, active Candidate State, or unrelated host data.
- Git contains one Phase 6 commit pushed to `origin/main`.

### Phase 6 commit

`feat: reconcile interrupted Agent transactions`

## Phase 7: Judge-ready release

### Batch 7.1: Create the no-cost one-command hero environment

1. Add a production-mode local demo launcher under `scripts/` that uses an isolated data root, the deterministic Codex fixture, loopback binding, and no ModelArk network call.
2. Add `npm run demo`, `npm run check:phase5`, `npm run check:phase6`, and `npm run check:phase7` scripts in `package.json:13-28`.
3. Seed one named hero Agent and print the exact browser URL and four-step demo card at startup.
4. Preserve `npm run poc` as the real credentialed starter-kit path and clearly label fixture mode in the system banner.
5. Verify signal handling, port conflicts, stale demo-state cleanup, and restart persistence.

### Batch 7.2: Polish the three-minute product story

1. Replace generic starter prompts in `apps/web/src/App.tsx:5-9` with fixture-aware hero actions only when deterministic demo mode is active.
2. Present promotion, controlled destructive rejection, unchanged fingerprint, Repair Run, repaired promotion, and continuity as a single visual story.
3. Preserve the existing starter Playground as the task-entry surface and keep advanced evidence collapsed or secondary.
4. Audit desktop and mobile layout, focus order, labels, color contrast, long evidence, disabled states, and error recovery in installed Chrome.
5. Capture fresh screenshots from the real production build and remove stale screenshot references.

Verification:

- The production browser journey completes the full hero path in less than 180 seconds and asserts every key visual claim.
- A 390-pixel viewport has no horizontal overflow, clipped actions, unreadable evidence, or unreachable controls.
- The visible canonical fingerprint agrees with the API and filesystem state before rejection, after rejection, and after repaired promotion.

### Batch 7.3: Freeze the release evidence

1. Update the README, local POC guide, PRD, outcome roadmap, security disclosure, recovery guide, demo script, and one-page architecture diagram.
2. Make the one-page architecture show the Runtime trust boundary, Candidate and Quarantine roots, journal phases, canonical manifest decision point, repair ancestry, and post-promotion outbox dispatch.
3. Add a judge checklist mapping the four published judging categories to live product evidence and automated checks.
4. Add a fresh-clone rehearsal procedure that distinguishes the free deterministic demo from the pending organizer-credential ModelArk conformance run.
5. Resolve the final P0 cutoff Wayfinder decision with a requirement-by-requirement evidence table.

### Phase 7 exit gate

- A clean temporary clone installs dependencies, runs `npm run demo`, reaches the seeded hero path, and passes `npm run check:phase7` without undocumented state.
- The full browser story finishes under three minutes from the first visible interaction.
- Tracked Markdown links, credential-pattern scan, Git whitespace, Docker Compose rendering, Terraform formatting, build, typecheck, server tests, production Chrome tests, real local validation-container tests, dependency audit, and repeated-run stability all pass.
- Architecture, UI, persisted evidence, and demo narration use the same state names and guarantees.
- No paid inference request has been made, and live ModelArk conformance remains explicitly pending organizer credentials.
- Git contains one Phase 7 commit pushed to `origin/main`.

### Phase 7 commit

`chore: ship the judge-ready Airlock release`

## Risks and mitigations

### Stale Quarantine overwrites newer accepted work

Mitigation: require exact source canonical state identifier and composite fingerprint equality before a repair is scheduled or promoted.

### Rejected External Action Intents replay during repair

Mitigation: repair copies workspace and Agent memory but creates a fresh empty outbox, and the bounded prompt tells the Agent to intentionally resubmit any still-valid effect.

### Crash recovery creates split truth between files and JSON metadata

Mitigation: make the platform-owned promotion journal monotonic, reconcile physical truth first, and then idempotently repair metadata.

### Journal stores sensitive Runtime content

Mitigation: retain identifiers, hashes, bounded redacted evidence, intent identity, and phase metadata only.

### Retention deletes useful or active state

Mitigation: confine cleanup to fixed platform roots, protect active Run identifiers, test unrelated sentinel files, and keep canonical versions outside eligible roots.

### Fixture demo is mistaken for live ModelArk conformance

Mitigation: label fixture mode in the UI, terminal, README, demo script, and final evidence, while keeping a separate credentialed conformance checklist.

### Later polish weakens an earlier guarantee

Mitigation: every phase check includes all prior checks, and each phase must be committed and pushed before later work begins.

## Final verification sequence

1. Run `npm run check:phase7` twice from a clean application state.
2. Run the opt-in Codex session and real validation-container probes.
3. Run the full production Chrome journey at desktop and mobile widths and inspect captured screenshots.
4. Run the crash matrix with every injected phase and two consecutive startup reconciliations.
5. Run path traversal, symlink, corrupt-state, secret redaction, output bound, cancellation, timeout, retention, repair-depth, stale-repair, duplicate-discard, and duplicate-delivery cases.
6. Render Docker Compose configuration and run Terraform formatting validation through the available local or pinned container toolchain.
7. Scan tracked files and Git history for credential signatures and scan tracked Markdown for broken relative links.
8. Perform the fresh-clone `npm install`, `npm run demo`, and `npm run check:phase7` rehearsal in a temporary directory.
9. Verify a clean working tree, three phase commits, and `origin/main` at the same commit.
10. Record the no-cost completion evidence and the separate pending organizer-credential ModelArk gate on the Wayfinder map.

## Stop conditions

Do not allow a Repair Run to promote over a Canonical State that changed after its parent was quarantined.
Do not reuse a rejected outbox automatically.
Do not accept more than one active child per repair parent or exceed the configured depth.
Do not infer successful promotion from JSON metadata when the canonical manifest and immutable resource fingerprints disagree.
Do not delete a path derived from an API payload, stored `quarantinePath`, unresolved symlink, glob, or environment-variable expansion.
Do not claim arbitrary-provider exactly-once delivery, unrestricted network containment, production multi-process safety, or live ModelArk conformance.
Do not begin the next phase while the current phase's browser, safety, documentation, Git, and Wayfinder gates are incomplete.
