# Agent Airlock recovery guide

## Recovery promise

Airlock records the promotion decision before changing accepted state and reconciles an interrupted approved decision forward after restart.
A Run without that durable decision never becomes Canonical State during recovery.

## Sources of truth

| Evidence | Meaning |
| --- | --- |
| Promotion journal | A validated Candidate received an approved promotion decision. |
| Immutable version directory | The planned physical Whole-Agent state was installed. |
| `canonical.json` | The currently accepted Whole-Agent state. |
| Atomic mock-delivery store | The supported local external effect was claimed. |
| Resource Provider immutable version | The exact provider target in the durable Promotion plan was installed. |
| Resource Registry generation | The exact additive provider contracts accepted by this deployment. |
| Registry Transition journal | A provider addition was verified and planned for one Agent before canonical advancement. |
| Candidate Set aggregate | One exact shared source, sealed competitor evidence, deterministic Selection Decision, and loser cleanup progress. |
| JSON control-plane store | Operator-facing Agent, Run, Candidate Set, message, and receipt metadata. |

Recovery verifies the physical sources first and repairs control-plane metadata last.
It never rolls `canonical.json` backward.

## Journal phases

1. `validated` records the approved decision while Candidate State still exists.
2. `version-installed` proves the immutable target version and its fingerprints exist.
3. `canonical-advanced` proves `canonical.json` names that exact installed target.
4. `effects-delivered` proves every supported local intent has its idempotent receipt.
5. `completed` proves the bounded final transaction evidence is durable.

Each phase is persisted through a temporary file and atomic rename under `APP_DATA_DIR/promotion-journal`.
The journal contains bounded redacted evidence and a neutral recovery message, not a second copy of arbitrary Runtime output.

## Startup order

1. Load and migrate the control-plane store.
2. Scan and reconcile Promotion journals and exact Resource Provider target fingerprints.
3. Retain a valid interrupted pre-decision Candidate in Quarantine or cancel the Run when no Candidate exists.
4. Normalize every interrupted Candidate Set evaluation without replaying Runtime and preserve every complete sealed Candidate.
5. Recompute a missing Selection Decision from persisted bounded evidence, resume only its exact winner, and reconcile loser dispositions.
6. Verify configured provider additions against their exact immutable source versions.
7. Reconcile each Agent's additive Registry Transition journal and canonical reference from `canonical.json`.
8. Commit the new Resource Registry generation only after every Agent converges.
9. Ask every configured Resource Provider to discard expired remote Candidate or Quarantine state before removing local mutable state.
10. Persist recovered Runs, Candidate Sets, receipts, assistant messages, Agent states, and retention dispositions.

Promotion recovery and retained Quarantine cleanup use the provider vector persisted with that historical transaction.
The current configured registry may contain additive providers, but a provider added later is not part of earlier recovery work.
Any unresolved prior-generation Promotion recovery defers Registry Transitions and the registry-generation commit.
Candidate Set recovery also uses each competitor's persisted historical provider subset and finishes before a newly configured provider can enter Canonical State.

## Fault outcomes

| Interruption | Restart result |
| --- | --- |
| Before the approved journal exists | Canonical State stays unchanged, and a valid Candidate is quarantined. |
| After `validated` | The Candidate is installed, accepted, delivered, and completed once. |
| After physical version installation | The installed fingerprints are verified before canonical advancement. |
| After `version-installed` | The exact installed version becomes canonical, then supported effects are dispatched. |
| After physical canonical advancement | The existing manifest is verified against the journal and recovery continues forward. |
| After `canonical-advanced` | Supported intents are parsed from the immutable accepted outbox and claimed idempotently. |
| After physical effect dispatch | The same idempotency keys return the existing receipts before completion. |
| After `effects-delivered` or `completed` | Final Run and Agent metadata is reconstructed without another version, effect, or assistant message. |
| During provider preparation cleanup | Runtime does not start, Canonical State stays unchanged, and failed cleanup retains a retryable composite Quarantine. |
| During cancellation while provider cleanup is unavailable | Canonical State stays unchanged, the complete Candidate becomes cleanup-only Quarantine, and Discard remains retryable. |
| After provider Discard but before local Quarantine removal | Repeated Discard is idempotent, and local removal continues only after all providers pass. |
| After local Quarantine removal but before final metadata | Persisted provider Discard evidence lets startup complete the disposition without recreating mutable state. |
| Local Quarantine missing without complete provider Discard evidence | The Run enters `recovery-error`, and Airlock does not claim remote cleanup. |
| Before a Registry Transition journal exists | The prior canonical manifest and registry generation remain authoritative. |
| After a Registry Transition plan is durable | An unaccepted target is removed and the verified transition is retried. |
| After a Registry Transition target is installed | Its exact local and provider fingerprints are checked before canonical advancement. |
| After canonical advancement but before Registry Transition cleanup | The exact accepted target is recognized, the journal is removed, and no second state is installed. |
| A Registry Transition journal has altered identifiers, fingerprints, fields, or verifications | Recovery rejects it before the target path can authorize deletion or canonical rewriting. |
| One Agent fails provider onboarding | The prior Resource Registry generation remains authoritative, successful Agent transitions remain recoverable, and no unverifiable source becomes accepted. |
| A Resource Registry generation remains uncommitted | Agent creation and ordinary or Repair Run execution remain unavailable until every Agent converges. |
| A prior-generation Promotion remains unresolved after a provider is added | Recovery uses the Promotion plan's historical provider subset, defers onboarding, and leaves the new generation uncommitted. |
| A retained historical Quarantine is discarded after a provider is added | Only the providers recorded by that Quarantine receive idempotent Discard; the later provider is not invoked. |
| Before a Candidate Set Selection Decision exists | Complete seals remain eligible, partial evaluations become explicitly ineligible without Runtime replay, and Selection is recomputed from persisted evidence. |
| After a Candidate Set Selection Decision exists | Recovery may promote only the named winner and may never fall through to a runner-up. |
| During Candidate Set winner Promotion | The existing Promotion journal reconciles the exact selected Run, canonical version, and supported effects. |
| During Candidate Set loser cleanup | Completed dispositions remain durable, unresolved retain or Discard work is retried idempotently, and no loser can change the winner. |
| After physical loser Quarantine or removal but before terminal metadata | Recovery verifies the exact local state and complete provider cleanup evidence, then records the already completed disposition without recreating Candidate State. |
| Selected Candidate seal or physical resource state contradicts persisted evidence | The Candidate Set enters `recovery-error`, Canonical State is preserved, and no losing effect is claimed. |
| An older-generation Candidate Set remains unresolved when a provider is added | Winner Promotion and loser cleanup use only the historical provider subset, and onboarding waits until the set reaches a safe terminal state. |
| Provider removal or contract replacement is configured | Startup fails that Registry evolution closed until an explicit export-and-retire migration is supplied. |
| Any physical contradiction | The Run and Agent enter `recovery-error`, Canonical State is not rewritten, and no new effect is claimed. |

