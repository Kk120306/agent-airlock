# Bounded live ModelArk proof runner

## Decision

Build one orchestration command around the existing live ModelArk judge path.
The command must drive the production browser, but persisted Run evidence and the signed portable evidence packet remain the authority.
The runner must never introduce a second inference path, skip provider preflight, fabricate provider evidence, or treat visible UI text as proof by itself.

## Existing seams

The complete live path already exists as six independently useful boundaries.

1. `scripts/check-modelark-live.mjs` performs a bounded Responses API preflight and returns only credential-safe commitments, counts, and a configured-model selection index.
2. `scripts/start-local-poc.sh` builds the disposable Runtime and starts the production server only after the preflight succeeds.
3. `scripts/run-modelark-demo.mjs` owns the marker-protected state root, seeds the exact Agent and Outcome Contract, and admits the UI only after seven readiness checks pass.
4. `LiveModelArkGuide` exposes the one production action named `Run live Candidate` and derives completion from persisted Run evidence.
5. `scripts/modelark-conformance-evidence.mjs` recognizes only a complete four-resource ModelArk Promotion and atomically captures one private signed evidence packet.
6. `scripts/verify-modelark-evidence.mjs` verifies the captured packet without contacting ModelArk or the running server.

The missing capability is orchestration between these seams.
Today a reviewer must keep the launcher open, click the browser action, notice the terminal result, wait for capture, invoke the verifier, and interpret several outputs manually.

## Authority model

The production Chrome interaction proves that the user-facing CodeJam path initiated the Run.
The terminal Run Transaction proves the disposition, Validations, resource handoff, SQLite state, and deferred effect.
The portable evidence packet proves the signed historical decision and disclosed execution-profile commitment.
The runner result is only a bounded convenience projection over those authorities.
It is not signed, does not add a timestamp claim, and cannot replace the packet.

Success requires every following gate.

1. The existing launcher reaches its seven-check ready state after the mandatory ModelArk preflight.
2. Chrome loads the production application and selects the uniquely seeded `Live ModelArk Proof` Agent.
3. Chrome invokes the existing `Run live Candidate` control exactly once.
4. One new non-Candidate-Set Run reaches terminal `promoted` disposition.
5. `isCompleteLiveModelArkPromotion` accepts the persisted transaction.
6. The UI renders the bound ModelArk preflight, Runtime, and Promotion verdict for that Run.
7. The existing capture boundary writes the private latest packet atomically.
8. A structured offline verifier accepts the packet, its promoted disposition, and its required ModelArk execution-profile disclosure.

No earlier gate may imply a later one.
An HTTP 200 from ModelArk, a completed Codex process, a green UI label, or a packet-shaped file is insufficient independently.

## Failure model

The command returns one stable safe failure class and a concise remediation message.
It must not persist child output, provider output, browser traces, URLs, raw model identifiers, endpoint identifiers, local paths, or environment values in its result capsule.

| Failure class | Meaning | Required behavior |
| --- | --- | --- |
| `provider-unavailable` | The mandatory preflight reached a configured free-only provider boundary but capacity or quota was unavailable. | Exit before the live UI is presented and keep Free Credits Only Mode unchanged. |
| `startup-failed` | Container, build, managed-state, seed, or readiness admission failed. | Stop every owned process and report the relevant safe operator check. |
| `browser-failed` | Chrome could not load or invoke the exact production control. | Stop the run attempt and never infer a provider result. |
| `run-quarantined` | The browser-created Run reached a rejected terminal disposition. | Preserve Airlock evidence, return failure, and never generate a success capsule. |
| `run-failed` | The browser-created Run failed, was cancelled, timed out, or entered recovery error. | Preserve Airlock evidence and return failure. |
| `run-timeout` | No terminal Run appeared inside the bounded live window. | Stop owned processes without rewriting persisted Run state. |
| `evidence-timeout` | A complete Promotion exists but atomic packet capture did not complete in time. | Return failure because Promotion alone is not the requested conformance artifact. |
| `evidence-invalid` | The captured packet fails offline verification or lacks the required disclosure. | Return failure and retain the private packet for diagnosis. |
| `interrupted` | The operator sent a termination signal. | Close Chrome, forward termination to the owned launcher, and exit without a success capsule. |

