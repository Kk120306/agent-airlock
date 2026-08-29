# Agent Airlock judge checklist

## Thirty-second summary

Agent Airlock is transactional middleware for persistent coding Agents.
The Agent Runtime may explore a complete future across files, memory, SQLite data, and typed external-action intents, but only the trusted Airlock control plane may promote that future after deterministic Outcome Contract validation.
Rejected futures remain inspectable, cannot alter Canonical State, and can seed a bounded Repair Run.

## Start here

Confirm Node.js 22 or newer, npm 10 or newer, installed Google Chrome, and a running Docker-compatible engine.
The canonical proof uses loopback ports 3222 and 43996 and fails closed when another proof owns its session.
Warm the application and Runtime image before recording:

```bash
npm install
npm run prove:runtime -- --reset --json
```

After the warm-up succeeds, start screen capture and run:

```bash
npm run prove:runtime -- --reset --headed
```

The runner owns both browser actions and closes Chrome automatically.
Do not click, scroll, switch tabs, or close Chrome during the canonical pass.
Stop capture after Chrome closes and the terminal prints `Real Runtime proof: PASSED`.

Phase 22 passed on this release candidate through `npm run prove:runtime -- --reset --headed`, `npm run prove:runtime -- --reset --json`, `npm run prove:runtime -- --reset --headed --json`, and `npm run audit:release`.
For a persistent stage-by-stage rehearsal, start the same product path manually:

```bash
npm run demo:runtime -- --reset
```

The canonical command uses deadline-aware presentation pacing under a hard 180-second recording budget.
A successful headed proof preserves the full 15-second opening, 85-second desktop Outcome Brief, and 25-second desktop verifier dwells plus a 5-second browser-close reserve.
Run completion is capped early enough to leave that full 115-second post-Run presentation tail and 15-second release headroom, and an insufficient remainder returns `recording-timeout` instead of shortening narration.
The deadline remains armed through browser shutdown and the actual atomic latest-pointer commit, so a late proof cannot publish.
It opens production Chrome, keeps the desktop recording at 1280 by 720 through browser close, and presents one primary action, `Prove this release is safe`.
Do not select it during the canonical headed recording.
The runner invokes it exactly once after the 15-second opening and requires exactly three fresh Runs after proof start: one valid Promotion, one destructive Quarantine, and one promoted Repair from the retained Quarantine.
Use `npm run demo:runtime -- --reset` when rehearsing the human-click path.
Do not accept evidence from a prior run, browser-local fixture state, prompt text, or Runtime narration.
The Outcome Brief must derive its claims from persisted Run evidence and show the three Run identifiers, four-resource dispositions, Canonical fingerprint transitions, failed and passed Validations, post-Promotion effects, and Repair lineage.
The final success verdict must remain unavailable until the quarantined parent and promoted Repair form a locally verified signed two-decision chain.
After the complete 85-second Outcome Brief dwell, the runner automatically selects `Inspect in zero-upload verifier` and keeps it visible for 25 seconds.
Do not select that control yourself during the canonical headed recording.
Show `0 API calls`, `2 signed decisions linked`, both signatures, the exact parent link, and the intact Canonical State handoff.
While the desktop browser remains at 1280 by 720, the runner must start a separate headless 390 by 844 read-only replay from the exact three persisted Run identifiers.
That replay must create no Run and independently regenerate the same signed chain and zero-upload verifier evidence.
The runner must produce only a content-addressed immutable result capsule plus its exact content-addressed signed chain, with mutable latest state retained only as a convenience pointer.
This path uses real Codex in a disposable Runtime container with a local deterministic Responses fixture, so it never depends on live provider capacity or claims live ModelArk conformance.

Use the deterministic fallback only when a container engine is unavailable:

```bash
npm run demo -- --reset
```

Open <http://127.0.0.1:3199> and follow the four numbered controls.
Select Promotion, Quarantine, Repair, and continuity in order, waiting for each step to complete before continuing.
Press `Ctrl+C` in the launcher terminal when the fallback recording is complete.
This remains a production-build regression and fallback fixture rather than the canonical recording.

When ModelArk free capacity is available, run the credentialed conformance proof:

```bash
npm run prove:modelark -- --reset --headed
```

