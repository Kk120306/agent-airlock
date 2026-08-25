---
status: accepted
---

# Contain validation commands and bound persisted evidence

## Context

Outcome Contracts may execute commands supplied by the operator against code produced by an untrusted Agent.
Running those commands on the host would allow Candidate State to reach the control plane, Canonical State, credentials, or unrelated files.
Unbounded output or duration could also exhaust the control plane or leak sensitive values into durable evidence.

## Decision

Structural Validations run in the trusted control plane and inspect Candidate State without following symbolic links.
Project validation commands run in a fresh Docker or Podman container using the configured Runtime image.
Before each command, Airlock copies Candidate State into a run-owned disposable validation workspace.
The container receives that disposable copy as its only project mount.
The mount is writable because build and test tools may create artifacts, but it is deleted after the command and can never become Canonical State.
The container root filesystem is read-only.

Every validation container has these controls:

- Network mode `none`.
- All Linux capabilities dropped.
- `no-new-privileges` enabled.
- A read-only root filesystem.
- Configured CPU, memory, process, and user limits.
- A 64 MiB temporary filesystem at `/tmp` with `nosuid`, `nodev`, and `noexec`.
- No Ark key, bearer token, Codex session mount, Candidate State mount, canonical workspace, or inherited application environment.

The API accepts command timeouts from 1 second through 300 seconds.
The executor terminates a command after its configured timeout.
The executor terminates a command after combined standard output and standard error exceed 65,536 bytes.
Persisted command output is redacted and then limited to 16,384 bytes.
Mandatory Ark assignment and bearer-token redaction remains active even if the operator removes the corresponding contract patterns.

Workspace evidence is also bounded.
Inventory stops at 10,000 entries.
The persisted change list retains at most 200 paths while preserving complete counts.
Secret scanning rejects changed files larger than 1 MiB rather than persisting or scanning their contents.
Evidence names a matched path and pattern but never stores the matched value.

## Alternatives considered

### Run commands directly on the host

This was rejected because process environment filtering alone does not provide a filesystem or network boundary.

### Reuse the Agent Runtime container

This was rejected because validation needs a fresh environment with a smaller credential and mount surface after Agent execution has ended.

### Persist complete command logs and diffs

This was rejected because large or sensitive output would turn evidence into a denial-of-service and credential-retention surface.

## Consequences

Validation requires a working configured container engine whenever a contract contains commands.
A container startup failure becomes required or optional evidence according to the command severity.
The qualifying browser fixture uses structural Validations by default and does not require Docker for every test Run.
An opt-in integration test executes the command boundary against the real Runtime image.
