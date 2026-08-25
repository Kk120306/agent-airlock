# Agent Airlock Phases 3 and 4 execution plan

## Requirements summary

Implement the next two podium-target phases from the [outcome roadmap](../../docs/product/OUTCOME_ROADMAP.md) as independently verified, committed, and pushed product increments.
Phase 3 must make the Agent workspace and Codex conversation one accepted future, so rejected reasoning cannot leak into the next turn.
Phase 4 must prove the abstraction across files, one SQLite database, and one deferred external action, so all three resources receive one understandable disposition.

No paid ModelArk activation or inference is required for either automated gate.
The deterministic Codex protocol fixture, the pinned local Runtime image, and a mock external-action consumer provide the qualifying evidence while organizer credentials are pending.
The credentialed ModelArk browser journey remains a final manual conformance check after organizer-provided `ARK_API_KEY` and `ARK_MODEL` values are available.

## Invariants shared by both phases

1. A Runtime may receive writable Candidate State paths but must never receive a writable Canonical State workspace, Codex home, SQLite database, or outbox path.
2. `canonical.json` is the single authority for the accepted state version, resource paths, resource fingerprints, and canonical Codex thread identifier.
3. The JSON application store may cache canonical references for API compatibility, but restart reconciliation must overwrite those caches from the canonical manifest.
4. A rejected, cancelled, timed-out, or failed Run must not change the canonical manifest.
5. Promotion may expose a new canonical state only after required Validation succeeds.
6. External delivery may begin only after Promotion makes the intent canonical.
7. Every persisted or displayed resource summary must be bounded, deterministic, and free of credentials.
8. Legacy Phase 0 through 2 data must migrate without losing Agents, messages, Runs, or workspace files.
9. The existing create, invoke, follow-up, stop, restart, and persistence journey must remain intact.

## Pinned Codex storage finding

The production Runtime image pins Codex CLI `0.111.0`.
A network-disabled probe against that exact image showed that a started turn writes a rollout JSONL file, a shell snapshot, and Codex state files under `CODEX_HOME` before inference completes.
Copying that complete home to a separate directory allowed `codex exec resume` to retain the original thread identifier and mutate only the copy.
Using an empty home with the same requested thread identifier started a different thread instead of continuing the accepted one.

This evidence makes `CODEX_HOME` a transactional resource rather than a shared configuration directory.
The global generated Codex home will remain a platform-owned configuration template only.

## Phase 3: Whole-Agent continuity

### Outcome

The accepted workspace and accepted Codex conversation advance together on Promotion and remain together on rejection, cancellation, timeout, Runtime failure, and restart.

### State layout

Each immutable version and each Candidate State will contain the same pair of writable Runtime resources.

```text
workspaces/<agent-id>/versions/<state-id>/
  workspace/
  codex-home/
  candidate.json

workspaces/.candidates/<run-id>/
  workspace/
  codex-home/
  candidate.json
```

The versioned canonical manifest will record the workspace path, Codex home path, canonical thread identifier, workspace hash, Codex-session hash, and composite state hash.
Promotion will rename the complete Candidate State root into the immutable version directory before atomically replacing the manifest.
Quarantine will rename the same complete Candidate State root into the quarantine directory.

### Chunk 3.1: Version the real Codex session boundary

1. Extend `apps/server/src/types.ts` so a canonical reference includes the Codex home path, thread identifier, workspace hash, session hash, and composite hash.
2. Upgrade `apps/server/src/workspace.ts` to canonical manifest schema 2 and Candidate manifest schema 2.
3. Seed new per-Agent Codex homes from the platform-generated `config.toml` without copying credentials.
4. Refresh only the platform configuration file when preparing a candidate, while preserving the candidate copy of accepted session data.
5. Migrate schema 1 manifests by preserving the immutable workspace, copying the matching legacy rollout and shell snapshot when they exist, and retaining the legacy thread only when its session artifact is found.
6. Add database version 4 migration fields for session evidence without rewriting historical decisions as if they had Phase 3 evidence.

Verification:

- An initial state has distinct canonical workspace and Codex home paths under the same immutable version root.
- Preparing a candidate copies both resources and never returns a canonical path.
- A schema 1 manifest migrates idempotently.
- A legacy thread with no matching session artifact resets safely instead of pretending continuity exists.
- The composite canonical fingerprint changes when either accepted resource changes.

