#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_NONCE="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
IMAGE_TAG="agent-airlock-phase11-gate:$GATE_NONCE"
FIXTURE_CONTAINER_NAME="agent-airlock-phase11-fixture-$GATE_NONCE"
GATE_COMPOSE_PROJECT="agent-airlock-phase11-$GATE_NONCE"
OWNER_LABEL="io.codejam.production-gate-owner=$GATE_NONCE"
FIXTURE_OWNER_LABEL="io.codejam.production-gate-fixture-owner=$GATE_NONCE"
AUTH_TOKEN="phase11-container-verification-token"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
SESSION_BASE="$PROJECT_ROOT/.local/production-image-gate"
SESSION_ROOT=""
SESSION_BASE_PHYSICAL=""
SESSION_BASE_ID=""
PRODUCT_ENV_FILE=""
TRANSACTION_PROOF_FILE=""
PHYSICAL_PROOF_FILE=""
IMAGE_ID=""
SOURCE_ARCHIVE=""
SOURCE_ARCHIVE_SHA256=""
SOURCE_COMMIT=""
SOURCE_IDENTITY=""
SOURCE_TREE=""
DATA_SANDBOX_SENTINEL=""
WORKSPACE_SANDBOX_SENTINEL=""
DATA_SANDBOX_SENTINEL_CONTENT=""
WORKSPACE_SANDBOX_SENTINEL_CONTENT=""
ORIGIN=""
COMPOSE_STARTED=false
COMPOSE_CONTAINER_ID=""
FIXTURE_CONTAINER_ID=""
IMAGE_BUILD_ATTEMPTED=false
COMPOSE_NETWORK_OWNED=false
PRODUCTION_IMAGE_ARTIFACT_DIRECTORY="${PRODUCTION_IMAGE_ARTIFACT_DIRECTORY:-}"

product_compose() {
  docker compose \
    --project-name "$GATE_COMPOSE_PROJECT" \
    --file "$PROJECT_ROOT/docker-compose.yml" \
    "$@"
}

path_identity() {
  local identity
  if identity="$(stat -c '%d:%i' "$1" 2>/dev/null)"; then
    printf '%s' "$identity"
    return
  fi
  stat -f '%d:%i' "$1"
}

assert_sandbox_sentinels() {
  PRODUCTION_GATE_DATA_SENTINEL="$DATA_SANDBOX_SENTINEL" \
  PRODUCTION_GATE_DATA_SENTINEL_CONTENT="$DATA_SANDBOX_SENTINEL_CONTENT" \
  PRODUCTION_GATE_DATA_ROOT="$SESSION_ROOT/data" \
  PRODUCTION_GATE_WORKSPACE_SENTINEL="$WORKSPACE_SANDBOX_SENTINEL" \
  PRODUCTION_GATE_WORKSPACE_SENTINEL_CONTENT="$WORKSPACE_SANDBOX_SENTINEL_CONTENT" \
  PRODUCTION_GATE_WORKSPACE_ROOT="$SESSION_ROOT/workspaces" \
    node --input-type=module -e '
      import { lstat, readFile, realpath } from "node:fs/promises";
      import path from "node:path";
      const sentinels = [
        {
          expected: process.env.PRODUCTION_GATE_DATA_SENTINEL_CONTENT,
          file: process.env.PRODUCTION_GATE_DATA_SENTINEL,
          root: process.env.PRODUCTION_GATE_DATA_ROOT,
        },
        {
          expected: process.env.PRODUCTION_GATE_WORKSPACE_SENTINEL_CONTENT,
          file: process.env.PRODUCTION_GATE_WORKSPACE_SENTINEL,
          root: process.env.PRODUCTION_GATE_WORKSPACE_ROOT,
        },
      ];
      for (const sentinel of sentinels) {
        const [metadata, physicalFile, physicalRoot] = await Promise.all([
          lstat(sentinel.file),
          realpath(sentinel.file),
          realpath(sentinel.root),
        ]);
        const bytes = await readFile(sentinel.file);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          path.dirname(physicalFile) !== physicalRoot ||
          !bytes.equals(Buffer.from(sentinel.expected + "\n", "utf8"))
        ) {
          throw new Error("Production image Runtime changed a protected sandbox sentinel");
        }
      }
    '
}

