# Local POC

## Free deterministic demo

Use this path for development, judging rehearsal, and deterministic automated evidence.
It builds the production application, binds Fastify to `127.0.0.1:3199`, seeds one `Airlock Demo` Agent, and runs a deterministic local Codex protocol fixture.
It does not require Docker, a ModelArk key, or paid inference.

```bash
npm install
npm run demo -- --reset
```

Open <http://127.0.0.1:3199> and follow the four numbered controls in the `Judge path` strip.
The terminal and Web UI both disclose fixture mode.
The launcher's `ARK_BASE_URL` is an unreachable loopback address, so the fixture path cannot silently make a remote model request.
Server startup rejects partial or remote `AIRLOCK_DEMO_MODE` configurations instead of displaying an inaccurate no-cost disclosure.

Run `npm run demo` without `--reset` to prove that the seeded Agent, conversation, Canonical State, and evidence survive restart.
Set `AIRLOCK_DEMO_PORT` to choose another loopback port.
Set `AIRLOCK_DEMO_DATA_ROOT` to choose another isolated persistent root.
The launcher marks managed demo roots and refuses to reset a nonempty unmarked directory, so a custom root cannot erase unrelated host data accidentally.

Run the exact automated hero journey with:

```bash
npm run test:demo
npm run test:demo:e2e
```

`test:demo` verifies port conflicts, clean reset, process shutdown, seeding, and restart persistence.
`test:demo:e2e` verifies Promotion, destructive Quarantine, unchanged Canonical State, Repair lineage, two accepted mock effects, session continuity, reload persistence, and a 390-pixel layout.

## Real Codex container proof

Use this path to turn the automated Chrome-to-container acceptance gate into an interactive judge demo.
It requires Docker, Colima, or Podman but no ModelArk credential or paid inference.

```bash
npm run demo:runtime -- --reset
```

Open <http://127.0.0.1:3200> and select `Run passing Candidate` under `Paired proof`.
The production control plane launches the pinned real Codex CLI in a disposable container and serves deterministic Responses tool-call events from a host-local fixture.
Codex executes the requested write only inside Candidate State.
Airlock requires `AGENTS.md` and `protocol-proof.txt`, protects `AGENTS.md`, caps the change, and runs `test "$(cat protocol-proof.txt)" = candidate-only` before Promotion.
Then select `Run failing Candidate` to make real Codex write deliberately invalid content in a second isolated Candidate.
The browser must show `REAL RUNTIME PROOF`, the local inference disclosure, the `Run` to `Validate` to `Promote` to `Verify` path, a compact evidence-backed Quarantine verdict, and an unchanged canonical fingerprint.
The canonical workspace must still contain `candidate-only`, while the retained Quarantine contains `unsafe-candidate`.
Open the complete success evidence to show `Journal completed`, then open the rejection evidence to show the decisive `command:protocol-content` failure without crowding the primary judge story.
Select `Generate and verify proof` to create a private-by-default evidence packet and confirm its signature locally.
State persists under the dedicated `.local/airlock-container-demo` root unless `--reset` is supplied.
If the seeded Outcome Contract is edited, restart with `--reset` to restore the guaranteed judge path instead of silently overwriting operator policy.
The launcher never reads `.env`, never calls ModelArk, and refuses any alternate state root.

Run the same journey as an automated Chrome assertion with:

```bash
npm run test:container-browser
```

## Credentialed ModelArk POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the configured ModelArk model API is remote.

No ModelArk credential is required for `npm run demo`, `npm run test:e2e`, or any `npm run check:phase7` verification path.
Those commands use a deterministic local Codex fixture, SQLite, and the atomic mock action consumer without paid inference.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- A ModelArk API key and Responses-capable endpoint or model

```bash
cp .env.example .env
# Fill ARK_API_KEY, ARK_MODEL, and the region-matching ARK_BASE_URL.
# Optionally list activated free-quota fallbacks in ARK_MODEL_FALLBACKS.
npm run check:modelark
npm run poc:doctor
npm run poc
```

`npm run poc` loads `.env` automatically.
`npm run poc:doctor` proves each live prerequisite, Candidate session copy isolation, and a real two-turn Codex tool call against a local Responses fixture without printing configured values, model output, provider request identifiers, or account metadata.
Use its result before the live demo to distinguish a ModelArk capacity failure from a container or application failure.
Before building the Runtime, it performs a minimal Responses API request and prints neither the credential nor model output.
`ARK_MODEL_FALLBACKS` accepts a comma-separated list of operator-approved models and is bounded to four unique models including `ARK_MODEL`.
Only HTTP 404 and 429 advance to the next model.
Allowlisted temporary capacity and burst-protection responses receive a bounded warm-up, with numeric `Retry-After` guidance capped at 10 seconds per wait and 15 seconds across the configured model list.
Authentication, network, timeout, malformed-response, and all other failures stop immediately.
The model that completes preflight becomes the Runtime's `ARK_MODEL`.
Keep Free Credits Only Mode enabled for every activated model because the launcher does not change or verify account billing settings.
Confirm that every configured model is activated and visibly has remaining free quota in Model activation before the demo.
Use `AIRLOCK_SKIP_MODELARK_PREFLIGHT=true` only to bypass that fail-fast provider check explicitly.
Explicit process environment variables take precedence.
Keep the Beijing default for mainland Volcengine credentials.
For BytePlus Asia Pacific credentials, use:

```dotenv
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
```

See [BytePlus region availability](https://docs.byteplus.com/en/docs/ModelArk/2191806) when selecting a regional data-plane URL.

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Each turn mounts only the selected Candidate workspace, Candidate Codex session directory, and fresh Candidate outbox.
The canonical resources and platform-owned mock delivery store are never mounted into the Runtime.
Repair Runs additionally receive a disposable copy of the exact matching Canonical workspace.
The container provider mounts that copy read-only, Airlock verifies its hash before Promotion, and the copy is removed from the repaired state before installation.
Set `AIRLOCK_MAX_REPAIR_DEPTH` to a value from one through five to change the bounded repair ancestry limit from its default of two.
Set `AIRLOCK_CANDIDATE_RETENTION_HOURS` to change the 24-hour mutable Candidate retention window.
Set `AIRLOCK_QUARANTINE_RETENTION_HOURS` to change the 168-hour mutable Quarantine retention window.
Both retention settings are positive hour values, and active or unresolved Promotion Runs are protected from cleanup.
The platform-owned Promotion journal lives under `APP_DATA_DIR/promotion-journal`, outside every Runtime mount, and is reconciled before active-Run cleanup on restart.
See the [recovery guide](RECOVERY.md) for phases, fault outcomes, and fail-closed operator guidance.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

A Repair action returns a conflict when Canonical State advanced after the selected Quarantine, another repair child already exists, the ancestry limit is exhausted, or mutable Quarantine state is no longer available.
Start a new normal Run against current reality when the selected Quarantine is stale.

ModelArk credentials and endpoints are isolated by provider and region.
A `401` response saying that the API key does not exist usually means the key is invalid or `ARK_BASE_URL` points to the wrong provider or region.
A `404` response saying that a model or endpoint does not exist usually means `ARK_MODEL` is incorrect, unavailable to the API key, not activated, or belongs to another region.
Confirm all three Ark values together before retrying.
The live preflight and a complete browser-to-container Promotion passed against the BytePlus Asia Pacific Responses API on 2026-08-27.

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
