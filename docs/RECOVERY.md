# Agent Airlock recovery guide

## Recovery promise

Airlock records the promotion decision before changing accepted state and reconciles an interrupted approved decision forward after restart.
A Run without that durable decision never becomes Canonical State during recovery.

## Sources of truth

| Evidence                                 | Meaning                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Promotion journal                        | A validated Candidate received an approved promotion decision.                                                                         |
| Immutable version directory              | The planned physical Whole-Agent state was installed.                                                                                  |
| `canonical.json`                         | The currently accepted Whole-Agent state.                                                                                              |
| Immutable historical Canonical manifest  | The complete workspace, Codex home, SQLite, outbox, thread, provider, and composite reference for one exact accepted state identifier. |
| Atomic mock-delivery store               | The supported local external effect was claimed.                                                                                       |
| Resource Provider immutable version      | The exact provider target in the durable Promotion plan was installed.                                                                 |
| Resource Registry generation             | The exact additive provider contracts accepted by this deployment.                                                                     |
| Registry Transition journal              | A provider addition was verified and planned for one Agent before canonical advancement.                                               |
| Candidate Set aggregate                  | One exact shared source, sealed competitor evidence, deterministic Selection Decision, and loser cleanup progress.                     |
| Candidate Set Decision Authority journal | One immutable Selection projection published before its mutable Candidate Set fields.                                                  |
| Agent deletion journal                   | A bounded archive audit was prepared before an Agent workspace rename or control-plane deletion.                                       |
| JSON control-plane store                 | Operator-facing Agent, Run, Candidate Set, Assurance Proposal, Outcome Contract history, message, and Promotion Receipt metadata.      |
| Portable Decision Authority journal      | An append-only terminal Run Transaction commitment with frozen Repair-parent and Candidate Set authority used only for receipt export. |
| Provider Discard cleanup journal         | One immutable provider-cleanup completion fact bound to the exact Discard authority and published before local removal.                 |
| Portable signing key and identity marker | The private Ed25519 signer and its non-secret expected public-key fingerprint.                                                         |
| Local transparency log                   | An optional append-only digest sequence, signed checkpoints, and prior-checkpoint chain for shared observation.                        |

Recovery verifies the physical sources first and repairs control-plane metadata last.
It never rolls `canonical.json` backward.
Portable Decision Authority is captured before terminal Run metadata is committed, but it does not authorize Promotion recovery and is never recreated from mutable control-plane metadata.
Candidate Set Decision Authority is captured before mutable Selection metadata and is the only source allowed to restore a Selection projection that was lost after publication.
Restart-created terminal decisions are written to Decision Authority before the recovered mutable database state is committed.
Normal execution also withholds a terminal Run Transaction from the control-plane store until its child Run and corresponding lifecycle projection can be committed together.
Candidate Set ownership keeps the Agent busy until the aggregate reaches a safe terminal phase.
Candidate Set cancellation, winner completion, and loser retention or Discard each publish their own authority before their terminal mutable child projection.
A selected winner that fails before Promotion is never replaced by a runner-up, and restart preserves both the Selection decision and the winner's authoritative retained or discarded state.
After Selection authority exists, Airlock publishes final Candidate Set-bound Run authority before the mutable Selection projection, and Candidate Set completion never backfills missing authority.
Decision Authority and historical Canonical manifests use synchronized temporary files and non-replacing atomic publication, so a process interruption can leave only a removable temporary remnant or a complete deterministic target.
Historical Canonical manifests use the originating Candidate or Registry Transition timestamp instead of recovery time, so a retry after history publication derives byte-identical immutable content.

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
2. Complete every prepared Agent deletion by verifying its exact bounded audit, idempotently locating or archiving the workspace, removing its control-plane aggregates, and completing the deletion journal.
3. Scan and reconcile Promotion journals and exact Resource Provider target fingerprints.
4. Replay any exact terminal Run authority whose mutable Run projection still appears active, or fail it closed when stable identity or physical Quarantine evidence contradicts authority.
5. Retain a valid interrupted pre-decision Candidate in Quarantine or cancel the Run only when no terminal authority and no Candidate exist.
6. Normalize every interrupted Candidate Set evaluation without replaying Runtime and preserve every complete sealed Candidate.
7. Restore a missing mutable Selection from immutable Candidate Set Decision Authority, or publish one new authority from persisted bounded evidence before Selection becomes visible.
8. Resume only the exact selected winner and reconcile loser dispositions.
9. Verify configured provider additions against their exact immutable source versions.
10. Reconcile each Agent's additive Registry Transition journal and canonical reference from `canonical.json`.
11. Commit the new Resource Registry generation only after every Agent converges.
12. Ask every configured Resource Provider to discard expired remote Candidate or Quarantine state before removing local mutable state.
13. Persist recovered Runs, Candidate Sets, receipts, assistant messages, Agent states, and retention dispositions.