The command cannot inherit the generic preflight-skip escape hatch.
It must complete a credential-safe live Responses request before it can start the application or display `LIVE MODELARK PROOF`.
The runner opens production Chrome and invokes the existing `Run live Candidate` control.
The seeded Outcome Contract requires the exact `modelark-proof.txt` content and SQLite value, so the provider response cannot prove success by narration alone.
Show the required `execution-profile` Validation, its model identifier commitment, the required state Validation, four promoted resources, one post-Promotion `modelark-live-ready` effect, the Canonical State fingerprint transition, and the locally verified signed decision.
Explain that the execution profile is a trusted Airlock control-plane attestation committed by the signed receipt, not an independent BytePlus signature.
After the live Promotion, show that the launcher reports a captured signed conformance packet, then run `npm run verify:modelark-evidence` in a separate terminal.
Explain that the offline command verifies historical signed evidence and does not claim that ModelArk is currently available.
If live interaction must remain manual, use `npm run demo:modelark -- --reset` and open <http://127.0.0.1:3201>.

## Rubric evidence

| Category | Weight | Live evidence | Automated evidence |
| --- | ---: | --- | --- |
| End-to-end middleware behavior | 40% | One action invokes real Codex for exactly three fresh Runs that promote a valid future, quarantine a destructive future, and repair the retained failure across four Candidate resources. | The Phase 22 recording gate must prove the exact fresh-Run sequence through production Chrome, while `npm run test:container-browser` and `npm run test:container-transaction` retain the underlying Runtime, restart, and continuity evidence. |
| Technical design and integration | 25% | The one-page architecture identifies the untrusted Runtime, trusted Airlock decision boundary, versioned Outcome Contract, monotonic journal, atomic canonical manifest, bounded Repair lineage, and post-Promotion dispatcher. | Server tests exercise the `AgentRunner`, `WorkspaceManager`, journal, validator, outbox, JSON store, HTTP API, and startup reconciliation seams. |
| Verification and robustness | 20% | The Outcome Brief proves harmless rejection, bounded Repair, effect ordering, and a signed two-decision chain before opening the same artifact in a zero-upload verifier. | Existing transactional and Portable Trust gates remain required, and Phase 22 must add safe-capsule, chain, viewport, fresh-Run, failure-class, and cleanup coverage. |
| Demo and reproducibility | 15% | One command opens the 1280 by 720 recording, one action runs the complete story, and a separate read-only replay proves the result at 390 by 844. | The Phase 22 runner must enforce the hard 180-second budget and fail closed on startup, browser, Run, replay, evidence, viewport, timeout, and interruption faults without overwriting the last successful immutable artifact pair. |

## Acceptance checklist

