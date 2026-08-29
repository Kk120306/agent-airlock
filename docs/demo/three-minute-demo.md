# Agent Airlock three-minute demo

## Demo promise

Agent Airlock lets an Agent attempt one Whole-Agent future across files, memory, SQLite data, and supported external actions without allowing a rejected attempt to change accepted reality.
The canonical recording path uses the starter kit's production React Playground, Fastify control plane, pinned Codex CLI, disposable Runtime container, isolated Candidate State, constrained Validation, Promotion journal, and persisted Run authority.
Only the Responses provider is deterministic and local, so the recording needs no ModelArk credential, provider capacity, wallet, blockchain, or paid inference.

## Recording prerequisites

- Node.js 22 or newer and npm 10 or newer.
- Installed Google Chrome.
- A running Docker-compatible engine through Docker Desktop, Docker Engine, Colima, or Podman compatibility.
- Free loopback ports 3222 and 43996 for the canonical proof.
- No other active Agent Airlock proof session.

The canonical proof builds the application and Runtime image before Chrome opens.
Warm those caches and verify the exact flow before starting screen capture:

```bash
npm install
npm run prove:runtime -- --reset --json
```

Start the recording pass only after that command succeeds:

```bash
npm run prove:runtime -- --reset --headed
```

Start screen capture before entering the headed command and trim everything before the first Chrome frame, or start capture as soon as Chrome opens.
Do not click, scroll, switch tabs, or close Chrome during the canonical pass.
The runner owns both proof actions, the viewport, presentation timing, verifier transition, and browser shutdown.
Stop capture only after Chrome closes and the terminal prints `Real Runtime proof: PASSED`.

Phase 22 passed on this release candidate through `npm run prove:runtime -- --reset --headed`, `npm run prove:runtime -- --reset --json`, `npm run prove:runtime -- --reset --headed --json`, and `npm run audit:release`.
It uses deadline-aware presentation pacing under a hard 180-second recording budget.
A successful headed proof preserves the complete 15-second opening, 85-second desktop Outcome Brief, and 25-second desktop verifier dwells plus a 5-second browser-close reserve.
Run completion is capped early enough to leave that full 115-second post-Run presentation tail and 15-second release headroom, and the runner returns `recording-timeout` instead of shortening narration when the complete sequence cannot fit.
The deadline remains armed through browser shutdown and the actual atomic latest-pointer commit, so a late proof cannot publish.
Headless JSON proof adds no narration delay while retaining the same evidence gates.
Use `npm run demo:runtime -- --reset` when a persistent stage-by-stage rehearsal is preferable to the bounded canonical proof.
The canonical runner opens production Chrome at 1280 by 720, keeps the desktop recording at that viewport through browser close, seeds exactly one recording Agent, and presents one primary action:

> Prove this release is safe

The action must create exactly three fresh Runs after the recording starts.
It must never reuse an earlier terminal Run, signed packet, or browser-only result.
The final Outcome Brief must be derived from those three persisted Runs and independently verified artifacts rather than from prompts, Runtime narration, or staged frontend state.
While the desktop browser remains at 1280 by 720, a separate headless 390 by 844 read-only replay hydrates from those exact persisted Run identifiers.
The replay creates no Run and independently regenerates the same signed chain and zero-upload verifier evidence before the proof may publish success.

## Visual-cue recording timeline

The proof preserves fixed presentation dwells, but real container Run completion time varies.
Only the opening begins at a fixed wall-clock time.
After 0:15, follow the visible screen state rather than a stopwatch.

### 0:00 to 0:15 - Establish the guarantee

Point to `REAL RUNTIME PROOF`, the selected recording Agent, and its visible versioned Outcome Contract.
State the falsifiable guarantee: the Runtime may mutate only Candidate State, and only Airlock may advance the atomic Canonical State manifest after every required Validation passes.
Point out that real Codex is running inside a disposable container while a local deterministic Responses fixture removes provider capacity from the recording risk.

### Next visible state - Watch one proof execute

Do not select `Prove this release is safe` during the canonical headed recording.
The runner invokes it exactly once after the opening guarantee is visible for the full 15 seconds.
Use `npm run demo:runtime -- --reset` for a human-click rehearsal.
The guided proof must start exactly three fresh Runs in order: a valid Candidate, a destructive Candidate, and a Repair Run from the retained Quarantine.
Keep the recording on the three-step progress guide while the Runs complete.
After signed verification succeeds, the final evidence-derived Outcome Brief replaces the working view and becomes the single frame for the evidence walk-through.
Run completion may take up to 35 seconds, and the Outcome Brief appears immediately when the proof finishes.