remove_protocol_fixture() {
  local container_ids
  if ! container_ids="$(docker ps --all --quiet \
    --filter "label=$FIXTURE_OWNER_LABEL")"; then
    echo "Could not inspect the owned protocol fixture during cleanup." >&2
    return 1
  fi
  if [ -z "$FIXTURE_CONTAINER_ID" ] && [ -n "$container_ids" ]; then
    if [ "$(printf '%s\n' "$container_ids" | wc -l | tr -d ' ')" != "1" ] || \
      ! docker inspect --format '{{.Name}}' "$container_ids" 2>/dev/null | \
        grep -qx "/$FIXTURE_CONTAINER_NAME"; then
      echo "Owned protocol fixture identity was ambiguous during cleanup." >&2
      return 1
    fi
    FIXTURE_CONTAINER_ID="$container_ids"
  fi
  if [ -n "$FIXTURE_CONTAINER_ID" ]; then
    if ! docker inspect --format '{{ index .Config.Labels "io.codejam.production-gate-fixture-owner" }}' \
      "$FIXTURE_CONTAINER_ID" 2>/dev/null | grep -qx "$GATE_NONCE"; then
      echo "Refusing to remove a protocol fixture without the exact ownership label." >&2
      return 1
    fi
    if ! docker rm --force "$FIXTURE_CONTAINER_ID" >/dev/null; then
      echo "Could not remove the owned protocol fixture." >&2
      return 1
    fi
  fi
  if ! container_ids="$(docker ps --all --quiet \
    --filter "label=$FIXTURE_OWNER_LABEL")"; then
    echo "Could not confirm protocol fixture absence after cleanup." >&2
    return 1
  fi
  if [ -n "$container_ids" ]; then
    echo "Owned protocol fixture remained after cleanup." >&2
    return 1
  fi
  FIXTURE_CONTAINER_ID=""
}

remove_compose_project() {
  local container_ids
  local network_ids
  local recorded_container_ids
  if [ "$COMPOSE_STARTED" = true ]; then
    if ! product_compose down --remove-orphans >/dev/null; then
      echo "Could not tear down the owned Compose project." >&2
      return 1
    fi
  fi
  if ! container_ids="$(docker ps --all --quiet \
    --filter "label=com.docker.compose.project=$GATE_COMPOSE_PROJECT")"; then
    echo "Could not inspect the owned Compose project during cleanup." >&2
    return 1
  fi
  if [ -n "$container_ids" ]; then
    echo "Owned Compose containers remained after cleanup: $container_ids" >&2
    return 1
  fi
  if [ -n "$COMPOSE_CONTAINER_ID" ]; then
    if ! recorded_container_ids="$(docker ps --all --quiet --no-trunc \
      --filter "id=$COMPOSE_CONTAINER_ID")"; then
      echo "Could not confirm the recorded Compose container was removed." >&2
      return 1
    fi
    if [ -n "$recorded_container_ids" ]; then
      echo "Recorded Compose container remained after cleanup." >&2
      return 1
    fi
  fi
  if [ "$COMPOSE_NETWORK_OWNED" = true ]; then
    if ! network_ids="$(docker network ls --quiet --no-trunc \
      --filter "name=^${GATE_COMPOSE_PROJECT}_default$")"; then
      echo "Could not confirm the owned Compose network was removed." >&2
      return 1
    fi
    if [ -n "$network_ids" ]; then
      echo "Owned Compose network remained after cleanup." >&2
      return 1
    fi
  fi
  COMPOSE_STARTED=false
  COMPOSE_CONTAINER_ID=""
  COMPOSE_NETWORK_OWNED=false
}

