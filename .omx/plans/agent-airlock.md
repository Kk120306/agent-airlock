# Agent Airlock implementation plan

## Requirements summary

Agent Airlock must extend the CodeJam starter kit without replacing its React UI, Fastify control plane, Agent lifecycle, Codex Runtime, or local container path.
Every Agent Run must execute against Candidate State, and only a candidate satisfying its versioned Outcome Contract may become Canonical State.
The POC must demonstrate transactional workspace and Codex session behavior, a SQLite Transactional Resource, a deferred mock External Action Intent, quarantine, repair, recovery, and evidence.

This plan is frozen for judging by [ADR 0009](../../docs/adr/0009-freeze-the-judge-release-boundary.md).

## Outcome sequence

Implementation follows the [outcome roadmap](../../docs/product/OUTCOME_ROADMAP.md).
A later phase does not enter the judging path until the previous phase's automated, user-visible, and reproducibility gates pass.

| Outcome phase | Implementation steps | Required result |
| --- | --- | --- |
| 0. Baseline locked | Baseline acceptance before Step 1 | The starter browser, Runtime, persistence, and follow-up journey is repeatable. |
| 1. Harmless failure | Steps 2 through 4 | Rejection leaves the canonical content hash unchanged. |
| 2. Explainable decision | Steps 5 and 8 | The operator can understand the contract, evidence, and disposition. |
| 3. Whole-Agent continuity | Steps 3, 4, and 6 | Workspace and Codex session advance or remain unchanged together. |
| 4. Transactional effects | Step 7 | Files, SQLite, and deferred actions share one coherent decision. |
| 5. Recoverable intelligence | Steps 6 and 8 | A quarantined future can be repaired without premature canonical mutation. |
| 6. Adversarial resilience | Steps 5, 6, and 9 | Crash, bypass, cleanup, and replay tests fail closed. |
| 7. Judge-ready release | Step 9 | The complete product is reproducible and demonstrable within three minutes. |

Phases 8 through 11 are post-hackathon outcomes and must not expand the implementation scope before submission.
Their isolated execution record is maintained in [the Phase 8 through 11 plan](phases-8-11-execution.md).
Phase 9 Competing Futures is implemented on the post-hackathon branch without changing this frozen Phase 7 judging plan.

## Acceptance criteria

1. The baseline create, invoke, follow-up, stop, restart, and persistence journey continues to work through the browser.
2. The container Runtime receives a Candidate State workspace path and never a writable Canonical State workspace path.
3. A valid Run that passes every required Validation advances the Canonical State identifier exactly once.
4. A Run that deletes a required file reaches `quarantined` and leaves the canonical workspace content hash unchanged.
5. A cancelled or timed-out Run leaves the canonical workspace and Codex session identifiers unchanged.
6. A rejected SQLite mutation leaves canonical query results unchanged.
7. A promoted External Action Intent is delivered once when the mock consumer receives duplicate dispatch attempts with the same idempotency key.
8. A rejected External Action Intent is delivered zero times.
9. A Repair Run begins from a selected Quarantine and does not change Canonical State until it passes.
10. Restart reconciliation resolves every simulated interruption point around promotion without losing the last confirmed Canonical State.
11. Validation output and evidence are bounded and redact configured sensitive patterns.
12. Path traversal and symlink attempts cannot escape Candidate State.
13. The complete normal, rejection, and recovery scenario fits within three minutes.
14. `npm run check:phase7` passes from the working repository and a clean temporary clone.

## Implementation steps

### 1. Freeze the Wayfinder decisions