Promotion recovery and retained Quarantine cleanup use the provider vector persisted with that historical transaction.
The current configured registry may contain additive providers, but a provider added later is not part of earlier recovery work.
Any unresolved prior-generation Promotion recovery defers Registry Transitions and the registry-generation commit.
Candidate Set recovery also uses each competitor's persisted historical provider subset and finishes before a newly configured provider can enter Canonical State.

## Fault outcomes

| Interruption                                                                                                              | Restart result                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the approved journal exists                                                                                        | Canonical State stays unchanged, and a valid Candidate is quarantined.                                                                                                     |
| After `validated`                                                                                                         | The Candidate is installed, accepted, delivered, and completed once.                                                                                                       |
| After physical version installation                                                                                       | The installed fingerprints are verified before canonical advancement.                                                                                                      |
| After `version-installed`                                                                                                 | The exact installed version becomes canonical, then supported effects are dispatched.                                                                                      |
| After physical canonical advancement                                                                                      | The existing manifest is verified against the journal and recovery continues forward.                                                                                      |
| After `canonical-advanced`                                                                                                | Supported intents are parsed from the immutable accepted outbox and claimed idempotently.                                                                                  |
| After physical effect dispatch                                                                                            | The same idempotency keys return the existing receipts before completion.                                                                                                  |
| After `effects-delivered` or `completed`                                                                                  | Final Run and Agent metadata is reconstructed without another version, effect, or assistant message.                                                                       |
| During provider preparation cleanup                                                                                       | Runtime does not start, Canonical State stays unchanged, and failed cleanup retains a retryable composite Quarantine.                                                      |
| During cancellation while provider cleanup is unavailable                                                                 | Canonical State stays unchanged, the complete Candidate becomes cleanup-only Quarantine, and Discard remains retryable.                                                    |
| After Discard authority but before provider or local Quarantine cleanup                                                   | Repeated provider Discard is idempotent, its exact completion fact is published after all providers pass, and only then may local removal continue.                          |
| After local Quarantine removal but before final metadata                                                                  | Immutable Discard authority plus its provider-cleanup completion fact let startup complete the disposition without recreating mutable state.                               |
| Local Quarantine missing without immutable Discard authority                                                              | The Run enters `recovery-error`, and Airlock does not claim remote cleanup.                                                                                                |
| Before a Registry Transition journal exists                                                                               | The prior canonical manifest and registry generation remain authoritative.                                                                                                 |
| After a Registry Transition plan is durable                                                                               | An unaccepted target is removed and the verified transition is retried.                                                                                                    |
| After a Registry Transition target is installed                                                                           | Its exact local and provider fingerprints are checked, its journal timestamp is reused, and recovery advances that installed target instead of deleting and recreating it. |
| After immutable Registry Transition history is published but before `canonical.json` replacement                          | Recovery derives the same byte-identical manifest from the installed target and durable journal, verifies the existing history, and advances `canonical.json` once.        |
| After canonical advancement but before Registry Transition cleanup                                                        | The exact accepted target is recognized, the journal is removed, and no second state is installed.                                                                         |
| A Registry Transition journal has altered identifiers, fingerprints, fields, or verifications                             | Recovery rejects it before the target path can authorize deletion or canonical rewriting.                                                                                  |
| One Agent fails provider onboarding                                                                                       | The prior Resource Registry generation remains authoritative, successful Agent transitions remain recoverable, and no unverifiable source becomes accepted.                |
| A Resource Registry generation remains uncommitted                                                                        | Agent creation and ordinary or Repair Run execution remain unavailable until every Agent converges.                                                                        |
| A prior-generation Promotion remains unresolved after a provider is added                                                 | Recovery uses the Promotion plan's historical provider subset, defers onboarding, and leaves the new generation uncommitted.                                               |
| A retained historical Quarantine is discarded after a provider is added                                                   | Only the providers recorded by that Quarantine receive idempotent Discard; the later provider is not invoked.                                                              |
| Before a Candidate Set Selection Decision exists                                                                          | Complete seals remain eligible, partial evaluations become explicitly ineligible without Runtime replay, and Selection is recomputed from persisted evidence.              |
| After Candidate Set Decision Authority exists but before mutable Selection                                                | Restore the exact authorized Selection, publish final Candidate Set-bound terminal Run authorities, and never recompute a different winner.                                |
| After a Candidate Set Selection Decision exists                                                                           | Recovery may promote only the named winner and may never fall through to a runner-up.                                                                                      |
| During Candidate Set winner Promotion                                                                                     | The existing Promotion journal reconciles the exact selected Run, canonical version, and supported effects.                                                                |
| During Candidate Set loser cleanup                                                                                        | Completed dispositions remain durable, unresolved retain or Discard work is retried idempotently, and no loser can change the winner.                                      |
| Candidate Set cleanup fails before every disposition is durable                                                           | The Candidate Set enters `recovery-error`, the Agent remains admission-locked across restart, and no new Run starts over unresolved mutable state.                         |
| After Discard authority exists but before provider or local removal                                                       | Recovery retries provider cleanup, publishes the exact completion fact, completes authorized local removal, and atomically replays the Run plus Candidate disposition.     |
| After Discard authority exists, provider cleanup is incomplete, and the local recovery root is missing                    | Recovery enters `recovery-error`, keeps admission closed, and never treats the decision alone as proof that remote state was removed.                                      |
| After local Quarantine disappears without Discard authority                                                               | Recovery rejects mutable cleanup claims and enters `recovery-error`; it never creates terminal authority from mutable progress.                                            |
| After terminal Run authority exists but before its mutable terminal projection                                            | Recovery verifies stable Run identity plus any required physical Quarantine and replays the exact authoritative transaction instead of synthesizing cancellation.          |
| Selected Candidate seal or physical resource state contradicts persisted evidence                                         | The Candidate Set enters `recovery-error`, Canonical State is preserved, and no losing effect is claimed.                                                                  |
| An older-generation Candidate Set remains unresolved when a provider is added                                             | Winner Promotion and loser cleanup use only the historical provider subset, and onboarding waits until the set reaches a safe terminal state.                              |
| Before an Agent deletion journal exists                                                                                   | The Agent, workspace, Runs, Candidate Sets, Assurance Proposals, and Outcome Contract history remain live.                                                                 |
| After deletion evidence is prepared but before workspace archival                                                         | Startup verifies the unchanged bounded audit and archives the workspace exactly once.                                                                                      |
| After workspace archival but before control-plane deletion                                                                | Startup requires a regular deterministic archive directory and an exactly matching bounded tombstone before removing the exact Agent aggregates.                           |
| After control-plane deletion but before journal completion                                                                | Startup verifies the existing archive destination and removes the already completed journal without recreating the Agent.                                                  |
| Agent deletion audit or physical archive state contradicts the journal                                                    | Startup fails closed before Promotion or Resource Registry transition recovery begins.                                                                                     |
| Receipt export stops before its response                                                                                  | Canonical State and Run evidence remain unchanged, and a retry derives and signs the same receipt content.                                                                 |
| A historical Canonical manifest is missing or contradicts its physical state                                              | Receipt export fails closed without changing Canonical State or signing the contradictory projection.                                                                      |
| Mutable Run, Promotion Receipt, Candidate Set, Selection, or winner-seal metadata contradicts Portable Decision Authority | Receipt export fails closed even when the mutable records were changed consistently with one another.                                                                      |
| A completed legacy decision has no Portable Decision Authority record                                                     | Receipt export fails closed because Airlock cannot safely infer historical authority from mutable metadata.                                                                |
| A portable signing key is missing or substituted while its identity marker remains                                        | Export fails closed without silently rotating the signing identity, and existing envelopes remain independently verifiable.                                                |
| A transparency append completes but its response is lost                                                                  | A retry recognizes the existing receipt digest and returns the same tree position without appending a duplicate.                                                           |
| The optional local transparency log or checkpoint chain is malformed                                                      | Anchored export fails closed, while signature-only export remains available when the operator disables anchoring.                                                          |
| A transparency writer exits                                                                                               | Its immutable queue turn remains, a later contender marks a dead stale predecessor abandoned, no successor pathname is unlinked, and every later turn remains serialized.  |
| Provider removal or contract replacement is configured                                                                    | Startup fails that Registry evolution closed until an explicit export-and-retire migration is supplied.                                                                    |
| Any physical contradiction                                                                                                | The Run and Agent enter `recovery-error`, Canonical State is not rewritten, and no new effect is claimed.                                                                  |