remove_product_image() {
  local image_ids
  local image_owner
  if ! image_ids="$(docker image ls --quiet --no-trunc "$IMAGE_TAG")"; then
    echo "Could not inspect the owned production-gate image during cleanup." >&2
    return 1
  fi
  if [ "$IMAGE_BUILD_ATTEMPTED" = true ] && [ -n "$image_ids" ]; then
    if [ "$(printf '%s\n' "$image_ids" | wc -l | tr -d ' ')" != "1" ]; then
      echo "Refusing to remove an ambiguous production-gate image identity." >&2
      return 1
    fi
    if [ -n "$IMAGE_ID" ] && [ "$image_ids" != "$IMAGE_ID" ]; then
      echo "Refusing to remove a production-gate tag whose image identity changed." >&2
      return 1
    fi
    if ! image_owner="$(docker image inspect --format '{{ index .Config.Labels "io.codejam.production-gate-image-owner" }}' "$image_ids")" || \
      [ "$image_owner" != "$GATE_NONCE" ]; then
      echo "Refusing to remove a production-gate image without the exact ownership label." >&2
      return 1
    fi
    if ! docker image rm "$IMAGE_TAG" >/dev/null; then
      echo "Could not remove the owned production-gate image." >&2
      return 1
    fi
  fi
  if ! image_ids="$(docker image ls --quiet --no-trunc "$IMAGE_TAG")"; then
    echo "Could not confirm production-gate image absence after cleanup." >&2
    return 1
  fi
  if [ -n "$image_ids" ]; then
    echo "Owned production-gate image remained after cleanup." >&2
    return 1
  fi
  IMAGE_BUILD_ATTEMPTED=false
}

safe_remove_session_root() {
  local current_base_id
  local current_base_physical
  local session_leaf
  local session_physical
  local tombstone_leaf
  if [ -z "$SESSION_ROOT" ] || [ ! -d "$SESSION_ROOT" ]; then
    return
  fi
  case "$SESSION_ROOT" in
    "$SESSION_BASE"/session.*) ;;
    *)
      echo "Refusing to remove an unexpected production-image session root." >&2
      return 1
      ;;
  esac
  if [ -L "$SESSION_ROOT" ]; then
    echo "Refusing to remove a symlinked production-image session root." >&2
    return 1
  fi
  if [ -L "$PROJECT_ROOT/.local" ] || [ -L "$SESSION_BASE" ]; then
    echo "Refusing cleanup after a production-image session ancestor changed to a symlink." >&2
    return 1
  fi
  if ! current_base_physical="$(cd "$SESSION_BASE" && pwd -P)" || \
    ! current_base_id="$(path_identity "$SESSION_BASE")"; then
    echo "Could not revalidate the production-image session base." >&2
    return 1
  fi
  if [ "$current_base_physical" != "$SESSION_BASE_PHYSICAL" ] || \
    [ "$current_base_id" != "$SESSION_BASE_ID" ]; then
    echo "Refusing cleanup after the production-image session base identity changed." >&2
    return 1
  fi
  if ! session_physical="$(cd "$SESSION_ROOT" && pwd -P)"; then
    echo "Could not resolve the production-image session root for cleanup." >&2
    return 1
  fi
  case "$session_physical" in
    "$SESSION_BASE_PHYSICAL"/session.*) ;;
    *)
      echo "Refusing to remove a production-image session outside its physical base." >&2
      return 1
      ;;
  esac
  session_leaf="${SESSION_ROOT##*/}"
  case "$session_leaf" in
    session.*) ;;
    *)
      echo "Refusing a non-session leaf during production-image cleanup." >&2
      return 1
      ;;
  esac
  tombstone_leaf=".cleanup.$GATE_NONCE"
  if ! (
    cd "$SESSION_BASE_PHYSICAL" &&
    [ "$(path_identity .)" = "$SESSION_BASE_ID" ] &&
    [ ! -e "$tombstone_leaf" ] &&
    [ ! -L "$tombstone_leaf" ] &&
    mv "$session_leaf" "$tombstone_leaf" &&
    [ -d "$tombstone_leaf" ] &&
    [ ! -L "$tombstone_leaf" ] &&
    [ "$(path_identity .)" = "$SESSION_BASE_ID" ] &&
    rm -rf -- "$tombstone_leaf" &&
    [ ! -e "$tombstone_leaf" ] &&
    [ ! -L "$tombstone_leaf" ]
  ); then
    echo "Anchored production-image session cleanup failed closed." >&2
    return 1
  fi
  SESSION_ROOT=""
}

cleanup() {
  local cleanup_failed=0
  if ! remove_protocol_fixture; then
    cleanup_failed=1
  fi
  if ! remove_compose_project; then
    cleanup_failed=1
  fi
  if ! remove_product_image; then
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" -ne 0 ]; then
    echo "Preserving the production-image session because owned Docker cleanup was not confirmed." >&2
    return 1
  fi
  safe_remove_session_root
}

