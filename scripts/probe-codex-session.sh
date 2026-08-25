#!/usr/bin/env bash

set -euo pipefail

runtime_engine="${CONTAINER_ENGINE:-docker}"
runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
probe_root="$(mktemp -d /tmp/airlock-codex-session.XXXXXX)"
probe_uid="$(id -u)"
probe_gid="$(id -g)"

cleanup() {
  case "$probe_root" in
    /tmp/airlock-codex-session.*) rm -rf -- "$probe_root" ;;
  esac
}
trap cleanup EXIT

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

thread_from() {
  sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

run_codex() {
  local codex_home="$1"
  local workspace="$2"
  local output="$3"
  shift 3
  "$runtime_engine" run --rm \
    --network none \
    --user "$probe_uid:$probe_gid" \
    --env CODEX_HOME=/codex-home \
    --env HOME=/tmp \
    --env ARK_API_KEY=network-disabled-diagnostic \
    --mount "type=bind,src=$workspace,dst=/workspace" \
    --mount "type=bind,src=$codex_home,dst=/codex-home" \
    --workdir /workspace \
    "$runtime_image" \
    codex exec \
    --skip-git-repo-check \
    --json \
    -c 'model="diagnostic-model"' \
    -c 'model_provider="diagnostic"' \
    -c 'model_providers.diagnostic={name="Diagnostic",base_url="http://127.0.0.1:9/v1",env_key="ARK_API_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}' \
    "$@" >"$output" 2>/dev/null || true
}

mkdir -p \
  "$probe_root/original/workspace" \
  "$probe_root/original/codex-home"

runtime_version="$($runtime_engine run --rm "$runtime_image" codex --version 2>/dev/null)"
run_codex \
  "$probe_root/original/codex-home" \
  "$probe_root/original/workspace" \
  "$probe_root/original.jsonl" \
  "Record this network-disabled diagnostic turn."

thread_id="$(thread_from "$probe_root/original.jsonl")"
if [[ -z "$thread_id" ]]; then
  echo "Codex did not emit a thread identifier" >&2
  exit 1
fi

session_file="$(find "$probe_root/original/codex-home/sessions" -type f -name "*$thread_id*.jsonl" -print -quit 2>/dev/null || true)"
if [[ -z "$session_file" ]]; then
  echo "Codex did not persist the emitted thread under CODEX_HOME" >&2
  exit 1
fi

original_hash="$(hash_file "$session_file")"
mkdir -p "$probe_root/copied/workspace" "$probe_root/copied/codex-home"
cp -a "$probe_root/original/codex-home/." "$probe_root/copied/codex-home/"
run_codex \
  "$probe_root/copied/codex-home" \
  "$probe_root/copied/workspace" \
  "$probe_root/copied.jsonl" \
  resume "$thread_id" "Continue only inside the copied session."

copied_thread_id="$(thread_from "$probe_root/copied.jsonl")"
if [[ "$copied_thread_id" != "$thread_id" ]]; then
  echo "The copied Codex home did not resume the original thread" >&2
  exit 1
fi
if [[ "$(hash_file "$session_file")" != "$original_hash" ]]; then
  echo "Resuming the copied Codex home mutated the original session" >&2
  exit 1
fi

mkdir -p "$probe_root/empty/workspace" "$probe_root/empty/codex-home"
run_codex \
  "$probe_root/empty/codex-home" \
  "$probe_root/empty/workspace" \
  "$probe_root/empty.jsonl" \
  resume "$thread_id" "This empty home must not continue the accepted thread."

empty_thread_id="$(thread_from "$probe_root/empty.jsonl")"
if [[ -z "$empty_thread_id" || "$empty_thread_id" == "$thread_id" ]]; then
  echo "An empty Codex home unexpectedly resumed the accepted thread" >&2
  exit 1
fi

printf '%s\n' \
  "Codex session isolation probe passed" \
  "Runtime: $runtime_version" \
  "Copied CODEX_HOME resumed $thread_id without mutating the original" \
  "Empty CODEX_HOME started a different thread"