### Outcome Brief, first 20 seconds - Promote one coherent future

On the completed Outcome Brief, show the first fresh Run as `Promotion` only after every required Validation passes.
Point to the visible passed-Validation count, four promoted resources, advanced Canonical fingerprint, and exactly one post-Promotion effect.
Explain that the persisted transaction evidence also records the accepted SQLite value and ordered Promotion journal without crowding the compact recording brief.

### Outcome Brief, next 20 seconds - Quarantine the destructive future

On the completed Outcome Brief, show the second fresh Run as `Quarantine` after its required Validation rejects the deliberately invalid result.
Point to the visible failed-Validation count, four quarantined resources, and the identical before and after Canonical fingerprints.
Explain that the unchanged fingerprint and zero effects prove the rejected attempt did not reach accepted reality.

### Outcome Brief, next 20 seconds - Repair retained work

On the completed Outcome Brief, show the third fresh Run as a promoted Repair child of the retained Quarantine with bounded parent and root lineage.
The Repair Run must receive the rejected workspace and memory, a verified disposable reference to exact Canonical State, the original Outcome Contract, and a fresh empty outbox.
Show every required Validation pass, all four resources promote together, and one fresh repair effect dispatch only after Canonical State advances.

### Outcome Brief, final 25 seconds - Read the trust proof

The Outcome Brief must name the three fresh Run identifiers and summarize only persisted facts.
Show the valid Promotion, harmless rejection, promoted Repair, Canonical fingerprint transitions, four-resource dispositions, post-Promotion effects, and locally verified signed lineage.
Require the final verdict to remain unavailable until Airlock verifies the two-decision chain from quarantined parent to promoted repair child.

The runner keeps the completed Outcome Brief visible for 85 seconds in total.
Use the remaining Outcome Brief time to show `Release proven safe`, all three fresh Run identifiers, the two signed decisions, and the final summary without scrolling.

### Final visible state, 25 seconds - Verify beyond the running app

Do not select `Inspect in zero-upload verifier` during the canonical headed recording.
After the full Outcome Brief dwell, the runner opens the exact decision chain automatically and keeps the verifier visible for 25 seconds.
Show `0 API calls`, `2 signed decisions linked`, valid signatures, the exact parent link, and the intact Canonical State handoff.
Close with the product line:

> Agents may explore many futures, but only validated futures become reality.

The runner then closes Chrome automatically and retains at least 15 seconds of release headroom without asking the presenter to rush a visible frame.

## Required visible proof

- Production Chrome invokes the starter-kit frontend, control plane, and real container Runtime.
- One primary action creates exactly three fresh Runs after the proof starts.
- The first Run promotes workspace, Codex session, SQLite, and outbox together.
- The second Run quarantines all four resources and leaves Canonical State unchanged.
- The third Run repairs retained work through bounded lineage and a fresh outbox.
- Supported effects dispatch only after the matching Promotion.
- The Outcome Brief is derived from persisted Run and verification evidence.
- A signed two-decision chain proves the rejected parent, promoted Repair, and Canonical State handoff.
- The browser-local verifier checks that chain with zero uploads and zero API calls.
- The desktop recording remains 1280 by 720, while an independent headless 390 by 844 read-only replay regenerates the same chain and verifier evidence without creating a Run.
- The terminal and browser identify real Codex with a local deterministic Responses fixture and do not imply live ModelArk inference.

## Recording artifacts

The runner publishes exactly two immutable judge-facing artifacts for a successful recording:

1. A bounded credential-free content-addressed immutable result capsule with the three fresh Run identifiers, gate results, final verdict, relative chain filename, and chain digest.
2. The signed Portable Decision Chain that the zero-upload verifier consumes independently.