on_exit() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    product_compose logs --no-color launchpad >&2 2>/dev/null || true
    if [ -n "$FIXTURE_CONTAINER_ID" ] && \
      docker inspect --format '{{ index .Config.Labels "io.codejam.production-gate-fixture-owner" }}' \
        "$FIXTURE_CONTAINER_ID" 2>/dev/null | grep -qx "$GATE_NONCE"; then
      docker logs "$FIXTURE_CONTAINER_ID" >&2 2>/dev/null || true
    fi
  fi
  cleanup || status=1
  exit "$status"
}
trap on_exit EXIT

wait_for_product_container() {
  local attempt
  local container_id
  local port_mapping
  local host_port
  for attempt in $(seq 1 100); do
    port_mapping="$(product_compose port launchpad 3000 2>/dev/null || true)"
    host_port="${port_mapping##*:}"
    if [[ "$host_port" =~ ^[0-9]+$ ]]; then
      ORIGIN="http://127.0.0.1:$host_port"
      if node scripts/production-image-verifier.mjs --origin "$ORIGIN" \
        >/dev/null 2>&1; then
        return
      fi
    fi
    container_id="$(product_compose ps --quiet launchpad 2>/dev/null || true)"
    if [ -z "$container_id" ] || \
      ! docker inspect --format '{{.State.Running}}' "$container_id" \
        2>/dev/null | grep -qx true; then
      echo "Phase 11 Compose service exited before becoming healthy." >&2
      return 1
    fi
    sleep 0.2
  done
  echo "Phase 11 Compose service did not become healthy." >&2
  return 1
}

start_product_container() {
  local existing_containers
  local existing_networks
  local product_image_id
  if [ "$COMPOSE_NETWORK_OWNED" = false ]; then
    if ! existing_containers="$(docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$GATE_COMPOSE_PROJECT")" || \
      [ -n "$existing_containers" ]; then
      echo "Phase 11 refused a pre-existing Compose project identity." >&2
      return 1
    fi
    if ! existing_networks="$(docker network ls --quiet --no-trunc \
      --filter "name=^${GATE_COMPOSE_PROJECT}_default$")"; then
      echo "Phase 11 could not inspect the Compose network identity." >&2
      return 1
    fi
    if [ -n "$existing_networks" ]; then
      echo "Phase 11 refused a pre-existing Compose network identity." >&2
      return 1
    fi
    COMPOSE_NETWORK_OWNED=true
  fi
  COMPOSE_STARTED=true
  product_compose up --detach --no-build launchpad >/dev/null
  COMPOSE_CONTAINER_ID="$(product_compose ps --quiet launchpad)"
  if [ -z "$COMPOSE_CONTAINER_ID" ] || \
    ! docker inspect --format '{{ index .Config.Labels "io.codejam.production-gate-owner" }}' \
      "$COMPOSE_CONTAINER_ID" | grep -qx "$GATE_NONCE"; then
    echo "Phase 11 Compose service ownership could not be established." >&2
    return 1
  fi
  if ! product_image_id="$(docker inspect --format '{{.Image}}' \
    "$COMPOSE_CONTAINER_ID")" || [ "$product_image_id" != "$IMAGE_ID" ]; then
    echo "Phase 11 Compose service did not run the exact tested image ID." >&2
    return 1
  fi
  wait_for_product_container
}

stop_protocol_fixture() {
  remove_protocol_fixture
}

stop_product_container() {
  stop_protocol_fixture
  product_compose stop --timeout 15 launchpad >/dev/null
  product_compose rm --force launchpad >/dev/null
  if [ -n "$(product_compose ps --all --quiet launchpad)" ]; then
    echo "Phase 11 Compose service remained after the restart boundary stop." >&2
    return 1
  fi
  ORIGIN=""
}

