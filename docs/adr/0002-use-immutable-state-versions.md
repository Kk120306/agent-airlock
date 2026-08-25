---
status: accepted
---

# Use immutable state versions and an atomic canonical manifest

## Context

The starter workspace is a mutable directory that the Runtime mounts directly.
Agent Airlock needs a physical state model where a rejected Run Transaction cannot partially change the workspace used by the next Run.
The model must also preserve prior accepted versions and leave room for later Codex session and Transactional Resource coordination.

## Decision

Each Agent owns immutable version directories under its workspace root.
The Agent's `canonical.json` manifest identifies the only version accepted as Canonical State.
Every Run Transaction receives a copied Candidate State under a run-owned directory that is the only workspace exposed to the Runtime.

Promotion moves the candidate workspace into its immutable version directory and then atomically replaces `canonical.json`.
Quarantine moves a rejected candidate under the Quarantine root without changing the canonical manifest.
Configuration changes create and promote a new version instead of modifying the current canonical directory.
The content hash stored in the canonical manifest is verified whenever Canonical State is resolved.

## Alternatives considered

### Mutate the accepted workspace and restore a backup

This was rejected because a crash or irreversible effect can occur before restoration.
It also makes unchanged Canonical State harder to prove.

### Use Git branches as the state registry

This was rejected because workspaces are not guaranteed to be Git repositories and later Transactional Resources will not all be Git-backed.
Git may still be used inside an Agent workspace without becoming Airlock's source of truth.

### Replace one mutable canonical directory during Promotion

This was rejected because prior accepted state would not remain independently addressable and multi-resource promotion would lack a stable version identifier.

## Consequences

Rejected, failed, and cancelled Run Transactions can leave the canonical identifier and content hash unchanged.
The Runtime never needs a writable canonical workspace mount.
Preparation currently copies the workspace, so very large workspaces may have noticeable preparation latency.
Phase 1 does not yet provide a durable multi-step Promotion journal, so crash reconciliation around manifest replacement remains Phase 6 work.
Codex session state remains outside this decision until the Phase 3 session-isolation proof is complete.
