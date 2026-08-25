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
| JSON control-plane store | Operator-facing Agent, Run, message, and receipt metadata. |

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
2. Scan and reconcile Promotion journals.
3. Retain a valid interrupted pre-decision Candidate in Quarantine or cancel the Run when no Candidate exists.
4. Reconcile each Agent's canonical reference from `canonical.json`.
5. Remove expired unprotected Candidate or Quarantine directories.
6. Persist recovered Runs, receipts, assistant messages, Agent states, and retention dispositions.

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
| Any physical contradiction | The Run and Agent enter `recovery-error`, Canonical State is not rewritten, and no new effect is claimed. |

## Retention

`AIRLOCK_CANDIDATE_RETENTION_HOURS` defaults to 24 hours.
`AIRLOCK_QUARANTINE_RETENTION_HOURS` defaults to 168 hours.
Both settings accept positive values up to 8,760 hours.

Active or unresolved journal Run identifiers are protected from cleanup.
Cleanup accepts no caller-supplied path, rejects unsafe identifiers, does not traverse symbolic links, and scans only `.candidates` and `.quarantine`.
Expired Quarantine loses mutable files but retains output, Validation evidence, hashes, lineage, timeline, and its Promotion Receipt.

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
