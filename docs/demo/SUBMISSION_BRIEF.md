# Agent Airlock submission brief

## The one-line product

Agent Airlock is a transactional commit boundary for autonomous Agents: the Runtime may explore a complete future, but only a future that passes its Outcome Contract can become accepted reality.

## The problem

The [CodeJam Agent Launchpad starter kit](https://github.com/RrankPyramid/CodeJam) already isolates each turn in a disposable container, but useful Agents also mutate durable resources that outlive that container.
Those resources include the workspace, persistent Codex session, application database, and external-action queue.
A Run that changes only some of them before failing can leave an Agent in a split, unsafe state.

Airlock closes that gap.
Every Run receives isolated Candidate State across all four resources.
The Runtime never receives a mutable Canonical State path.
The trusted control plane validates the complete Candidate against a versioned Outcome Contract and gives every resource one disposition:

- Promotion installs one immutable version and atomically advances the Canonical State manifest.
- Quarantine retains the rejected future as evidence while Canonical State remains byte-for-byte unchanged.
- Repair starts a bounded child from the retained work, exact Canonical State, the original contract, and a fresh empty outbox.
- Supported external effects dispatch only after Promotion and use stable idempotency keys.

This is not another database and it is not a multi-Agent messaging layer.
Candidate versions are temporary alternate futures, while the canonical manifest is the single accepted reality.

## Why this is the Agent Launchpad middleware track

The track asks teams to preserve the starter kit and add a coherent, functional, testable middleware capability at a real execution boundary.
Transactional execution and recovery is explicitly within the track's team-designed reliability, state-governance, versioning, rollback, and safety space.

| Starter-kit capability | What remains intact | Airlock extension |
| --- | --- | --- |
| React Agent and Playground experience | Agent CRUD, lifecycle controls, chat, Run status, and persistent use | Candidate disposition, Outcome Brief, Repair, and portable proof |
| Fastify control plane and `AgentService` | Existing API and asynchronous Run lifecycle | Candidate preparation, Validation, Promotion journal, recovery, and deferred effects |
| `AgentRunner` and Codex CLI | The same Agent execution seam and persistent session behavior | Candidate-only Runtime bindings and one transactional decision after execution |
| Disposable local container Runtime | Docker, Colima, or Podman remains the primary judging path | Canonical State is never mounted mutably into the Runtime |
| BytePlus ModelArk Responses integration | The credentialed provider path remains supported | A separate fail-closed live conformance proof binds a safe execution profile into signed evidence |

Airlock is therefore built inside the intended CodeJam seams, not beside the starter kit and not as a static UI simulation.

## The three-minute proof

Warm the exact production path before recording:

```bash
npm install
npm run prove:runtime -- --reset --json
```

Start screen capture and run:

```bash
npm run prove:runtime -- --reset --headed
```

The bounded runner opens production Chrome and creates exactly three fresh persisted Runs through the actual CodeJam frontend, Fastify control plane, pinned Codex CLI, and disposable container Runtime.
It uses a local deterministic Responses-protocol fixture so the core recording cannot fail because free provider capacity disappeared.
This fixture replaces only inference, while the Codex process, container, file mutation, SQLite mutation, session state, outbox, Validation, Promotion, recovery, and browser evidence paths remain real.

The one-action story is:

1. A valid Candidate promotes the workspace, Codex session, SQLite state, and outbox together, then releases exactly one supported effect.
2. A destructive Candidate fails a required Validation, quarantines all four resources, releases no effect, and leaves the Canonical fingerprint unchanged.
3. A Repair child reuses the retained useful work through bounded lineage, passes Validation, promotes all four resources, and releases one fresh effect after Promotion.
4. The same signed two-decision chain opens in a browser-local verifier that reports zero API calls and validates both signatures, the parent link, and the Canonical State handoff.

The command returns success only after the fresh Run set, dispositions, effects, evidence, desktop frame, mobile replay, and offline proof all agree.

## Rubric map

| Evaluation category | Weight | Exact submission evidence |
| --- | ---: | --- |
| End-to-end middleware behavior | 40% | One production-browser action crosses React, Fastify, `AgentService`, `AgentRunner`, real Codex, a disposable Runtime, four Candidate resources, Validation, Promotion or Quarantine, deferred effects, and persisted evidence. |
| Technical design and integration | 25% | Airlock uses the starter kit's narrow execution seam, keeps one trusted decision boundary, uses a versioned Outcome Contract, and advances one atomic canonical manifest instead of replacing the platform. |
| Verification and robustness | 20% | The release gate covers success, rejection, Repair, restart reconciliation, interruption, tampering, redaction, stale evidence, exact Run binding, zero-upload verification, and fail-closed proof publication. |
| Demo and reproducibility | 15% | One command owns build, isolated state, production Chrome, three fresh Runs, proof capture, independent verification, cleanup, and a hard 180-second recording budget. |

## Falsifiable evidence

The strongest claim is not that an Agent said it succeeded.
The strongest claim is that independently derived persisted evidence agrees on what became reality.

- A promoted Run shows four promoted resources, passed required Validations, an advanced Canonical fingerprint, and effect delivery after Promotion.
- A quarantined Run shows four quarantined resources, a decisive failed Validation, identical before and after Canonical fingerprints, and zero released effects.
- A repaired Run names its retained parent and proves the exact Canonical handoff through a locally verified signed decision chain.
- The zero-upload verifier consumes the exported chain without trusting the running Airlock server or making a network request.
- `npm run check` exercises the full repository gate, and the hosted release workflow reruns quality, production-browser, and real CodeJam Runtime proof jobs.

## Honest ModelArk boundary

Live ModelArk is a separate optional conformance encore because provider quota and availability change independently of this repository.

```bash
npm run prove:modelark -- --reset --headed
```

That command requires an activated Responses-compatible model, valid Ark credentials, a region-matching base URL, and available Free Credits Only Mode capacity.
It performs a fresh provider preflight before any live-proof UI may start, never disables free-only protection, never falls back to paid inference, and fails closed on provider unavailability.
The launcher cannot verify account billing settings, so the operator must keep Free Credits Only Mode enabled for every configured model.
A successful Run must create the exact file and SQLite result, promote all four resources, release one typed effect after Promotion, capture a signed credential-free packet, and verify that packet offline.

The deterministic core recording does not claim live ModelArk inference or model quality.
The live execution profile is an Airlock control-plane attestation committed by the signed receipt, not a BytePlus signature.
No credential, raw endpoint identifier, base URL, environment value, prompt, or provider output belongs in release evidence.

## Submission deliverables

- [Three-minute narration](three-minute-demo.md)
- [One-page architecture and trust boundary](architecture-one-page.md)
- [Judge checklist and exact commands](JUDGE_CHECKLIST.md)
- [Product requirements](../product/PRD.md)
- [Outcome roadmap](../product/OUTCOME_ROADMAP.md)
- [Security policy](../../SECURITY.md)

## Deliberate limits

- Exactly-once effect delivery ends at the supported atomic local consumer and is not a distributed transaction with arbitrary providers.
- Runtime traffic outside the typed outbox is not transactionally controlled.
- The journal targets one local control-plane process and does not claim distributed consensus or power-loss durability.
- Ordinary containers are not hardened multi-tenant isolation.
- Signatures prove artifact integrity and lineage, not Runtime correctness, signer identity, or policy quality by themselves.