The safe capsule is a convenience index and never becomes Promotion, Run, receipt, or trust authority.
The signed chain remains the independently verifiable evidence.
The runner installs both the result capsule and signed chain at owner-only content-addressed immutable paths before atomically replacing the owner-only `real-runtime-proof.latest.json` convenience pointer.
That mutable latest file is never uploaded as the result artifact and is never decision or trust authority.
The proof lease stays held through that pointer commit, and the hosted release resolver validates it before uploading only the exact immutable capsule and chain it identifies.
A failure before the latest pointer commit leaves the prior current pair unchanged.
A deny-all browser boundary arms immediately before the first verifier opening, blocks every later HTTP and WebSocket request, and remains active through both verifier views, the final recording dwell, and browser close.
The runner closes its owned browser, launcher, Runtime containers, and proof session before publication begins.
An existing proof lease or legacy publication lock fails startup closed and is never reclaimed by deleting a possibly replaced pathname.
A reset removes only marker-matching sessions whose recorded owner is no longer alive, using descriptor-anchored validation and deletion throughout.
A proof-ownership cleanup failure after the capsule rename produces a fixed warning but cannot turn the already committed valid pair into a failed proof.

## Automated proof target

```bash
npm run prove:runtime -- --reset --headed
npm run check
```

Phase 22 gates a desktop recording that stays at 1280 by 720 without document overflow and a separate headless 390 by 844 read-only replay without horizontal overflow or hidden proof actions.
The runner requires exactly three fresh terminal Runs, the evidence-derived Outcome Brief, the signed two-decision chain, successful desktop zero-upload verification, and independently regenerated mobile replay evidence before returning success.
The full repository gate must preserve the existing deterministic browser, server, container, recovery, Portable Trust, and release-audit coverage.

## Failure semantics

- Readiness, startup, browser, Run, disposition, evidence, viewport, timeout, and interruption failures must remain distinct.
- Any unexpected Run count, Run reuse, wrong disposition, missing resource evidence, early effect, broken lineage, or verifier failure must return nonzero.
- A failed proof must not display or persist a success verdict.
- A failed proof must preserve the last successful safe capsule and signed chain.
- The runner gives application and Runtime-image preparation their own bounded deadlines and keeps those failures distinct from the hard 180-second browser recording deadline.
- Deadline-aware presentation pacing must preserve every successful headed dwell in full or return `recording-timeout` rather than shorten narration.
- The recording deadline must remain enforceable through browser close and the atomic latest-pointer commit.
- The runner must close only the browser and server processes it owns on success, failure, timeout, or signal.
- Any browser request or WebSocket traffic after the offline verifier boundary arms must be blocked and must fail the verifier gate.
- A stale proof lease or legacy publication lock must remain untouched and fail startup closed.
- Bounded terminal output and the safe capsule must never contain credentials, environment values, provider URLs, raw model output, prompts, or local absolute paths.

## Honest recording boundary

The core three-minute recording demonstrates transactional Agent execution, not every later product capability.
It does not introduce new authority, federation, receiver custody, blockchain publication, Competing Futures, or Adaptive Assurance.
Existing Portable Trust signatures are evidence, not Promotion authority and not proof of organizational trust in the signer.
The local deterministic Responses fixture proves the real Runtime protocol and Airlock middleware path, not live ModelArk availability or model quality.
Live ModelArk conformance remains a separate optional command because provider capacity is external and time-varying.
Exactly-once delivery is claimed only inside the atomic local mock consumer.
Unrestricted Runtime networking can bypass the typed outbox.
The Promotion journal is designed for one local control-plane process and does not claim distributed coordination or power-loss durability.
Ordinary containers are not hardened multi-tenant sandboxes.

## Deterministic fallback

Use `npm run demo -- --reset` when no container engine is available.
That four-step fixture remains the fastest deterministic regression and fallback demonstration, but it is not the canonical Phase 22 recording.
Its UI and terminal must continue to disclose that paid model inference was replaced.
Open <http://127.0.0.1:3199> and select the four numbered controls in order: Promotion, Quarantine, Repair, and continuity.
This fallback is human-driven, so wait for each numbered step to complete before selecting the next one.
Press `Ctrl+C` in the launcher terminal to stop it after the recording.

## Live ModelArk conformance

Use `npm run prove:modelark -- --reset --headed` only as an optional provider-backed conformance encore.
That path requires `ARK_API_KEY`, `ARK_MODEL`, a region-matching `ARK_BASE_URL`, an activated Responses-compatible model, and available free-only capacity.
It must fail safely on provider unavailability and must never disable Free Credits Only Mode or fall back to a paid path.
Its successful signed evidence is useful additional context, but provider capacity is not part of the core recording exit gate.