## Retention

`AIRLOCK_CANDIDATE_RETENTION_HOURS` defaults to 24 hours.
`AIRLOCK_QUARANTINE_RETENTION_HOURS` defaults to 168 hours.
Both settings accept positive values up to 8,760 hours.

Active or unresolved journal and Candidate Set Run identifiers are protected from cleanup.
Cleanup accepts no caller-supplied path, rejects unsafe identifiers, does not traverse symbolic links, and scans only `.candidates` and `.quarantine`.
Expired Quarantine loses mutable files but retains output, Validation evidence, hashes, lineage, timeline, and its Promotion Receipt.
Provider Discard evidence is persisted before the local Quarantine directory is removed.
If a provider is unavailable, cleanup retains the complete local Quarantine and retries on the next startup.
Every provider-controlled lifecycle string is bounded and credential-checked before it can enter durable evidence or an operator response.

## Operator response

A normal recovered Run displays `Journal completed` and notes that startup reconciliation completed the approved Promotion.
A contradiction displays `Recovery failed closed` with bounded failure evidence and places the Agent in `error` state.
Preserve the data directory for diagnosis and compare the journal plan, immutable target fingerprints, and canonical manifest before taking manual action.
Do not edit `canonical.json`, a journal record, or the mock-delivery store independently.

## Verification

Run the complete no-cost Phase 6 gate:

```bash
npm run check:phase6
```

The server acceptance suite injects interruption at all eight implemented seams and performs two consecutive restarts.
It also verifies contradictory installed state, pre-decision Quarantine retention, expiration with evidence preservation, unsafe identifiers, and cleanup symlink confinement.
No ModelArk credential or paid inference request is used.

Run the judge-ready restart and recovery story with:

```bash
npm run demo -- --reset
```

Complete the four guided steps, stop the process with `Ctrl+C`, and restart with `npm run demo` without `--reset`.
The same Agent identifier, messages, immutable versions, canonical manifest, Promotion evidence, and mock effect receipts must reappear.
Use `npm run test:demo` for the automated launcher restart assertion and `npm run check:phase7` for the complete recovery and release gate.

Run the provider recovery and crash matrix with:

```bash
npm run test -w @launchpad/server -- --run src/phase-eight-resource-acceptance.test.ts
npm run check:phase8:provider
```

These tests cover deployment onboarding, unverifiable-source rejection, Registry Transition crash recovery, prepare abort, provider-only rejection, idempotent Promotion, cancellation cleanup outage, post-Runtime symbolic-link substitution, Quarantine and Discard, missing-state contradiction, cleanup retry, and restart at every provider Promotion seam without paid inference.

Run the Competing Futures recovery and decision matrix with:

```bash
npm run check:phase9:selection
npm run check:phase9:boundaries
```

These tests cover strict database parsing, deterministic replay, sibling isolation, aggregate token reservation, scoped over-budget Runtime cancellation, terminal pre-decision cancellation, all-invalid completion, selected-winner seal tampering, Candidate Set versus Promotion-journal authority contradiction, exact-winner restart recovery, idempotent loser cleanup, older-generation provider recovery, Registry Transition blocking, and exactly one supported winner effect without a ModelArk credential or paid request.
Agent deletion refuses unresolved Promotion recovery or retained Quarantine, while successful archival writes only bounded lifecycle identifiers, dispositions, and cryptographic evidence digests to its tombstone.