### Chunk 3.2: Route every Runtime through Candidate State

1. Add `codexHomePath` to `RunnerRequest` and pass the Candidate State path through `apps/server/src/airlock-runner.ts`.
2. Set `CODEX_HOME` to the candidate path in `apps/server/src/codex-runner.ts`.
3. Bind-mount the candidate Codex home at `/codex-home` in `apps/server/src/container-codex-runner.ts`.
4. Remove the global generated Codex home from all writable Runtime arguments.
5. Record the thread returned by Codex into the Candidate manifest before Validation and Promotion.
6. Derive the next Run's thread identifier from the canonical manifest and reject inconsistent cached Agent metadata.

Verification:

- Local-process runner tests prove that `CODEX_HOME` is the requested candidate path.
- Container argument tests prove that both writable mounts are candidate-owned and that neither canonical path nor the global template path is mounted.
- A returned thread identifier remains candidate-only until Promotion.
- Cancellation and Runtime failure dispose of the candidate session with the candidate workspace.

### Chunk 3.3: Prove accepted and rejected memory behavior

1. Make `tests/fixtures/fake-codex.mjs` persist a protocol-faithful session record in the supplied Codex home.
2. Make the fixture require the accepted record when resuming a thread.
3. Make the destructive turn write a unique rejected-reasoning marker before triggering a protected-path failure.
4. Make the next safe turn fail if it can observe that rejected marker.
5. Extend unit, restart, and Playwright coverage to inspect session hashes, paths, thread identifiers, and quarantined session evidence.
6. Present a compact workspace plus session disposition in the existing Airlock evidence card.

### Phase 3 exit gate

- A promoted Run is understood by the next turn through the same accepted thread and accepted session artifact.
- A rejected Run's files and reasoning are both present in Quarantine but absent from the next candidate.
- A cancelled, timed-out, or failed Run leaves the canonical composite fingerprint and thread unchanged.
- Restart reconciliation restores the last confirmed workspace path, Codex home path, state identifier, and thread identifier from one canonical manifest.
- The Runtime receives no writable canonical workspace or canonical session path.
- The browser journey visibly shows whether workspace and session advanced or remained unchanged together.
- All type checks, unit tests, builds, browser tests, migration tests, container argument tests, and the real validation-container suite pass.

### Phase 3 stop conditions

Do not begin Phase 4 if a rejected-memory marker reaches the following turn, a restart trusts stale JSON-store session metadata over the manifest, or any Runtime argument contains a canonical resource path.
Do not claim real ModelArk continuity until the organizer credential journey runs successfully.

### Phase 3 commit

`feat: make Agent continuity transactional`

## Phase 4: Transactional effects

### Outcome

One Agent task can edit files, update one SQLite database, and prepare one typed external action, and Promotion accepts all three or rejection accepts none.

### Resource contract

The POC will implement three resource adapters behind one Run Transaction summary.

| Resource | Candidate representation | Validation | Promotion or rejection behavior |
| --- | --- | --- | --- |
| Workspace | Candidate `workspace/` tree | Existing Outcome Contract | Version root is promoted or quarantined. |
| SQLite | `workspace/.airlock/demo.sqlite` | Size limit, SQLite integrity, schema allowlist, and deterministic query snapshot | The database crosses with the workspace version or remains canonical. |
| External action | `workspace/.airlock/outbox.jsonl` containing typed intents | JSON schema, count and byte limits, supported action type, stable intent ID, and payload limits | Canonical intents dispatch only after Promotion, while rejected intents produce no delivery. |

The initial supported action type will be `demo.notification.requested` with a short destination, subject, and body.
It represents a real irreversible boundary without contacting a third-party service.
The mock consumer will persist deliveries outside Agent-controlled state and enforce uniqueness by idempotency key.

### Chunk 4.1: Add the SQLite Transactional Resource

1. Create a platform-owned SQLite resource adapter under `apps/server/src/` using the supported `node:sqlite` API.
2. Seed `.airlock/demo.sqlite` for every new Agent with a small documented inventory table and deterministic starter row.
3. Preserve or initialize the database during legacy migration.
4. Validate the candidate database read-only after Runtime exit with a size cap, `PRAGMA integrity_check`, an allowed schema, and bounded query evidence.
5. Record before and candidate query snapshots and whether the database advanced in the Run Transaction.
6. Add SQLite status to the Airlock evidence card without rendering arbitrary database contents.

