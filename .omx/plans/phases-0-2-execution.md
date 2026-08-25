# Agent Airlock Phases 0 through 2 execution plan

## Requirements summary

Implement the qualifying proof from the [outcome roadmap](../../docs/product/OUTCOME_ROADMAP.md) as three independently verified commits.
Phase 0 locks the starter-kit journey against regression.
Phase 1 makes rejected workspace changes harmless through Candidate State and recoverable Promotion or Quarantine.
Phase 2 makes the decision explainable through a versioned Outcome Contract, deterministic Validations, bounded evidence, and the minimum Playground presentation.

The real ModelArk browser journey remains a manual acceptance gate because this checkout does not currently contain `ARK_API_KEY` or `ARK_MODEL`.
The automated baseline must therefore use the real browser, HTTP API, service, persistence, workspace, and runner boundaries with a deterministic Codex protocol fixture.

## Phase 0: Baseline locked

### Outcome

A regression suite proves that the starter browser journey, Agent lifecycle, workspace persistence, and Codex thread continuation remain intact before transactional behavior is introduced.

### Implementation actions

1. Add Playwright configuration at `playwright.config.ts` using a deterministic local production server and an installed Chrome channel.
2. Add a protocol-faithful fake Codex executable under `tests/fixtures/` that writes real workspace files, emits Codex JSON events, and resumes a stable thread.
3. Add a browser acceptance test under `tests/e2e/` covering Agent creation, first task, assistant response, follow-up continuation, stop, start, and page reload.
4. Add a server acceptance test under `apps/server/src/` that recreates `AgentService` over the same JSON store and workspace, then proves messages, Runs, workspace files, and the thread identifier survive restart.
5. Add explicit `test:e2e` and `check:phase0` scripts without weakening the starter `npm run check` path.
6. Document the deterministic and real-ModelArk acceptance commands.

### Exit gate

- The Playwright journey passes through the production React bundle and Fastify API.
- The fake Codex fixture receives `null` on the first thread and the promoted baseline thread on follow-up.
- Restart preserves the Agent, workspace files, messages, Runs, and thread identifier.
- Stop and start preserve the workspace.
- `npm run check:phase0` passes.
- `npm audit` reports zero known vulnerabilities.
- The live ModelArk browser acceptance is run when local credentials are available.

### Commit

`test: lock the Phase 0 baseline journey`

## Phase 1: Harmless failure

### Outcome

Every Agent Run writes only to isolated Candidate State, a passing candidate becomes a new immutable canonical version, and a rejected candidate leaves the prior canonical fingerprint unchanged.

### Decision to implement

Use immutable per-Agent version directories and an atomically replaced `canonical.json` manifest.
Prepare a candidate by copying the current canonical workspace to a run-owned directory on the same filesystem.
On Promotion, move the candidate workspace into a new immutable version directory before atomically replacing the canonical manifest.
On rejection, move the candidate into Quarantine and retain the previous manifest.

This design makes future multi-resource Promotion possible without exposing a mutable canonical path to the Runtime.

### Implementation actions

1. Extend `apps/server/src/types.ts` with canonical state identifiers, Run Transaction lifecycle data, dispositions, and bounded workspace change evidence.
2. Upgrade `apps/server/src/store.ts` to database version 2 with a tested migration from the starter version 1 document.
3. Refactor `apps/server/src/workspace.ts` into the state registry for initial state creation, legacy adoption, Candidate State preparation, canonical hashing, Promotion, Quarantine, cancellation cleanup, and Agent archival.
4. Add an Airlock execution seam around the existing `AgentRunner` so only a Candidate State workspace path reaches `CodexRunner` or `ContainerCodexRunner`.
5. Update `apps/server/src/agent-service.ts` to persist Run Transaction progress and update the Agent's canonical state reference only after Promotion.
6. Add behavioral tests for success, destructive rejection, runtime failure, cancellation, migration, and container argument isolation.
7. Resolve the Canonical State Wayfinder decision with the implemented evidence and record the hard-to-reverse choice in an ADR.

### Exit gate

- A successful Run advances the canonical state identifier once.
- A Run that removes `AGENTS.md` is quarantined.
- The canonical content hash is identical before and after rejection.
- Runtime failure and cancellation do not change the canonical identifier or fingerprint.
- The inner runner receives a path under the Candidate State root and never the canonical workspace path.
- Existing version 1 data migrates without losing Agents, messages, or Runs.
- The baseline browser and restart suite still passes.
- `npm run check` passes.

### Commit

`feat: make Phase 1 workspace failures harmless`

## Phase 2: Explainable decision

### Outcome

The operator can see what changed, which Outcome Contract version was applied, how each Validation concluded, and why the Run was promoted or quarantined.

### Decision to implement

Outcome Contract version 1 is a bounded data contract rather than a general policy language.
It supports protected and required path patterns, maximum changed files, maximum added bytes, named secret patterns, and named command Validations.
Required structural Validations run in process over Candidate State.
Agent-project commands run without network or credentials inside a constrained Runtime container.

### Implementation actions