start_protocol_fixture() {
  local existing_fixture_ids
  local product_container_id
  product_container_id="$(product_compose ps --quiet launchpad)"
  if [ -z "$product_container_id" ]; then
    echo "Phase 11 Compose service container identity is unavailable." >&2
    return 1
  fi
  if ! existing_fixture_ids="$(docker ps --all --quiet --no-trunc \
    --filter "name=^/${FIXTURE_CONTAINER_NAME}$")"; then
    echo "Phase 11 could not inspect the protocol fixture container name." >&2
    return 1
  fi
  if [ -n "$existing_fixture_ids" ]; then
    echo "Phase 11 refused a pre-existing protocol fixture container name." >&2
    return 1
  fi
  docker run --detach \
    --name "$FIXTURE_CONTAINER_NAME" \
    --label "$FIXTURE_OWNER_LABEL" \
    --network "container:$product_container_id" \
    --user "$HOST_UID:$HOST_GID" \
    --read-only \
    --init \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --pids-limit 64 \
    --memory 256m \
    --cpus 1 \
    --mount "type=bind,src=$PROJECT_ROOT/tests/fixtures/responses-protocol-server.mjs,dst=/fixture/responses-protocol-server.mjs,readonly" \
    --env AIRLOCK_PROTOCOL_FIXTURE_HOST=127.0.0.1 \
    --env AIRLOCK_PROTOCOL_FIXTURE_PORT=43991 \
    "$IMAGE_ID" node /fixture/responses-protocol-server.mjs >"$SESSION_ROOT/fixture-container-id"
  FIXTURE_CONTAINER_ID="$(tr -d '\r\n' < "$SESSION_ROOT/fixture-container-id")"
  if [ -z "$FIXTURE_CONTAINER_ID" ] || \
    ! docker inspect --format '{{ index .Config.Labels "io.codejam.production-gate-fixture-owner" }}' \
      "$FIXTURE_CONTAINER_ID" | grep -qx "$GATE_NONCE"; then
    echo "Phase 11 protocol fixture ownership could not be established." >&2
    return 1
  fi
  if [ "$(docker inspect --format '{{.Image}}' "$FIXTURE_CONTAINER_ID")" != \
    "$IMAGE_ID" ]; then
    echo "Phase 11 protocol fixture did not run the exact tested image ID." >&2
    return 1
  fi
  local attempt
  for attempt in $(seq 1 100); do
    if docker exec "$product_container_id" node -e \
      "fetch('http://127.0.0.1:43991/health').then(response => process.exit(response.status === 204 ? 0 : 1)).catch(() => process.exit(1))" \
      >/dev/null 2>&1; then
      return
    fi
    if ! docker inspect --format '{{.State.Running}}' "$FIXTURE_CONTAINER_NAME" \
      2>/dev/null | grep -qx true; then
      echo "Phase 11 protocol fixture exited before becoming healthy." >&2
      return 1
    fi
    sleep 0.1
  done
  echo "Phase 11 protocol fixture did not become healthy." >&2
  return 1
}

assert_compose_service_contract() {
  product_compose config --format json | \
    EXPECTED_IMAGE="$IMAGE_TAG" \
    EXPECTED_USER="$HOST_UID:$HOST_GID" \
    EXPECTED_PROJECT_ROOT="$PROJECT_ROOT" \
    EXPECTED_DATA="$SESSION_ROOT/data" \
    EXPECTED_WORKSPACES="$SESSION_ROOT/workspaces" \
    EXPECTED_CODEX_HOME="$SESSION_ROOT/codex-home" \
    EXPECTED_COMPOSE_PROJECT="$GATE_COMPOSE_PROJECT" \
    EXPECTED_OWNER="$GATE_NONCE" \
      node scripts/release-compose-policy.mjs --assert-resolved
}

