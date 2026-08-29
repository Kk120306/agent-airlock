#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    colima start >&2
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$(uname -s)" == "Darwin" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      podman machine start >&2 || true
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install one of them, start it, and rerun this command."
  return 1
}

if [[ -z "${ARK_API_KEY:-}" || -z "${ARK_MODEL:-}" ]]; then
  log "ARK_API_KEY and ARK_MODEL are required."
  log "Example: ARK_API_KEY=key ARK_MODEL=dola-seed-2-1-turbo-260628 ./scripts/start-local-poc.sh"
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

if [[ "${AIRLOCK_SKIP_MODELARK_PREFLIGHT:-false}" == "true" ]]; then
  if [[ "${AIRLOCK_MODELARK_DEMO_MODE:-false}" == "true" ]]; then
    log "The live ModelArk judge profile cannot skip provider preflight."
    exit 2
  fi
  unset AIRLOCK_MODELARK_PREFLIGHT_PROOF
  log "Skipping the live ModelArk preflight by explicit request."
else
  log "Checking the live ModelArk Responses API before building the Runtime."
  preflight_result="$(node scripts/check-modelark-live.mjs --launch-result-json)"
  selected_model="$(node -e '
    const result = JSON.parse(process.argv[1]);
    const configuredModels = [
      process.env.ARK_MODEL,
      ...(process.env.ARK_MODEL_FALLBACKS ?? "").split(","),
    ]
      .map((value) => value?.trim())
      .filter(Boolean);
    const models = [...new Set(configuredModels)];
    if (
      !Number.isInteger(result.selectedModelIndex) ||
      result.selectedModelIndex < 0 ||
      result.selectedModelIndex >= models.length
    ) {
      console.error("[local-poc] ModelArk preflight returned an invalid model selection.");
      process.exit(2);
    }
    process.stdout.write(models[result.selectedModelIndex]);
  ' "$preflight_result")"
  AIRLOCK_MODELARK_PREFLIGHT_PROOF="$(node -e 'const result = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(result.proof));' "$preflight_result")"
  export AIRLOCK_MODELARK_PREFLIGHT_PROOF
  if [[ "$selected_model" != "$ARK_MODEL" ]]; then
    log "Using the operator-approved ModelArk fallback that passed the live preflight."
  fi
  export ARK_MODEL="$selected_model"
fi

engine="$(detect_engine)"
log "Using $engine as the Agent Runtime engine."

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  export APP_DATA_DIR="$local_state_root/data"
  export AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  export CODEX_HOME="$local_state_root/codex-home"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  local_state_root="${HOME}/.volc-agent-launchpad"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
else
  local_state_root="$repo_dir/.local"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
fi
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"
log "Persistent state: $local_state_root"
export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"

log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
"$engine" build \
  --file Dockerfile.runtime \
  --build-arg "NODE_IMAGE=$runtime_base_image" \
  --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
  --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
  --tag "$runtime_image" \
  .

log "Checking that the Runtime can bind-mount the configured state directories."
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi
if ! "$engine" run --rm \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm "$runtime_image" \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export NODE_ENV=production
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
}
trap cleanup EXIT INT TERM

# Recover cleanly after a terminal or server crash from a previous local run.
cleanup

log "Building the local Web and API."
npm run build

log "Open http://localhost:$PORT"
npm start
