# Agent Airlock - Devpost submission copy

Replace the YouTube placeholder after recording, push the final clean HEAD, and run `npm run audit:submission -- --confirm-public-revision=EXACT_GIT_SHA --confirm-video-public` before submitting.
Replace `EXACT_GIT_SHA` with the complete `sourceRevision` printed by the audit after verifying that exact revision signed out.
The submission audit reruns the complete project check and zero-network release audit before it can report `CORE READY`.

## Project title

Agent Airlock

## Tagline

Transactional execution middleware that lets Agents explore safely and makes only validated outcomes real.

## Selected track

Track 1 - Agent Launchpad: Design and Build Lightweight Agent Middleware.

## Public links

- Public code repository: [github.com/Kk120306/agent-airlock](https://github.com/Kk120306/agent-airlock)
- Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`
- One-page architecture: [view the static PNG](https://github.com/Kk120306/agent-airlock/blob/main/docs/demo/agent-airlock-one-page.png?raw=1)

## Problem

A disposable Agent container is not the same as disposable Agent state.
Persistent coding Agents also mutate workspaces, conversation memory, databases, and external-action queues that outlive one Runtime.
If execution fails after only some of those resources change, the next Run can inherit a split and unsafe reality.
Logs can explain the damage after it happens, but they cannot stop partial Agent work from becoming accepted state.

## Solution

Agent Airlock adds one transactional boundary around the CodeJam starter kit's shared `AgentRunner` seam.
Every Agent Run receives isolated Candidate State across its workspace, Codex session, SQLite snapshot, and fresh typed-action outbox.
The Runtime never receives a mutable Canonical State path.
After execution, a versioned Outcome Contract evaluates the complete Candidate with deterministic, bounded, and redacted Validations.
A passing Candidate is installed as one immutable version and an atomic canonical manifest makes it accepted reality.
An invalid Candidate is quarantined with evidence while Canonical State remains unchanged.
A bounded Repair Run can continue from that retained work with the exact failure evidence, original contract, verified Canonical reference, and a fresh outbox.
Supported external effects become claimable only after Canonical State advances during Promotion and carry stable idempotency keys.

## Why it fits Track 1

Airlock is one reusable platform-level middleware capability applied to every Agent Run, not custom logic for one Agent or a UI-only simulation.
It preserves the starter kit's Agent CRUD, lifecycle controls, Playground chat, persistent workspaces, persistent Codex sessions, model execution, Fastify control plane, and disposable local Runtime.
It extends the narrow shared execution seam where `AgentService` delegates to `AgentRunner`.
The canonical proof exercises the capability end to end through the production browser, backend, real Codex process, container, data path, Validation, Promotion, recovery, and durable evidence.

## What is innovative

Most Agent safety layers try to predict or block individual commands before execution.
Airlock instead evaluates the resulting Whole-Agent future before it becomes accepted reality.
One disposition covers files, Agent memory, SQLite data, and supported external effects, so a Run cannot promote a file while silently retaining rejected memory or data.
Quarantine is useful state rather than dead state because exact failure evidence can seed a bounded Repair child without contaminating Canonical State.
The Promotion journal makes an approved decision recoverable after interruption, and a browser-local signed decision chain lets a reviewer verify the rejected-parent to promoted-Repair lineage without uploading evidence.
Signatures remain evidence and never become Promotion authority.

## End-to-end demo

The recording begins with the selected `Real Runtime Proof` Agent visibly `READY` in the starter-kit Playground.
The Playground then invokes one real multi-resource task through the production frontend-to-Agent path.
One action creates exactly three fresh persisted Runs through React, Fastify, `AgentService`, the shared `AgentRunner` boundary, pinned Codex CLI, and a disposable container Runtime.
The first Run writes `candidate-only` to `protocol-proof.txt`, sets the `demo` inventory row in `.airlock/demo.sqlite` to `candidate-only`, and prepares the deferred `protocol-release-ready` notification.
Every required Validation passes, all four resources promote together, the Canonical fingerprint advances, and only then is the effect delivered during Promotion.
The second Run writes `unsafe-candidate` to the same file and row and prepares `protocol-unsafe`.
The required `command:protocol-content` Validation fails, so all four resources are quarantined, zero effects are delivered, and the Canonical fingerprint remains identical.
The third Run repairs that retained Candidate, restores the required file and SQLite values, uses a fresh outbox, passes every required Validation, and advances Canonical State before delivering `protocol-repair-ready` during Promotion.
The exact quarantined-parent to promoted-Repair decision chain then opens in a browser-local verifier that reports zero API calls, validates both signatures, checks the parent digest, and proves the Canonical State handoff.
The final screen shows the Agent still `READY` with `Continue in Playground` enabled, so the platform remains understandable and controllable after failure and recovery.

### Required live demo map

1. The opening frame identifies the selected runnable Agent, its `READY` lifecycle state, and its versioned Outcome Contract.
2. The production Playground invokes a real Whole-Agent task through React, Fastify, `AgentService`, and `AgentRunner`.
3. Real Codex in a disposable container mutates an isolated file, SQLite snapshot, persistent session, and deferred-action outbox.
4. Airlock displays required Validation results, four-resource dispositions, Canonical fingerprints, effect ordering, Run identifiers, receipts, and signed Repair lineage.
5. The invalid Candidate is quarantined with zero effects and an unchanged Canonical fingerprint, then a bounded Repair child recovers the retained work.
6. The closing frame verifies the signed chain locally and shows the Agent still `READY` with the Playground continuation control enabled.

## Official Track 1 rubric map

### End-to-end middleware behavior - 40%

The proof crosses the real frontend, backend, Runtime, file, SQLite, session, outbox, Validation, Promotion, Quarantine, Repair, and evidence paths.
It shows a normal case, a denial case, and a recovery case through the same reusable capability.

### Technical design and integration - 25%

Airlock wraps the starter kit's existing execution seam instead of replacing the platform.
Its trusted control plane owns the versioned Outcome Contract, durable Promotion journal, immutable state versions, and atomic canonical manifest, while the Runtime and Candidate remain untrusted.

### Verification and robustness - 20%

Automated tests cover success, rejection, Repair, restart reconciliation, interruption, tampering, redaction, stale evidence, exact Run binding, effect ordering, signed lineage, and fail-closed proof publication.
The final UI summarizes persisted evidence rather than trusting prompts or Agent narration.

### Demo and reproducibility - 15%

One command builds the production application and Runtime image, owns isolated state, opens production Chrome, creates exactly three fresh Runs, verifies the signed chain, cleans up owned processes, and enforces a hard 180-second browser-recording budget.
The canonical proof requires no credential, wallet, blockchain transaction, or paid inference.

## Impact

Agent builders gain a reusable safety boundary without rewriting each Agent or forcing operators to approve every low-level command.
Operators can inspect rejected futures, understand the decisive Validation, recover useful work, and prove that accepted state did not change.
Platform teams can add new Transactional Resource Providers behind the same lifecycle contract instead of creating resource-specific rollback logic in every Agent.
The approach is relevant to coding Agents today and generalizes to other persistent Agents that coordinate documents, records, queues, and supported external actions.

## Feasibility

The complete core proof runs locally on a laptop with Node.js, Chrome, and Docker, Colima, or Podman.
The canonical path is credential-free and deterministic because only remote inference is replaced by a local Responses-protocol fixture.
The React UI, Fastify server, `AgentService`, `AgentRunner`, pinned Codex CLI, disposable container, file and SQLite mutations, persistent session, outbox, Validation, Promotion, Quarantine, Repair, and verification paths remain real.
ModelArk is a separate optional conformance encore when free capacity is available and is not required to reproduce the Track 1 middleware behavior.
The same boundary already supports a capability-checked Transactional Resource SDK, which demonstrates a credible path from proof of concept to reusable platform middleware.

## Tools, APIs, libraries, and assets

### Starter code and Runtime

- [RrankPyramid/CodeJam](https://github.com/RrankPyramid/CodeJam) is the upstream Agent Launchpad starter kit preserved and extended by this submission.
- OpenAI Codex CLI `0.111.0` is pinned inside the disposable Runtime image.
- Docker, Colima, or Podman supplies the local disposable container path.
- Google Chrome runs the production browser proof.

### Application stack

- TypeScript `5.9` and Node.js `22` provide the application and orchestration runtime.
- React `19.2`, React DOM `19.2`, and Vite `7.2` provide the production Playground UI.
- Fastify `5.6`, `@fastify/cors`, and `@fastify/static` provide the HTTP control plane and production static serving.
- Zod `4.1` validates external and persisted data boundaries.
- Node.js built-in `node:sqlite` provides the transactional demo database.
- Node.js Crypto and browser Web Crypto provide SHA-256 commitments and Ed25519 receipt verification.
- The repository's `@agent-airlock/transactional-resource-sdk`, `@agent-airlock/http-object-resource`, and `@agent-airlock/portable-promotion-receipt` packages implement the reusable resource and evidence protocols.

### APIs and model boundary

- The canonical proof uses a repository-owned local deterministic server that implements the Responses protocol and replaces only remote inference.
- BytePlus ModelArk's Responses-compatible API is supported only by the optional credentialed conformance path.
- No ModelArk request, paid inference request, wallet request, RPC request, public blockchain transaction, or external upload occurs in the canonical recording.
- The browser-local verifier makes zero API calls after its offline boundary is armed.

### Testing and delivery tools

- Playwright `1.62` drives the production Chrome, 1280 by 720 recording gate, 390 by 844 read-only replay, and end-to-end browser assertions.
- Vitest `4.0` and Node.js built-in test runner cover server, policy, protocol, and orchestration behavior.
- GitHub Actions reruns the quality, browser, and real Runtime release gates on the published repository.
- Mermaid is used only as documentation source for the one-page architecture diagram.

### Visual and media assets

- The UI is original React and CSS created for Agent Airlock and uses system font fallbacks.
- Repository screenshots under `docs/assets` are captures of the product itself.
- No third-party stock image, video, icon pack, audio, or design template is included in the submission.

#### Devpost gallery files

Use these four checked-in product captures for the Devpost gallery:

- `docs/assets/agent-airlock-live-01-overview.jpg` shows the `READY` real-Runtime entry state and complete three-Run safety loop.
- `docs/assets/agent-airlock-live-02-quarantine.jpg` shows all four resources quarantined, zero delivered effects, and an unchanged Canonical fingerprint.
- `docs/assets/agent-airlock-live-03-verified-recovery.jpg` shows the promoted Repair and locally verified two-decision recovery chain.
- `docs/assets/agent-airlock-live-04-zero-upload-verifier.jpg` shows browser verification with zero API calls, zero uploads, two valid signatures, the parent link, and the Canonical State handoff.

### License

The repository uses the MIT License inherited from the CodeJam starter kit.

## Demo boundary

The canonical recording proves transactional Agent execution and recovery, not model quality or current live provider availability.
Only remote inference is deterministic and local.
The signed chain proves artifact integrity, signatures, lineage, and the exact Canonical State handoff.
It does not prove Runtime correctness, signer identity, organizational trust, or Outcome Contract quality by itself.
Blockchain publication is unnecessary for Promotion and is not part of the core demo.

## Reproduction

Install Node.js 22 or newer, npm 10 or newer, Google Chrome, and a running Docker-compatible engine.
Then run:

```bash
git clone https://github.com/Kk120306/agent-airlock.git
cd agent-airlock
npm ci
npm run prove:runtime -- --reset --json
npm run prove:runtime -- --reset --headed
```

The first proof warms and verifies the production application and Runtime image.
Start screen capture before the headed command, do not click or scroll, and stop after Chrome closes and the terminal prints `Real Runtime proof: PASSED`.
Use `npm run demo:runtime -- --reset` for a persistent human-driven rehearsal.

## Deliberate limitations

- Exactly-once delivery ends at the supported atomic local consumer and is not a distributed transaction with arbitrary providers.
- Unrestricted Runtime traffic outside the typed outbox is not transactionally controlled.
- The Promotion journal targets one local control-plane process and does not claim distributed consensus or power-loss durability.
- Ordinary containers are not hardened multi-tenant isolation.
- Live ModelArk capacity and model quality are not claimed by the deterministic core recording.

## Next step

The next product step is hardened network egress plus production-grade Transactional Resource Providers for durable stores and external-effect systems, all governed by the same Outcome Contract and Promotion boundary.