export_production_image_artifacts() {
  local artifact_leaf
  local artifact_parent
  local artifact_parent_physical
  local archive_path
  local provenance_path
  if [ -z "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" ]; then
    return
  fi
  case "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" in
    /*) ;;
    *)
      echo "Production image artifacts require an absolute output directory." >&2
      return 1
      ;;
  esac
  artifact_leaf="${PRODUCTION_IMAGE_ARTIFACT_DIRECTORY##*/}"
  artifact_parent="${PRODUCTION_IMAGE_ARTIFACT_DIRECTORY%/*}"
  if [ -z "$artifact_leaf" ] || [ "$artifact_leaf" = "." ] || \
    [ "$artifact_leaf" = ".." ] || [ ! -d "$artifact_parent" ] || \
    [ -L "$artifact_parent" ]; then
    echo "Production image artifact output parent is unsafe." >&2
    return 1
  fi
  if ! artifact_parent_physical="$(cd "$artifact_parent" && pwd -P)"; then
    echo "Production image artifact output parent could not be resolved." >&2
    return 1
  fi
  PRODUCTION_IMAGE_ARTIFACT_DIRECTORY="$artifact_parent_physical/$artifact_leaf"
  case "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" in
    "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
      echo "Production image artifacts must be written outside the source checkout." >&2
      return 1
      ;;
  esac
  if [ -e "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" ] || \
    [ -L "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" ]; then
    echo "Production image artifact output must not already exist." >&2
    return 1
  fi
  mkdir -m 700 -- "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY"
  archive_path="$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY/agent-airlock-production-image.tar"
  provenance_path="$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY/agent-airlock-production-image-provenance.json"
  local archive_image_ids
  if ! archive_image_ids="$(docker image ls --quiet --no-trunc "$IMAGE_TAG")" || \
    [ "$archive_image_ids" != "$IMAGE_ID" ]; then
    echo "Production image tag changed before immutable artifact export." >&2
    return 1
  fi
  docker image save --output "$archive_path" "$IMAGE_ID"
  chmod 600 "$archive_path"
  PRODUCTION_IMAGE_ARCHIVE="$archive_path" node --input-type=module -e '
    import { open } from "node:fs/promises";
    const handle = await open(process.env.PRODUCTION_IMAGE_ARCHIVE, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  '
  node scripts/production-image-provenance.mjs \
    --archive "$archive_path" \
    --image-id "$IMAGE_ID" \
    --output "$provenance_path"
  node scripts/production-image-provenance.mjs \
    --verify "$provenance_path" \
    --artifact-directory "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY"
  PRODUCTION_IMAGE_ARTIFACT_ROOT="$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" \
    node --input-type=module -e '
      import { open } from "node:fs/promises";
      const handle = await open(process.env.PRODUCTION_IMAGE_ARTIFACT_ROOT, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    '
}

cd "$PROJECT_ROOT"
docker info >/dev/null
if [ "$HOST_UID" = "0" ] || [ "$HOST_GID" = "0" ]; then
  echo "Phase 11 production gate requires a non-root host UID and GID." >&2
  exit 1
fi
if [ "${CI:-}" = "true" ] && \
  [ -z "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY" ]; then
  echo "CI must retain the exact tested production image archive and provenance." >&2
  exit 1
fi

if [ -L "$PROJECT_ROOT/.local" ] || [ -L "$SESSION_BASE" ]; then
  echo "Phase 11 production gate refuses a symlinked local session base." >&2
  exit 1
fi
mkdir -p "$SESSION_BASE"
SESSION_BASE="$(cd "$SESSION_BASE" && pwd -P)"
SESSION_BASE_PHYSICAL="$SESSION_BASE"
SESSION_BASE_ID="$(path_identity "$SESSION_BASE")"
case "$SESSION_BASE" in
  "$PROJECT_ROOT"/.local/production-image-gate) ;;
  *)
    echo "Phase 11 production gate session base escaped the repository." >&2
    exit 1
    ;;
esac
SESSION_ROOT="$(mktemp -d "$SESSION_BASE/session.XXXXXX")"
SESSION_ROOT="$(cd "$SESSION_ROOT" && pwd -P)"
chmod 700 "$SESSION_ROOT"
mkdir -p \
  "$SESSION_ROOT/data" \
  "$SESSION_ROOT/workspaces" \
  "$SESSION_ROOT/codex-home"
PRODUCT_ENV_FILE="$SESSION_ROOT/product.env"
TRANSACTION_PROOF_FILE="$SESSION_ROOT/transaction-proof.json"
PHYSICAL_PROOF_FILE="$SESSION_ROOT/physical-proof.json"
SOURCE_ARCHIVE="$SESSION_ROOT/production-build-context.tar"
DATA_SANDBOX_SENTINEL="$SESSION_ROOT/data/.production-gate-sandbox-sentinel"
WORKSPACE_SANDBOX_SENTINEL="$SESSION_ROOT/workspaces/.production-gate-sandbox-sentinel"
DATA_SANDBOX_SENTINEL_CONTENT="protected-data:$GATE_NONCE"
WORKSPACE_SANDBOX_SENTINEL_CONTENT="protected-workspaces:$GATE_NONCE"