Verification:

- A promoted mutation changes the canonical query snapshot.
- A rejected mutation is retained in Quarantine while the canonical query snapshot remains byte-for-byte equivalent.
- A malformed, oversized, or unexpected-schema database blocks Promotion with bounded evidence.
- A restart reads the same accepted SQLite state through the canonical manifest.

### Chunk 4.2: Add typed deferred External Action Intents

1. Define a versioned JSONL submission contract at `.airlock/outbox.jsonl` and document it in the generated `AGENTS.md`.
2. Parse and validate intents only in the control plane after Runtime execution.
3. Derive an idempotency key from the promoted Run Transaction identifier, intent identifier, action type, and normalized payload hash.
4. Persist mock deliveries in a platform-owned atomic store under `APP_DATA_DIR`, outside every Runtime mount.
5. Dispatch only after the canonical manifest has advanced to the intent's candidate state.
6. Make duplicate dispatch attempts return the original receipt without repeating the mock effect.
7. Persist bounded delivery receipts and resource disposition in the Run Transaction.
8. State clearly in the UI and architecture documentation that unrestricted Agent network egress can bypass this outbox.

Verification:

- A rejected or discarded intent creates zero mock deliveries.
- A promoted intent creates one mock delivery.
- Two or more dispatch attempts with the same idempotency key still create exactly one delivery.
- Invalid intent JSON, duplicate intent IDs, unsupported types, oversize payloads, and too many intents block Promotion.
- The Runtime cannot read or write the delivery store.

### Chunk 4.3: Deliver the all-or-nothing judging story

1. Extend the deterministic Codex fixture with one accepted multi-resource request and one destructive multi-resource request.
2. In the accepted request, edit a file, update the inventory row, and enqueue a notification.
3. In the rejected request, edit a file, mutate the database, enqueue a different notification, and violate a required path.
4. Extend the production Playwright journey to prove the accepted file, database snapshot, and delivery receipt, followed by an unchanged canonical file, unchanged database snapshot, and zero rejected delivery.
5. Show one three-resource disposition panel so a judge can understand the result without inspecting logs or raw state files.
6. Update the PRD, roadmap status, architecture document, one-page diagram, demo script, and Wayfinder decisions to distinguish implemented guarantees from the network-egress residual risk.

### Phase 4 exit gate

- A rejected SQLite mutation leaves the canonical query result unchanged.
- A rejected or discarded intent causes zero mock effect.
- A promoted intent is delivered exactly once under duplicate dispatch attempts.
- Workspace, SQLite, and external action evidence display one coherent promoted or quarantined disposition.
- The three-minute browser story completes one accepted all-resource transaction and one rejected all-resource transaction.
- The product discloses that unrestricted network access can bypass the controlled outbox.
- All Phase 3 gates remain green.
- `npm run check`, `npm run test:e2e`, `npm audit`, the real validation-container suite, and tracked-document link checks pass.

### Phase 4 stop conditions

Do not claim exactly-once delivery beyond the mock consumer's idempotency boundary.
Do not dispatch an intent before the canonical manifest points at its state.
Do not begin Repair Run or crash-journal scope until the Phase 4 three-resource story is green and independently committed.

### Phase 4 commit

`feat: transact Agent data and external effects`

## Final cross-phase audit

1. Run the complete production Playwright journey in installed Chrome.
2. Run all server tests, type checks, builds, script checks, and dependency audit.
3. Run the opt-in real validation-container suite.
4. Re-run path traversal, symlink, secret redaction, output bound, cancellation, timeout, restart, and migration cases.
5. Inspect the Runtime arguments to prove that every writable resource is candidate-owned.
6. Scan tracked files and Git history for common credential signatures.
7. Verify tracked relative Markdown links.
8. Verify the working tree is clean, each phase has its own commit, and both commits are pushed to `origin/main`.
9. Record test evidence and the pending organizer-credential gate on the Wayfinder map.

## Deferred scope

Repair Runs, crash-journal reconciliation, stronger network egress controls, retention automation, provider conformance, and blockchain receipt anchoring remain later roadmap phases.
They must not weaken or blur the Phase 3 and Phase 4 acceptance claims.