## Retention

`AIRLOCK_CANDIDATE_RETENTION_HOURS` defaults to 24 hours.
`AIRLOCK_QUARANTINE_RETENTION_HOURS` defaults to 168 hours.
Both settings accept positive values up to 8,760 hours.

Active or unresolved journal and Candidate Set Run identifiers are protected from cleanup.
Cleanup accepts no caller-supplied path, rejects unsafe identifiers, does not traverse symbolic links, and scans only `.candidates` and `.quarantine`.
Expired Quarantine loses mutable files but retains output, Validation evidence, hashes, lineage, timeline, and its Promotion Receipt.
Immutable Discard authority is persisted before any provider or local Quarantine removal begins.
Successful provider cleanup is then persisted as one immutable fact bound to that authority before local Candidate or Quarantine removal begins.
If authority publication fails, every provider and local Quarantine remains untouched.
If a provider is unavailable after authority publication, cleanup retains the local Quarantine root and retries idempotently on the next startup.
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

These tests cover strict database parsing, deterministic replay, sibling isolation, aggregate token reservation, scoped over-budget Runtime cancellation, terminal pre-decision cancellation with portable receipts, immutable Selection restoration, exact terminal Quarantine replay, all-invalid completion, selected-winner seal tampering, Candidate Set versus Promotion-journal authority contradiction, exact-winner restart recovery, idempotent loser cleanup, older-generation provider recovery, Registry Transition blocking, and exactly one supported winner effect without a ModelArk credential or paid request.
Agent deletion refuses unresolved Promotion recovery or retained Quarantine, while successful archival writes only bounded lifecycle identifiers, dispositions, and cryptographic evidence digests to its tombstone.