PRODUCTION_GATE_DATA_SENTINEL="$DATA_SANDBOX_SENTINEL" \
PRODUCTION_GATE_DATA_SENTINEL_CONTENT="$DATA_SANDBOX_SENTINEL_CONTENT" \
PRODUCTION_GATE_WORKSPACE_SENTINEL="$WORKSPACE_SANDBOX_SENTINEL" \
PRODUCTION_GATE_WORKSPACE_SENTINEL_CONTENT="$WORKSPACE_SANDBOX_SENTINEL_CONTENT" \
  node --input-type=module -e '
    import { open } from "node:fs/promises";
    for (const [file, content] of [
      [
        process.env.PRODUCTION_GATE_DATA_SENTINEL,
        process.env.PRODUCTION_GATE_DATA_SENTINEL_CONTENT,
      ],
      [
        process.env.PRODUCTION_GATE_WORKSPACE_SENTINEL,
        process.env.PRODUCTION_GATE_WORKSPACE_SENTINEL_CONTENT,
      ],
    ]) {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(content + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  '
assert_sandbox_sentinels

PRODUCT_IMAGE_ENV_FILE="$PRODUCT_ENV_FILE" \
PRODUCT_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \
  node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    const lines = [
      "APP_AUTH_TOKEN=" + process.env.PRODUCT_IMAGE_AUTH_TOKEN,
      "ARK_API_KEY=deterministic-protocol-fixture",
      "ARK_MODEL=protocol-fixture",
      "ARK_BASE_URL=http://127.0.0.1:43991/v1",
      "RUNTIME_PROVIDER=local-process",
      "CODEX_BIN=codex",
      "AIRLOCK_DEMO_MODE=false",
      "AIRLOCK_PROTOCOL_FIXTURE_MODE=true",
    ];
    await writeFile(
      process.env.PRODUCT_IMAGE_ENV_FILE,
      lines.join("\n") + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  '

export LAUNCHPAD_ENV_FILE="$PRODUCT_ENV_FILE"
export LAUNCHPAD_IMAGE="$IMAGE_TAG"
export LAUNCHPAD_DATA_DIR="$SESSION_ROOT/data"
export LAUNCHPAD_WORKSPACE_DIR="$SESSION_ROOT/workspaces"
export LAUNCHPAD_CODEX_HOME_DIR="$SESSION_ROOT/codex-home"
export PUBLIC_BIND_ADDRESS=127.0.0.1
export PUBLIC_PORT=0
export CONTAINER_USER="$HOST_UID:$HOST_GID"
export CODEX_SANDBOX_MODE=workspace-write
export CONTAINER_RUNTIME_BASE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
export CONTAINER_APT_MIRROR=""
export CONTAINER_APT_SECURITY_MIRROR=""
export PRODUCTION_GATE_OWNER="$GATE_NONCE"

node scripts/release-compose-policy.mjs --assert-source
assert_compose_service_contract
SOURCE_IDENTITY="$(node scripts/production-build-context.mjs --root "$PROJECT_ROOT" --output "$SOURCE_ARCHIVE")"
SOURCE_COMMIT="${SOURCE_IDENTITY%%:*}"
SOURCE_IDENTITY_REMAINDER="${SOURCE_IDENTITY#*:}"
SOURCE_TREE="${SOURCE_IDENTITY_REMAINDER%%:*}"
SOURCE_ARCHIVE_SHA256="${SOURCE_IDENTITY_REMAINDER#*:}"
if [[ ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] || \
  [[ ! "$SOURCE_TREE" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] || \
  [ "${#SOURCE_COMMIT}" -ne "${#SOURCE_TREE}" ] || \
  [[ ! "$SOURCE_ARCHIVE_SHA256" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Phase 11 could not bind the exact committed production build context." >&2
  exit 1
fi
if ! EXISTING_IMAGE_IDS="$(docker image ls --quiet --no-trunc "$IMAGE_TAG")"; then
  echo "Phase 11 could not inspect the production-gate image identity." >&2
  exit 1
fi
if [ -n "$EXISTING_IMAGE_IDS" ]; then
  echo "Phase 11 refused a pre-existing production-gate image tag." >&2
  exit 1
fi
IMAGE_BUILD_ATTEMPTED=true
node scripts/production-build-context.mjs \
  --stream "$SOURCE_ARCHIVE" \
  --sha256 "$SOURCE_ARCHIVE_SHA256" | \
  docker image build \
    --build-arg "NODE_IMAGE=$CONTAINER_RUNTIME_BASE_IMAGE" \
    --build-arg "DEBIAN_MIRROR=$CONTAINER_APT_MIRROR" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$CONTAINER_APT_SECURITY_MIRROR" \
    --label "org.opencontainers.image.revision=$SOURCE_COMMIT" \
    --label "io.agent-airlock.source-tree=$SOURCE_TREE" \
    --label "io.codejam.production-gate-image-owner=$GATE_NONCE" \
    --file Dockerfile \
    --tag "$IMAGE_TAG" \
    - >/dev/null
if ! IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")" || \
  [[ ! "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Phase 11 could not bind the built production image identity." >&2
  exit 1
fi
IMAGE_SOURCE_IDENTITY="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}:{{ index .Config.Labels "io.agent-airlock.source-tree" }}' "$IMAGE_ID")"
if [ "$IMAGE_SOURCE_IDENTITY" != "$SOURCE_COMMIT:$SOURCE_TREE" ]; then
  echo "Phase 11 production image did not preserve the exact source identity." >&2
  exit 1
fi

docker run --rm "$IMAGE_ID" node --input-type=module -e \
  "await Promise.all([import('@agent-airlock/transactional-resource-sdk'),import('@agent-airlock/http-object-resource'),import('@agent-airlock/portable-promotion-receipt')])"

RUNTIME_ID="$(docker run --rm "$IMAGE_ID" node -e \
  "process.stdout.write(String(process.getuid?.() ?? -1) + ':' + String(process.getgid?.() ?? -1))")"
RUNTIME_UID="${RUNTIME_ID%%:*}"
RUNTIME_GID="${RUNTIME_ID#*:}"
if [ "$RUNTIME_UID" = "0" ] || [ "$RUNTIME_UID" = "-1" ] || [ "$RUNTIME_GID" = "0" ] || [ "$RUNTIME_GID" = "-1" ]; then
  echo "Phase 11 production image did not enforce a non-root default runtime UID:GID." >&2
  exit 1
fi
CODEX_VERSION="$(docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --entrypoint codex "$IMAGE_ID" --version)"
if [ "$CODEX_VERSION" != "codex-cli 0.111.0" ]; then
  echo "Phase 11 production image did not contain the approved Codex CLI version." >&2
  exit 1
fi

start_product_container
start_protocol_fixture

node scripts/production-image-verifier.mjs --origin "$ORIGIN"
AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \
  node scripts/check-production-image-browser.mjs --origin "$ORIGIN"
AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \
  node scripts/check-production-image-transaction.mjs \
    --origin "$ORIGIN" \
    --mode create \
    --proof-file "$TRANSACTION_PROOF_FILE"
assert_sandbox_sentinels
node scripts/production-image-persistence-verifier.mjs \
  --session-root "$SESSION_ROOT" \
  --transaction-proof "$TRANSACTION_PROOF_FILE" \
  --mode create \
  --snapshot-file "$PHYSICAL_PROOF_FILE" \
  --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" \
  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"

stop_product_container
start_product_container
start_protocol_fixture
node scripts/production-image-verifier.mjs --origin "$ORIGIN"
AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \
  node scripts/check-production-image-transaction.mjs \
    --origin "$ORIGIN" \
    --mode restart \
    --proof-file "$TRANSACTION_PROOF_FILE"
assert_sandbox_sentinels
node scripts/production-image-persistence-verifier.mjs \
  --session-root "$SESSION_ROOT" \
  --transaction-proof "$TRANSACTION_PROOF_FILE" \
  --mode restart \
  --snapshot-file "$PHYSICAL_PROOF_FILE" \
  --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" \
  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"

export_production_image_artifacts

echo "Phase 11 shipped Compose service passed non-root host bind mounts, authenticated React, browser-to-AgentService Promotion, physical Canonical evidence, and restart continuity."