Unknown child errors collapse to `startup-failed` rather than copying arbitrary stderr into durable output.
Human-readable terminal output may retain the existing launcher diagnostics, but the result capsule must use allowlisted messages only.

## Result capsule

Write the result atomically with owner-only permissions next to the private conformance packet.
The success capsule contains only these fields.

- Schema and schema version.
- Outcome `passed`.
- The untrusted local observation time, labelled `observer-clock-not-external-timestamp`.
- Run identifier.
- Receipt digest.
- Boolean gates for browser invocation, complete Promotion, packet capture, and offline verification.
- The relative packet filename, never an absolute path.

A failed invocation returns structured JSON on request but does not overwrite the latest successful capsule.
This preserves the last valid proof while making the current failure explicit through process status and terminal output.

The capsule must reject strings matching credentials, bearer headers, Ark key prefixes, endpoint identifiers, HTTP URLs, absolute paths, or raw environment assignments before persistence.

## Implementation seam

Extract the bounded recorded-evidence reader and structured verification from the current CLI into a reusable module.
Keep the CLI as a thin human-readable adapter so existing behavior remains stable.

Add a browser-proof core that accepts injected browser, request, clock, and wait functions for deterministic tests.
The production entry point owns only these responsibilities.

1. Resolve and validate the same managed root and loopback port as the existing launcher.
2. Spawn `scripts/run-modelark-demo.mjs` as the single server owner.
3. Wait for the existing health and readiness boundary without duplicating preflight.
4. Launch installed Chrome through Playwright.
5. Drive the exact production guide and observe both browser and persisted evidence.
6. Verify the captured packet offline.
7. Write the safe capsule atomically.
8. Close Chrome and terminate only the child process tree it owns.

The runner must refuse an already occupied port instead of reusing an unrelated server.
It must also refuse concurrent ownership of the same managed proof root.

## Deterministic verification strategy

Deterministic tests may simulate launcher readiness, browser actions, terminal Run evidence, packet capture, timeouts, signals, and every failure class.
They must use an explicit fixture inference identity and must never write a `passed` live conformance capsule.

The test matrix includes:

- Successful orchestration projection over a synthetic signed packet.
- Provider-capacity classification without leaking child output.
- Quarantine, failed Run, Run timeout, capture timeout, and invalid packet.
- Chrome launch and locator failure.
- Signal cleanup and idempotent child termination.
- Atomic owner-only capsule persistence.
- Rejection of forbidden private material in a proposed capsule.
- Preservation of the previous successful capsule after a later failure.

Existing real-Codex container and production browser suites remain the credential-free proof of the Runtime, Candidate, Validation, Promotion, and UI seams.
Only a successful invocation against the live provider may close the final provider-backed acceptance gate.

## Release matrix

| Gate | Credential | Proves |
| --- | --- | --- |
| Runner unit and lifecycle tests | None | Orchestration, classification, cleanup, redaction, and capsule persistence. |
| Existing production browser proof | None | Production UI, real Codex Runtime, Candidate isolation, Validation, Promotion, and portable trust. |
| Existing two-instance federation proof | None | Receiver admission, Promotion and Quarantine, custody export, and offline proof room. |
| `npm run prove:modelark -- --reset` | Free-only ModelArk key and activated Responses-compatible model | The full live provider-to-browser-to-Runtime-to-Promotion-to-signed-packet path on that invocation. |
| `npm run verify:modelark-evidence` | None | The historical signed packet remains valid after the provider and server are gone. |

## Recommendation

Implement the runner as Phase 21 without changing the frozen deterministic judge path.
Keep `npm run demo:modelark` for interactive judging and add `npm run prove:modelark` for rehearsal, release evidence, and failure diagnosis.
Do not add the credentialed command to ordinary hosted CI.
Run it only when the console visibly shows remaining free quota and Free Credits Only Mode is enabled.
