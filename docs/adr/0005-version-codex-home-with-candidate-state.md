---
status: accepted
---

# Version the Codex home with Candidate State

## Context

The starter Runtime receives a writable shared `CODEX_HOME` while Airlock versions only workspace files.
Codex stores rollout transcripts, shell snapshots, and internal state under that directory.
A rejected Run can therefore leave reasoning in the session that a later Run resumes even when its workspace changes are quarantined.

The pinned Runtime image uses Codex CLI `0.111.0`.
A network-disabled probe against that image proved that starting a turn writes session artifacts under `CODEX_HOME` before inference succeeds.
Copying that home and resuming by thread identifier changed only the copy, while an empty home did not resume the requested thread.

## Decision

Every immutable state version and every Run-owned Candidate State contains both `workspace/` and `codex-home/`.
The canonical manifest records both paths, their independent content hashes, the accepted Codex thread identifier, and a composite state hash.
Candidate preparation copies both accepted resources and refreshes only the platform-generated `config.toml` from a global template that contains no credentials.

The local-process Runtime receives the Candidate State Codex home through `CODEX_HOME`.
The container Runtime bind-mounts that same candidate path at `/codex-home`.
Neither Runtime receives the global template home or a canonical Codex home as writable state.

After Codex exits, Airlock requires the returned thread identifier to have a matching rollout JSONL artifact in Candidate State.
Promotion renames the complete candidate root into one immutable version and then atomically replaces `canonical.json`.
Quarantine preserves the complete candidate root, including rejected reasoning, without changing the accepted manifest.

Schema 1 migration copies a legacy rollout and shell snapshot only when the filename matches the stored thread identifier.
A stored thread with no matching rollout is reset to `null` because pretending it is resumable would silently create contradictory continuity.

## Alternatives considered

### Keep only the thread identifier transactional

This was rejected because the identifier does not contain the transcript and Codex state needed to resume it.
A rejected Runtime would still be able to mutate the shared session files behind an unchanged identifier.

### Use `codex exec --ephemeral`

This was rejected because ephemeral execution removes the accepted multi-turn continuity that the starter kit and Phase 3 must preserve.

### Store one global Codex home and copy selected files after success

This was rejected because the shared home is already contaminated before Validation completes and selecting every file related to a turn is more fragile than isolating the whole documented storage boundary.

## Consequences

Workspace files and Agent reasoning now advance or remain unchanged through one canonical manifest decision.
Session storage is duplicated per candidate, which increases preparation cost and storage use.
Codex configuration changes enter the next candidate from the platform template and become accepted only if that candidate promotes.
Crash-journal reconciliation around the final manifest replacement remains a later phase.
