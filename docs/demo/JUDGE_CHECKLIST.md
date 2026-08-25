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

## Rubric evidence

| Category | Weight | Live evidence | Automated evidence |
| --- | ---: | --- | --- |
| End-to-end middleware behavior | 40% | The starter Playground invokes a Run that mutates four Candidate resources, promotes a valid future, quarantines a destructive future, repairs it, and resumes the repaired Agent session. | `npm run test:demo:e2e` asserts the browser, API, immutable state, resource fingerprints, effect receipts, lineage, restart, and mobile paths. |
| Technical design and integration | 25% | The one-page architecture identifies the untrusted Runtime, trusted Airlock decision boundary, versioned Outcome Contract, monotonic journal, atomic canonical manifest, bounded Repair lineage, and post-Promotion dispatcher. | Server tests exercise the `AgentRunner`, `WorkspaceManager`, journal, validator, outbox, JSON store, HTTP API, and startup reconciliation seams. |
| Verification and robustness | 20% | The destructive attempt visibly leaves Canonical State unchanged, and the Repair action reuses failure evidence without replaying the rejected intent. | `npm run check:phase7` includes eight interruption seams, repeated recovery, symlink and path abuse, retention, redaction, timeout and output limits, duplicate delivery, duplicate discard, real container checks, and zero-vulnerability audit. |
| Demo and reproducibility | 15% | One command seeds the Agent, prints the URL and disclosure, preserves restart state, and gives the judge a four-step guided story. | Launcher integration verifies reset, restart, shutdown, port conflicts, and seeding; the release audit checks tracked and untracked release files for high-confidence secrets, merge conflicts, and broken relative Markdown targets. |

## Acceptance checklist

- [ ] The Web UI visibly says `FREE LOCAL DEMO` and `No ModelArk request or paid inference is active.`
- [ ] `Airlock Demo` is already selected and its lifecycle state is controllable.
- [ ] Step 1 ends in `Promoted`, `Journal completed`, four promoted resources, and one delivered effect.
- [ ] Step 2 ends in `Quarantined`, identifies the decisive protected-path failure, and shows identical before and after Canonical fingerprints.
- [ ] The rejected SQLite value and unsafe notification do not reach accepted state.
- [ ] Step 3 ends in a promoted child with `Repair 1 of 2`, parent lineage, a fresh accepted effect, and four promoted resources.
- [ ] Step 4 resumes `baseline-thread` from repaired Canonical State.
- [ ] Reload preserves the seeded Agent and complete evidence.
- [ ] The [three-minute narration](three-minute-demo.md) and [one-page architecture](architecture-one-page.md) use the same state names and guarantees as the product.
- [ ] `npm run check:phase7` passes from a clean clone.

## Falsifiable claims

1. A Run without a recorded approved decision cannot become Canonical State during recovery.
2. A rejected, failed, cancelled, or pre-decision interrupted Candidate cannot advance the canonical manifest.
3. Workspace, Agent memory, SQLite data, and supported external-action intents receive one coherent disposition.
4. A repaired child cannot promote over Canonical State that advanced after its parent was quarantined.
5. A rejected intent is not copied into the Repair Run's fresh outbox.
6. Replaying an approved journal converges to one immutable version, one canonical state, one assistant message, and at most one local mock effect.

Each claim is asserted through server or production-browser tests and is visible through bounded persisted evidence.

## Honest non-claims

- The exactly-once guarantee ends at the atomic local mock consumer and does not cover arbitrary providers.
- Runtime traffic sent outside the supported outbox is not transactionally controlled.
- The single-process journal is not a distributed consensus protocol and does not claim power-loss durability.
- Ordinary containers are not hardened multi-tenant isolation.
- The fixture demonstrates the complete middleware path, but live ModelArk conformance remains pending organizer-provided credentials.

## Submission artifacts

- [README and one-command setup](../../README.md)
- [Product requirements](../product/PRD.md)
- [Outcome roadmap](../product/OUTCOME_ROADMAP.md)
- [One-page architecture](architecture-one-page.md)
- [Three-minute demo](three-minute-demo.md)
- [Recovery guide](../RECOVERY.md)
- [Security policy](../../SECURITY.md)
- [Phase 5 through 7 execution evidence](../../.omx/plans/phases-5-7-execution.md)