- [x] On the exact submission revision, `npm run prove:runtime -- --reset --headed` finishes under the hard 180-second recording budget, keeps production Chrome at 1280 by 720, and exposes one primary `Prove this release is safe` action.
- [x] The UI visibly says `REAL RUNTIME PROOF`, identifies the local deterministic Responses fixture, and makes no ModelArk or paid-inference claim.
- [x] One action creates exactly three fresh Runs after proof start and never reuses old evidence.
- [x] Run 1 ends in `Promoted`, `Journal completed`, four promoted resources, and one delivered effect after Promotion.
- [x] Run 2 ends in `Quarantined`, identifies the decisive required Validation failure, and shows identical before and after Canonical fingerprints.
- [x] The rejected SQLite value and unsafe notification do not reach accepted state.
- [x] Run 3 ends in a promoted child with bounded parent lineage, a fresh accepted effect, and four promoted resources.
- [x] The evidence-derived Outcome Brief names all three fresh Run identifiers and does not rely on Runtime narration or staged frontend state.
- [x] The final verdict appears only after the signed two-decision chain verifies both signatures, parent linkage, and Canonical State handoff.
- [x] `Inspect in zero-upload verifier` reports `2 signed decisions linked` while a deny-all HTTP and WebSocket boundary proves zero API calls or uploads from before the first verifier opening through browser close.
- [x] The successful runner installs an owner-only content-addressed immutable result capsule and signed chain, then atomically commits mutable `real-runtime-proof.latest.json` only as a convenience pointer while proof ownership remains held.
- [x] The hosted release resolver validates the latest pointer and uploads only the exact immutable capsule and chain it identifies.
- [x] Every failure class returns nonzero, closes owned processes, persists no false success, and preserves the last successful artifact pair.
- [x] Existing proof leases and legacy publication locks fail closed without stale-path deletion, while a post-rename ownership cleanup warning cannot revoke the committed valid pair.
- [x] Reset cleanup removes only descriptor-anchored, marker-matching sessions whose recorded owner is no longer alive.
- [x] While the desktop browser remains at 1280 by 720, a separate headless 390 by 844 read-only replay creates no Run and independently regenerates the same signed chain and zero-upload verifier evidence without horizontal overflow or hidden actions.
- [x] The [three-minute narration](three-minute-demo.md) and [one-page architecture](architecture-one-page.md) use the same state names and guarantees as the product.
- [x] `npm run check:phase7` passes from a clean clone.
- [x] `npm run check:phase11:protocol` and `npm run test:phase11:ui` pass without ModelArk credentials, a wallet, RPC, or funds.
- [x] `npm run test:container-transaction` passes with Docker, Colima, or Podman and no ModelArk credential.
- [x] `npm run test:container-browser` passes and shows the promoted real-Codex result plus required command Validation in Chrome.
- [x] `npm run demo:runtime -- --reset` remains available as the persistent manual inspection and rehearsal path.
- [x] The launcher reports `7/7` credential-safe readiness checks, and `npm run demo:readiness` reproduces the same local evidence digest without returning provider values.
- [x] `Run complete safety loop` executes the three real-Runtime stages in order, stops immediately if an expected disposition is not produced, and automatically verifies the signed Repair lineage.
- [x] The guide reports `Full signed recovery proof verified` only after both signatures, the parent link, and every Canonical State handoff pass local verification.
- [x] The repaired real-Runtime proof opens its generated decision chain directly in the zero-upload verifier and reports two linked signed decisions with an intact Canonical State handoff.
- [ ] `npm run demo:modelark -- --reset` refuses to start unless a live ModelArk preflight succeeds and never honors `AIRLOCK_SKIP_MODELARK_PREFLIGHT`.
- [ ] The live UI shows `LIVE MODELARK PROOF`, fresh generated-output preflight evidence, one seeded Agent, and one `Run live Candidate` action.
- [ ] A complete live Promotion automatically records one private signed evidence packet with the safe ModelArk execution-profile disclosure, and `npm run verify:modelark-evidence` validates it offline.
- [ ] `npm run prove:modelark -- --reset --headed` drives the production browser, verifies the signed packet offline, cleans up owned processes, and returns success only after all eight proof gates pass.
- [ ] Provider HTTP 429 returns the safe `provider-unavailable` class without a live-proof UI, paid fallback, credential disclosure, or overwritten successful capsule.
- [ ] Recorded evidence is labelled historical and is never presented as a substitute for a current live preflight.
- [ ] The live Candidate creates the exact artifact, updates SQLite, submits one typed intent, passes the required state Validation, promotes all four resources, delivers exactly one effect after Promotion, and exports a locally verified signed decision.

The Phase 22 checklist passed from fresh canonical headed, headless, and JSON evidence on this release candidate.
The other unchecked items are optional live ModelArk conformance steps that require provider capacity at judging time.

## Falsifiable claims

1. A Run without a recorded approved decision cannot become Canonical State during recovery.
2. A rejected, failed, cancelled, or pre-decision interrupted Candidate cannot advance the canonical manifest.
3. Workspace, Agent memory, SQLite data, and supported external-action intents receive one coherent disposition.
4. A repaired child cannot promote over Canonical State that advanced after its parent was quarantined.
5. A rejected intent is not copied into the Repair Run's fresh outbox.
6. Replaying an approved journal converges to one immutable version, one canonical state, one assistant message, and at most one local mock effect.
7. A packet with a cross-receipt transparency proof or altered EVM calldata fails even when its bundled receipt remains cryptographically valid.

Each claim is asserted through server or production-browser tests and is visible through bounded persisted evidence.

## Honest non-claims

- The exactly-once guarantee ends at the atomic local mock consumer and does not cover arbitrary providers.
- Runtime traffic sent outside the supported outbox is not transactionally controlled.
- The single-process journal is not a distributed consensus protocol and does not claim power-loss durability.
- Ordinary containers are not hardened multi-tenant isolation.
- The deterministic fixture and real-Codex local protocol transaction are reproducible judging proofs, while live ModelArk conformance must be rerun because provider capacity changes over time.
- Live credentials and raw provider output are never stored as release evidence.
- The core recording adds no new authority and does not require federation, receiver custody, blockchain publication, Competing Futures, or Adaptive Assurance.
- The signed chain proves mathematical integrity and lineage, not organizational trust, Runtime correctness, or policy sufficiency by itself.

## Submission artifacts

- [README and one-command setup](../../README.md)
- [Product requirements](../product/PRD.md)
- [Outcome roadmap](../product/OUTCOME_ROADMAP.md)
- [One-page architecture](architecture-one-page.md)
- [Three-minute demo](three-minute-demo.md)
- [Recovery guide](../RECOVERY.md)
- [Security policy](../../SECURITY.md)
- [Phase 5 through 7 execution evidence](../../.omx/plans/phases-5-7-execution.md)
