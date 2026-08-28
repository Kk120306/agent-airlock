# Agent Airlock judge checklist

## Thirty-second summary

Agent Airlock is transactional middleware for persistent coding Agents.
The Agent Runtime may explore a complete future across files, memory, SQLite data, and typed external-action intents, but only the trusted Airlock control plane may promote that future after deterministic Outcome Contract validation.
Rejected futures remain inspectable, cannot alter Canonical State, and can seed a bounded Repair Run.

## Start here

```bash
npm install
npm run demo -- --reset
```

Open <http://127.0.0.1:3199> and follow the four numbered `Judge path` controls.
This is a production-build, deterministic local fixture with no ModelArk request or paid inference.

When a container engine is available, also run the real Runtime proof:

```bash
npm run demo:runtime -- --reset
```

Open <http://127.0.0.1:3200>, select `Run passing Candidate`, and show the four-stage compact proof that real Codex used isolated Candidate State, passed every required Validation, promoted all four resources together, and released exactly one effect afterward.
Alternatively, select `Run complete safety loop` to execute Promotion, rejection, and Repair in order with live stage status, then automatically generate and locally verify the repaired Run's signed two-decision chain.
The guide must remain in its signed-lineage verification stage until the final `Full signed recovery proof verified` verdict appears.
Select `Run failing Candidate` and show that the same real Runtime path now quarantines the invalid file while the canonical fingerprint remains unchanged.
Select `Repair retained Candidate` and show that a fresh real Codex Run uses the retained failure evidence, links back to the rejected parent, passes all nine required Validations, and advances Canonical State only after validation.
Show the full recovery verdict, then select `Generate and verify proof` to finish with two locally verified signed decisions and their intact Canonical State handoff.
The guided result exposes one primary `Download verified decision chain` action, while advanced export variants remain outside judge mode.
Select `Inspect in zero-upload verifier` and show `0 API calls`, `2 signed decisions linked`, and the intact parent and Canonical State handoff checks without manually importing the file.
This path uses a local deterministic Responses fixture and visibly discloses that it is not live ModelArk inference.

When ModelArk free capacity is available, run the credentialed conformance proof:

```bash
npm run demo:modelark -- --reset
```

The command cannot inherit the generic preflight-skip escape hatch.
It must complete a credential-safe live Responses request before it can start the application or display `LIVE MODELARK PROOF`.
Open <http://127.0.0.1:3201> and select `Run live Candidate`.
The seeded Outcome Contract requires the exact `modelark-proof.txt` content and SQLite value, so the provider response cannot prove success by narration alone.
Show the required `execution-profile` Validation, its private model commitment, the required state Validation, four promoted resources, one post-Promotion `modelark-live-ready` effect, the Canonical State fingerprint transition, and the locally verified signed decision.
Explain that the execution profile is a trusted Airlock control-plane attestation committed by the signed receipt, not an independent BytePlus signature.
After the live Promotion, show that the launcher reports a captured signed conformance packet, then run `npm run verify:modelark-evidence` in a separate terminal.
Explain that the offline command verifies historical signed evidence and does not claim that ModelArk is currently available.

## Rubric evidence

| Category | Weight | Live evidence | Automated evidence |
| --- | ---: | --- | --- |
| End-to-end middleware behavior | 40% | The starter Playground invokes a Run that mutates four Candidate resources, promotes a valid future, quarantines a destructive future, repairs it, and resumes the repaired Agent session. | `npm run test:demo:e2e` asserts the four-step browser story, `npm run test:container-browser` proves real Chrome-to-Codex container Promotion, Quarantine, Repair, and signed decision-chain export, and `npm run test:container-transaction` adds restart and continuity evidence. |
| Technical design and integration | 25% | The one-page architecture identifies the untrusted Runtime, trusted Airlock decision boundary, versioned Outcome Contract, monotonic journal, atomic canonical manifest, bounded Repair lineage, and post-Promotion dispatcher. | Server tests exercise the `AgentRunner`, `WorkspaceManager`, journal, validator, outbox, JSON store, HTTP API, and startup reconciliation seams. |
| Verification and robustness | 20% | The destructive attempt visibly leaves Canonical State unchanged, Repair reuses failure evidence, and one evidence packet verifies the receipt plus every selected optional proof locally. | `npm run check:phase7` covers transactional failure seams, while `npm run check:phase11:protocol` and `npm run test:phase11:ui` cover cross-process and zero-upload browser verification, tampering, trust roots, and optional-proof binding. |
| Demo and reproducibility | 15% | One command seeds the Agent, prints the URL and disclosure, preserves restart state, and gives the judge a four-step guided story. | Launcher integration verifies reset, restart, shutdown, port conflicts, and seeding; the release audit checks tracked and untracked release files for high-confidence secrets, merge conflicts, and broken relative Markdown targets. |

