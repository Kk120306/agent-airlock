#!/usr/bin/env bash
set -euo pipefail

runtime_engine="${CONTAINER_ENGINE:-docker}"
runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
fixture_port="${AIRLOCK_PROTOCOL_FIXTURE_PORT:-43991}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe_parent="$repo_dir/.local/probes"
mkdir -p "$probe_parent"
probe_root="$(mktemp -d "$probe_parent/airlock-codex-protocol.XXXXXX")"
fixture_log="$probe_root/fixture.log"
codex_output="$probe_root/codex.jsonl"
fixture_pid=""

cleanup() {
  if [[ -n "$fixture_pid" ]]; then
    kill "$fixture_pid" >/dev/null 2>&1 || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  case "$probe_root" in
    "$probe_parent"/airlock-codex-protocol.*) rm -rf -- "$probe_root" ;;
  esac
}
trap cleanup EXIT

AIRLOCK_PROTOCOL_FIXTURE_HOST=0.0.0.0 \
AIRLOCK_PROTOCOL_FIXTURE_PORT="$fixture_port" \
  node "$repo_dir/tests/fixtures/responses-protocol-server.mjs" \
  >"$fixture_log" 2>&1 &
fixture_pid="$!"

fixture_ready=false
for _attempt in {1..50}; do
  if curl --fail --silent --output /dev/null \
    "http://127.0.0.1:$fixture_port/health"; then
    fixture_ready=true
    break
  fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$fixture_ready" != "true" ]]; then
  echo "The local Responses protocol fixture did not start." >&2
  exit 1
fi

mkdir -p "$probe_root/workspace" "$probe_root/codex-home"
chmod -R ugo+rwx "$probe_root"

network_args=()
runtime_user_args=(--user "$(id -u):$(id -g)")
fixture_hostname=host.docker.internal
if [[ "$(basename "$runtime_engine")" == "podman" ]]; then
  fixture_hostname=host.containers.internal
  runtime_user_args+=(--userns keep-id)
else
  network_args+=(--add-host host.docker.internal:host-gateway)
fi

"$runtime_engine" run --rm --init \
  "${network_args[@]}" \
  "${runtime_user_args[@]}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env CODEX_HOME=/codex-home \
  --env HOME=/tmp \
  --env ARK_API_KEY=deterministic-protocol-fixture \
  --mount "type=bind,src=$probe_root/workspace,dst=/workspace" \
  --mount "type=bind,src=$probe_root/codex-home,dst=/codex-home" \
  --workdir /workspace \
  "$runtime_image" \
  codex exec \
  --json \
  --sandbox workspace-write \
  --skip-git-repo-check \
  -C /workspace \
  -c 'model="protocol-fixture"' \
  -c 'model_provider="fixture"' \
  -c "model_providers.fixture={name=\"Fixture\",base_url=\"http://$fixture_hostname:$fixture_port/v1\",env_key=\"ARK_API_KEY\",wire_api=\"responses\",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}" \
  'Create protocol-proof.txt.' \
  >"$codex_output" 2>&1

if [[ "$(<"$probe_root/workspace/protocol-proof.txt")" != "candidate-only" ]]; then
  echo "The real Codex tool call did not create the expected Candidate file." >&2
  exit 1
fi
if ! grep -q 'Protocol fixture completed the requested Candidate edit.' "$codex_output"; then
  echo "The real Codex protocol round trip did not produce an agent message." >&2
  exit 1
fi

printf '%s\n' \
  "Codex Responses protocol probe passed" \
  "Real Codex executed a tool call inside the disposable Runtime" \
  "The tool wrote only to the mounted Candidate workspace" \
  "A second Responses turn returned the final agent message"