1. Add the versioned Outcome Contract to Agent persistence and API types with conservative defaults.
2. Add deterministic workspace inventory and change calculation before Promotion.
3. Implement containment, symlink, protected-path, required-path, change-count, added-byte, secret-pattern, and command Validations in the documented order.
4. Bound evidence by duration, byte count, entry count, and redaction before persistence.
5. Add a constrained command executor using the configured container engine with no network, no credentials, dropped capabilities, resource limits, and Candidate State as the only project mount.
6. Extend Fastify responses, web types, and the existing Playground with a compact Airlock timeline, canonical fingerprint, change summary, Outcome Contract version, and decisive failed Validation.
7. Add unit, integration, API, and browser coverage for promoted and quarantined outcomes, contract versioning, evidence bounds, redaction, symlink rejection, and command timeout.
8. Resolve the Outcome Contract and Validation containment Wayfinder decisions with implemented evidence.

### Exit gate

- The decisive failed Validation is visible without inspecting server logs.
- Persisted evidence, API disposition, and Playground presentation agree.
- Protected-path, required-path, limit, secret, symlink, and command failures all prevent Promotion.
- Validation command output and duration are bounded.
- Secret evidence names the pattern and path without storing the matched value.
- Updating an Outcome Contract creates a new version that affects future Runs only.
- The Phase 0 browser journey and Phase 1 canonical fingerprint tests remain green.
- `npm run check`, `npm run test:e2e`, and `npm audit` pass.

### Commit

`feat: explain Phase 2 promotion decisions`

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A process interruption occurs between moving a candidate and replacing the canonical manifest. | Move into an immutable version first and treat the manifest as the only canonical decision; full journal reconciliation remains Phase 6. |
| Copying a large workspace is slow. | Measure preparation duration and preserve correctness first; copy-on-write optimization remains a later phase. |
| A validation command mutates or escapes the candidate. | Execute it in a container with no network, dropped capabilities, bounded resources, and no canonical mount. |
| Persisted output leaks a credential. | Redact before persistence, store only bounded output, and test Ark-style and bearer-token patterns. |
| Browser E2E becomes flaky. | Use a deterministic Codex protocol fixture, one worker, stable accessible selectors, and explicit disposition assertions. |
| Real ModelArk behavior differs from the fixture. | Keep a separate credentialed browser acceptance command and do not claim that gate passed until it is run. |

## Verification sequence

Run these checks after every phase commit:

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
npm audit
git diff --check
```

After Phase 2, run the credentialed local POC and repeat the documented browser acceptance journey with ModelArk.

## Execution evidence

Phase 0 was committed as `5856442` after the production browser baseline, restart persistence, type checks, build, and dependency audit passed.
Phase 1 was committed as `e88690d` after Promotion, Quarantine, runtime failure, cancellation, legacy migration, immutable-version, and browser regression checks passed.
Phase 2 passes 46 server tests with one opt-in container test skipped in the ordinary suite.
The production Playwright journey covers Promotion, destructive Quarantine, unchanged Canonical State, matching API evidence, recovery, lifecycle controls, and reload persistence.
The opt-in validation-container suite passes three tests against the built `volc-agent-runtime:local` image, including the real Docker boundary.
The Phase 2 check includes type checks, all ordinary server tests, production builds, the browser journey, and an audit reporting zero known vulnerabilities.
The external credentialed ModelArk browser journey remains pending until `ARK_API_KEY` and `ARK_MODEL` are available locally.

The final qualifying audit was repeated on 2026-08-25 after the judging documentation was aligned to implemented Phase 2 behavior.
`npm run check:phase2` passed with 46 server tests, one intentionally skipped opt-in test, one production-browser journey, successful builds, and zero reported dependency vulnerabilities.
`npm run test:validation-container` passed all three real-container isolation tests.
All relative Markdown links resolve across the tracked documentation, `.env` is ignored, and a history scan found no private-key, GitHub-token, AWS-access-key, or JWT signatures.
The repository now includes a one-page trust-boundary architecture and a three-minute live script that does not claim later SQLite, outbox, Repair Run, transactional-session, or crash-journal features.

## Credentialed acceptance status

A real production-browser attempt on 2026-08-25 reached the container Runtime and ModelArk data-plane API without exposing or committing the configured credential.
The first attempt proved that the self-service BytePlus key did not belong to the starter default's mainland Volcengine region.
After configuring the correct BytePlus Asia Pacific base URL, authentication succeeded but the supplied `ARK_MODEL` was not an accessible model or endpoint.
A bounded probe of BytePlus's documented direct model returned `ModelNotOpen`, confirming that the account has no compatible model activated.
No billable model inference completed, both failed Runtime Runs were quarantined, and Canonical State remained unchanged.
The operator elected not to activate a paid model and will wait for organizer-provided credentials.
The live ModelArk Promotion and destructive-Quarantine journey therefore remains the only pending gate.

## Stop conditions

- Stop Phase 1 if the Runtime can still receive any writable canonical workspace path.
- Stop Phase 1 if rejection can alter the canonical manifest or fingerprint.
- Stop Phase 2 if evidence must be persisted before redaction or without hard size bounds.
- Stop Phase 2 command work if the container would receive the Ark key, host workspace, canonical state, or network access.
- Ask the user for environment setup only when the remaining unverified requirement is the credentialed ModelArk journey.