Run the Adaptive Assurance and Agent deletion recovery matrix with:

```bash
npm run check:phase10:assurance
```

These tests cover deterministic proposal replay, lineage deduplication, unknown historical inputs, stale contracts, tampering, strict HTTP review, rejection restart, immutable rollback, nested parser rejection, and interruption immediately after the physical workspace archive.
The archived schema 2 tombstone contains only bounded identifiers, lifecycle states, provenance, and cryptographic digests for Runs, Candidate Sets, Assurance Proposals, Outcome Contract versions, and Promotion Receipts.

Run the Portable Trust protocol, signing-key, transparency-log, and HTTP export matrix with:

```bash
npm run check:phase11:protocol
npm run test -w @launchpad/server -- --run src/phase-eleven-acceptance.test.ts
```

These tests verify strict offline parsing, cross-process signature verification, one-bit tamper rejection, key loss and substitution detection, historical key rotation, Merkle disclosures, local transparency inclusion and split-view detection, append-only lock-turn recovery, zero-network EVM payload generation, exact Candidate Selection and Assurance provenance for every terminal competitor disposition, Repair ancestry, retryable incomplete evidence, and no paid provider access.
Follow the [portable receipt key runbook](operations/PORTABLE_RECEIPT_KEYS.md) before rotating, retiring, restoring, or investigating a signing key.