## Acceptance checklist

- [ ] The Web UI visibly says `FREE LOCAL DEMO` and `No ModelArk request or paid inference is active.`
- [ ] `Airlock Demo` is already selected and its lifecycle state is controllable.
- [ ] Step 1 ends in `Promoted`, `Journal completed`, four promoted resources, and one delivered effect.
- [ ] Step 2 ends in `Quarantined`, identifies the decisive protected-path failure, and shows identical before and after Canonical fingerprints.
- [ ] The rejected SQLite value and unsafe notification do not reach accepted state.
- [ ] Step 3 ends in a promoted child with `Repair 1 of 2`, parent lineage, a fresh accepted effect, and four promoted resources.
- [ ] Step 4 resumes `baseline-thread` from repaired Canonical State.
- [ ] The repaired Run downloads one complete decision chain and the independent browser verifier reports `2 signed decisions linked` with zero API calls or uploads.
- [ ] Reload preserves the seeded Agent and complete evidence.
- [ ] The [three-minute narration](three-minute-demo.md) and [one-page architecture](architecture-one-page.md) use the same state names and guarantees as the product.
- [ ] `npm run check:phase7` passes from a clean clone.
- [ ] `npm run check:phase11:protocol` and `npm run test:phase11:ui` pass without ModelArk credentials, a wallet, RPC, or funds.
- [ ] `npm run test:container-transaction` passes with Docker, Colima, or Podman and no ModelArk credential.
- [ ] `npm run test:container-browser` passes and shows the promoted real-Codex result plus required command Validation in Chrome.
- [ ] `npm run demo:runtime -- --reset` shows `REAL RUNTIME PROOF`, uses real Codex in a disposable container, and presents an evidence-backed Candidate, Validation, Promotion, and independent-verification path.
- [ ] `Run complete safety loop` executes the three real-Runtime stages in order, stops immediately if an expected disposition is not produced, and automatically verifies the signed Repair lineage.
- [ ] The guide reports `Full signed recovery proof verified` only after both signatures, the parent link, and every Canonical State handoff pass local verification.
- [ ] The repaired real-Runtime proof opens its generated decision chain directly in the zero-upload verifier and reports two linked signed decisions with an intact Canonical State handoff.
- [ ] `npm run demo:modelark -- --reset` refuses to start unless a live ModelArk preflight succeeds and never honors `AIRLOCK_SKIP_MODELARK_PREFLIGHT`.
- [ ] The live UI shows `LIVE MODELARK PROOF`, one seeded Agent, and one `Run live Candidate` action.
- [ ] A complete live Promotion automatically records one private signed evidence packet with the safe ModelArk execution-profile disclosure, and `npm run verify:modelark-evidence` validates it offline.
- [ ] Recorded evidence is labelled historical and is never presented as a substitute for a current live preflight.
- [ ] The live Candidate creates the exact artifact, updates SQLite, submits one typed intent, passes the required state Validation, promotes all four resources, delivers exactly one effect after Promotion, and exports a locally verified signed decision.

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

## Submission artifacts

- [README and one-command setup](../../README.md)
- [Product requirements](../product/PRD.md)
- [Outcome roadmap](../product/OUTCOME_ROADMAP.md)
- [One-page architecture](architecture-one-page.md)
- [Three-minute demo](three-minute-demo.md)
- [Recovery guide](../RECOVERY.md)
- [Security policy](../../SECURITY.md)
- [Phase 5 through 7 execution evidence](../../.omx/plans/phases-5-7-execution.md)
