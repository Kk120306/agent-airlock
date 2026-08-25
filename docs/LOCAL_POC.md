# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the configured ModelArk model API is remote.

No ModelArk credential is required for `npm run test:e2e` or `npm run check:phase5`.
Those commands use a deterministic local Codex fixture, SQLite, and the atomic mock action consumer without paid inference.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- A ModelArk API key and Responses-capable endpoint or model

```bash
cp .env.example .env
# Fill ARK_API_KEY, ARK_MODEL, and the region-matching ARK_BASE_URL.
npm run poc
```

`npm run poc` loads `.env` automatically.
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
