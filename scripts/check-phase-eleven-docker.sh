#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="agent-airlock-phase11-gate:process-$$"
CONTAINER_NAME="agent-airlock-phase11-gate-$$"

cleanup() {
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$PROJECT_ROOT"
docker info >/dev/null
docker build --quiet --tag "$IMAGE_TAG" . >/dev/null

docker run --rm "$IMAGE_TAG" node --input-type=module -e \
  "await Promise.all([import('@agent-airlock/transactional-resource-sdk'),import('@agent-airlock/http-object-resource'),import('@agent-airlock/portable-promotion-receipt')])"

docker run --detach \
  --name "$CONTAINER_NAME" \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --env RUNTIME_PROVIDER=local-process \
  --env APP_AUTH_TOKEN=phase11-container-verification-token \
  "$IMAGE_TAG" >/dev/null

for attempt in $(seq 1 50); do
  if docker exec "$CONTAINER_NAME" node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "Phase 11 production Docker runtime and workspace imports passed."
    exit 0
  fi
  if ! docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    docker logs "$CONTAINER_NAME" >&2 || true
    echo "Phase 11 production container exited before becoming healthy." >&2
    exit 1
  fi
  sleep 0.2
done

docker logs "$CONTAINER_NAME" >&2 || true
echo "Phase 11 production container did not become healthy." >&2
exit 1