Resolve the decision tickets linked from the [Agent Airlock Wayfinder map](https://github.com/Kk120306/agent-airlock/issues/1).
Update `docs/product/PRD.md`, `docs/architecture/agent-airlock.md`, `CONTEXT.md`, and ADRs as each decision closes.

Verification:

- No open decision affects P0 interfaces, lifecycle states, storage layout, or acceptance criteria.
- The map's Not yet specified section contains no unresolved work required by the destination.

### 2. Add the transactional data model and version migration

Extend `apps/server/src/types.ts:1` with Run Transaction dispositions, Outcome Contracts, Validations, state-version references, Quarantine metadata, repair ancestry, and Promotion Receipts.
Upgrade the versioned JSON schema in `apps/server/src/store.ts` with a tested migration from the starter kit's version 1 data.
Extend Web types in `apps/web/src/types.ts` from the same documented contract.

Verification:

- Existing version 1 fixtures migrate without losing Agents, messages, or Runs.
- Invalid lifecycle transitions and unknown contract versions are rejected.
- Serialization round trips preserve every Airlock evidence field.

### 3. Introduce versioned state resolution without changing the Playground

Refactor `apps/server/src/workspace.ts:5` so callers resolve Canonical State through one state registry rather than storing a mutable physical workspace as truth.
Create Candidate State and Quarantine roots outside the Runtime-visible canonical path.
Keep Agent creation, editing, archival, and workspace instructions behavior compatible with existing routes.

Verification:

- Existing Agents receive an initial canonical state version during migration.
- Candidate preparation does not mutate the source version.
- Deleting an Agent follows an explicit policy for canonical versions and quarantines.

### 4. Build the Airlock runner seam as the first vertical slice

Wrap the existing `AgentRunner` interface at `apps/server/src/types.ts:78` with Candidate State preparation and terminal disposition.
Change the call at `apps/server/src/agent-service.ts:247` to use Airlock evidence while preserving one active Run per Agent.
Pass Candidate workspace and session paths into both Runtime implementations.
Update the writable mounts at `apps/server/src/container-codex-runner.ts:79` so no Canonical State resource is exposed as writable.

Verification:

- A fake inner runner can modify Candidate State and promotion makes the result canonical.
- A fake inner runner failure leaves the canonical content hash unchanged.
- Local-process and container argument tests prove that only Candidate State paths are used.

### 5. Implement Outcome Contracts and constrained Validation

Add deterministic validation for containment, symlinks, protected paths, required paths, change limits, secret patterns, and operator-defined commands.
Run project validation commands in a constrained container rather than on the host.
Persist bounded redacted evidence before beginning promotion.

Verification:

- Each validator has positive and negative behavioral tests.
- A malicious symlink fixture cannot expose or modify a path outside Candidate State.
- A validation command that hangs is terminated and reported without affecting Canonical State.
- Redaction tests cover Ark-style keys, bearer tokens, and configured custom patterns.

### 6. Add recoverable Promotion, Quarantine, and Repair Run behavior

Implement the chosen promotion mechanism with an idempotent promotion journal.
Reconcile interrupted preparation, validation, and promotion during `AgentService.initialize()` at `apps/server/src/agent-service.ts:20`.
Add Quarantine inspection, discard, and Repair Run operations to the service and Fastify routes in `apps/server/src/app.ts`.

Verification:

- Fault injection at every journal phase converges to one documented terminal state after restart.
- Repeating promotion or discard requests is safe.
- A Repair Run uses the quarantined candidate and records ancestry.

### 7. Prove multiple Transactional Resources

Implement a SQLite resource fixture whose candidate database is isolated and whose promoted version follows Canonical State.
Implement typed External Action Intents and an idempotent mock dispatcher.
Document the network-egress bypass limitation and keep the mock external resource outside the candidate workspace.

Verification:

- Promoted and rejected database mutations produce the expected canonical queries.
- Duplicate dispatcher attempts produce one mock external effect.
- Rejected or discarded candidates produce no mock external effect.

### 8. Add the minimum Airlock operator experience

Extend polling from `apps/web/src/App.tsx:204` and the active Run presentation with preparation, execution, validation, promotion, and quarantine states.
Add a compact change summary, failed-Validation evidence, Quarantine actions, and Repair Run entry point.
Keep the Playground as the main surface and avoid a separate administration application.

Verification:

- Browser E2E tests cover one promoted Run, one quarantined Run, discard, and Repair Run.
- The UI communicates why Canonical State did or did not change.
- Keyboard navigation, focus states, loading states, and error states are usable.

### 9. Harden cleanup, evidence, and demonstration fixtures

Add configurable Candidate and Quarantine retention with protection for the current Canonical State.
Finalize the Promotion Receipt and architecture diagram.
Create deterministic success, destructive, SQLite, outbox, repair, and restart fixtures.
Rehearse `docs/demo/three-minute-demo.md` against the local container path.

Verification:

- Cleanup cannot remove the current Canonical State or an active Candidate State.
- The baseline and Airlock E2E suites pass repeatedly without flakiness.
- Repository setup contains no credential or sensitive demo output.
- `npm run check` passes from a clean clone.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex session files cannot be safely copied while a thread is active. | Use per-Agent versioned Codex homes, never copy during execution, and validate the pinned CLI behavior before freezing the storage design. |
| Promotion cannot be atomic across several filesystem roots. | Use one durable canonical manifest or pointer over immutable resource versions and reconcile from a journal. |
| Validation commands execute malicious project code. | Run them inside a constrained container with bounded time, output, mounts, and credentials. |
| Copying large workspaces makes Run preparation slow. | Measure fixture performance, use copy-on-write or hard-link strategies only after correctness, and expose preparation duration. |
| The Agent bypasses the outbox through unrestricted network access. | Scope the POC claim to platform-controlled actions, disclose the bypass, and add egress restrictions only if the core path is stable. |
| A manual override weakens the safety claim. | Exclude promotion of a failed hard Validation from P0. |
| The new lifecycle breaks baseline Run polling. | Preserve existing terminal semantics at the HTTP boundary and add browser E2E regression coverage. |

## Verification commands

```bash
npm ci
npm run check
```

Run the browser acceptance journey through `npm run poc` with valid Ark credentials and a supported container engine.
Run fault-injection integration tests without Ark credentials by using fake AgentRunner and Transactional Resource implementations.

## Stop conditions

- Stop before implementation if session isolation cannot preserve both accepted conversation continuity and rejected-Run separation.
- Stop promotion work if the chosen state model cannot recover deterministically from every simulated crash point.
- Do not add remote providers until local workspace, session, SQLite, and outbox behavior meet the Phase 4 exit gate.
- Do not weaken a failed required Validation into a warning to make the demo pass.
- Do not begin a later outcome phase while an earlier phase has failing acceptance evidence.
