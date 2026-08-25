# ADR 0006: Defer external actions until Promotion

## Status

Accepted for the Phase 4 proof of concept.

## Context

An Agent can modify files and data inside Candidate State without changing accepted reality.
An external notification cannot be rolled back after delivery, so letting the Runtime call a consumer directly would break the Airlock guarantee.
The demonstration needs a real irreversible boundary without claiming a distributed transaction across arbitrary providers.

## Decision

The Runtime may submit only the versioned `demo.notification.requested` intent through the candidate-owned JSONL path named by `AIRLOCK_OUTBOX_PATH`.
The outbox directory is a separate writable Candidate State mount rather than a file in the workspace.
This prevents an accepted intent from being copied automatically into the next candidate and replayed as a new request.

The control plane parses the outbox after Runtime exit and before Promotion.
It rejects malformed JSON, unknown fields or types, duplicate intent identifiers, oversized fields, oversized files, and excessive intent counts.
The idempotency key hashes the Run identifier, intent identifier, action type, and normalized payload.

The complete candidate root, including its outbox, is moved into the immutable version before `canonical.json` advances.
Only after the manifest identifies that promoted version may the dispatcher claim the effect.
Rejected and cancelled candidates never reach the dispatcher.

The Phase 4 consumer is an atomic local mock-delivery store under `APP_DATA_DIR`.
Its durable idempotency-key uniqueness makes duplicate and concurrent dispatch attempts return the original receipt while storing one effect.
Exactly-once behavior is claimed only inside this mock boundary.

## Consequences

The browser can show one disposition across workspace, Agent memory, SQLite, and the supported external action.
A rejected intent remains inspectable in Quarantine and creates no delivery.
A promoted intent has bounded evidence tying it to a post-Promotion receipt.

There is still a crash window after the manifest advances and before dispatch completes.
The promoted version retains the validated outbox so a later journal and recovery worker can reconcile that window without changing this contract.
That recovery worker is Phase 6 scope.

Unrestricted Runtime network egress can bypass the supported outbox entirely.
The POC discloses this limitation and does not claim to intercept arbitrary network traffic.
