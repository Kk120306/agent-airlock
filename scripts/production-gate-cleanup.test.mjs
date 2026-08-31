import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const gateSource = await readFile(
  path.join(projectRoot, "scripts/check-phase-eleven-docker.sh"),
  "utf8",
);
const executionBoundary = '\ncd "$PROJECT_ROOT"\n';
const boundaryIndex = gateSource.indexOf(executionBoundary);
assert.notEqual(boundaryIndex, -1);
const cleanupLibrary = gateSource.slice(0, boundaryIndex);

async function runHarness(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-cleanup-test-"));
  const scriptPath = path.join(root, "scripts", "cleanup-harness.sh");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    `${cleanupLibrary}\ntrap - EXIT\n${body}\n`,
    "utf8",
  );
  try {
    return await execFileAsync("bash", [scriptPath], {
      env: { ...process.env, HARNESS_ROOT: root },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const noOwnedDockerState = `
docker() {
  if [ "$1" = "ps" ]; then
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    return 1
  fi
  if [ "$1" = "inspect" ]; then
    return 1
  fi
  return 0
}
product_compose() { return 0; }
`;

test("production gate cleanup removes only a physically contained session", async () => {
  const result = await runHarness(`${noOwnedDockerState}
SESSION_BASE="$HARNESS_ROOT/project/.local/production-image-gate"
mkdir -p "$SESSION_BASE/session.safe"
SESSION_BASE_PHYSICAL="$(cd "$SESSION_BASE" && pwd -P)"
SESSION_BASE_ID="$(path_identity "$SESSION_BASE")"
SESSION_ROOT="$SESSION_BASE/session.safe"
safe_remove_session_root
[ ! -e "$SESSION_BASE/session.safe" ]
printf cleaned
`);
  assert.equal(result.stdout, "cleaned");
});

test("production gate cleanup rejects a swapped session-base ancestor", async () => {
  const result = await runHarness(`${noOwnedDockerState}
SESSION_BASE="$HARNESS_ROOT/project/.local/production-image-gate"
mkdir -p "$SESSION_BASE/session.attack" "$HARNESS_ROOT/outside/session.attack"
printf protected > "$HARNESS_ROOT/outside/session.attack/sentinel"
SESSION_BASE_PHYSICAL="$(cd "$SESSION_BASE" && pwd -P)"
SESSION_BASE_ID="$(path_identity "$SESSION_BASE")"
SESSION_ROOT="$SESSION_BASE/session.attack"
mv "$SESSION_BASE" "$SESSION_BASE.saved"
ln -s "$HARNESS_ROOT/outside" "$SESSION_BASE"
if safe_remove_session_root; then
  exit 9
fi
[ "$(cat "$HARNESS_ROOT/outside/session.attack/sentinel")" = protected ]
printf rejected
`);
  assert.equal(result.stdout, "rejected");
  assert.match(result.stderr, /ancestor changed to a symlink/u);
});

test("production gate preserves its session when Docker teardown is unconfirmed", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    printf container-still-running
    return 0
  fi
  if [ "$1" = "rm" ]; then
    return 1
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    return 1
  fi
  return 1
}
product_compose() { return 1; }
SESSION_BASE="$HARNESS_ROOT/project/.local/production-image-gate"
mkdir -p "$SESSION_BASE/session.preserved"
SESSION_BASE_PHYSICAL="$(cd "$SESSION_BASE" && pwd -P)"
SESSION_BASE_ID="$(path_identity "$SESSION_BASE")"
SESSION_ROOT="$SESSION_BASE/session.preserved"
if cleanup; then
  exit 9
fi
[ -d "$SESSION_ROOT" ]
printf preserved
`);
  assert.equal(result.stdout, "preserved");
  assert.match(result.stderr, /Preserving the production-image session/u);
});

test("protocol fixture cleanup refuses a recorded container without the exact owner", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    return 0
  fi
  if [ "$1" = "inspect" ]; then
    printf foreign-owner
    return 0
  fi
  if [ "$1" = "rm" ]; then
    printf removed > "$HARNESS_ROOT/removed"
    return 0
  fi
  return 1
}
FIXTURE_CONTAINER_ID=foreign-container
if remove_protocol_fixture; then
  exit 9
fi
[ ! -e "$HARNESS_ROOT/removed" ]
printf refused
`);
  assert.equal(result.stdout, "refused");
  assert.match(result.stderr, /without the exact ownership label/u);
});

test("protocol fixture cleanup does not target the live Compose service label", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    case "$*" in
      *"label=$FIXTURE_OWNER_LABEL"*)
        if [ ! -e "$HARNESS_ROOT/fixture-removed" ]; then
          printf fixture-container
        fi
        ;;
      *"label=$OWNER_LABEL"*)
        printf service-container
        ;;
    esac
    return 0
  fi
  if [ "$1" = "inspect" ]; then
    if [ "$2" = "--format" ] && [ "$3" = "{{.Image}}" ]; then
      printf image-id
    else
      printf '%s\\n' "$GATE_NONCE"
    fi
    return 0
  fi
  if [ "$1" = "rm" ] && [ "$3" = "fixture-container" ]; then
    printf fixture-container > "$HARNESS_ROOT/fixture-removed"
    return 0
  fi
  return 1
}
FIXTURE_CONTAINER_ID=fixture-container
remove_protocol_fixture
[ "$(cat "$HARNESS_ROOT/fixture-removed")" = fixture-container ]
printf isolated
`);
  assert.equal(result.stdout, "isolated");
});

test("product restart preserves only its already-owned Compose network", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    return 0
  fi
  if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
    printf network-check >> "$HARNESS_ROOT/network-checks"
    return 0
  fi
  if [ "$1" = "inspect" ]; then
    if [ "$2" = "--format" ] && [ "$3" = "{{.Image}}" ]; then
      printf image-id
    else
      printf '%s\\n' "$GATE_NONCE"
    fi
    return 0
  fi
  return 1
}
product_compose() {
  if [ "$1" = "ps" ] && [ "$2" = "--quiet" ]; then
    printf launchpad-container
  fi
  return 0
}
wait_for_product_container() { return 0; }
IMAGE_ID=image-id
start_product_container
start_product_container
[ "$(cat "$HARNESS_ROOT/network-checks")" = network-check ]
printf restarted
`);
  assert.equal(result.stdout, "restarted");
});

test("fixture startup refuses a colliding container without running or removing it", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    printf colliding-container
    return 0
  fi
  if [ "$1" = "run" ]; then
    printf ran > "$HARNESS_ROOT/ran"
    return 0
  fi
  return 1
}
product_compose() {
  if [ "$1" = "ps" ] && [ "$2" = "--quiet" ]; then
    printf launchpad-container
  fi
  return 0
}
if start_protocol_fixture; then
  exit 9
fi
[ ! -e "$HARNESS_ROOT/ran" ]
printf collision-refused
`);
  assert.equal(result.stdout, "collision-refused");
  assert.match(result.stderr, /pre-existing protocol fixture container name/u);
});

test("cleanup preserves evidence when the final fixture query fails", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    if [ -e "$HARNESS_ROOT/fixture-removed" ]; then
      return 1
    fi
    printf fixture-container
    return 0
  fi
  if [ "$1" = "inspect" ]; then
    printf '%s\\n' "$GATE_NONCE"
    return 0
  fi
  if [ "$1" = "rm" ]; then
    touch "$HARNESS_ROOT/fixture-removed"
    return 0
  fi
  return 0
}
FIXTURE_CONTAINER_ID=fixture-container
if remove_protocol_fixture; then
  exit 9
fi
printf fixture-query-failed
`);
  assert.equal(result.stdout, "fixture-query-failed");
  assert.match(result.stderr, /confirm protocol fixture absence/u);
});

test("cleanup preserves evidence when the final image query fails", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
    if [ -e "$HARNESS_ROOT/image-removed" ]; then
      return 1
    fi
    printf image-id
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    printf '%s' "$GATE_NONCE"
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then
    touch "$HARNESS_ROOT/image-removed"
    return 0
  fi
  return 0
}
IMAGE_BUILD_ATTEMPTED=true
IMAGE_ID=image-id
if remove_product_image; then
  exit 9
fi
printf image-query-failed
`);
  assert.equal(result.stdout, "image-query-failed");
  assert.match(result.stderr, /confirm production-gate image absence/u);
});

test("image cleanup treats an attempted build with no output tag as a clean no-op", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
    return 0
  fi
  if [ "$1" = "image" ] && { [ "$2" = "inspect" ] || [ "$2" = "rm" ]; }; then
    touch "$HARNESS_ROOT/unexpected-image-mutation"
    return 0
  fi
  return 1
}
IMAGE_BUILD_ATTEMPTED=true
IMAGE_ID=
remove_product_image
[ ! -e "$HARNESS_ROOT/unexpected-image-mutation" ]
[ "$IMAGE_BUILD_ATTEMPTED" = false ]
printf empty-build-clean
`);
  assert.equal(result.stdout, "empty-build-clean");
});

test("image cleanup removes its exact-owned post-output tag before the image ID is recorded", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
    if [ ! -e "$HARNESS_ROOT/image-removed" ]; then
      printf owned-image-id
    fi
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    [ "$3" = "--format" ]
    [ "$4" = '{{ index .Config.Labels "io.codejam.production-gate-image-owner" }}' ]
    [ "$5" = "owned-image-id" ]
    printf '%s' "$GATE_NONCE"
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then
    printf '%s' "$3" > "$HARNESS_ROOT/image-removed"
    return 0
  fi
  return 1
}
IMAGE_BUILD_ATTEMPTED=true
IMAGE_ID=
remove_product_image
[ "$(cat "$HARNESS_ROOT/image-removed")" = "$IMAGE_TAG" ]
[ "$IMAGE_BUILD_ATTEMPTED" = false ]
printf pre-inspect-image-removed
`);
  assert.equal(result.stdout, "pre-inspect-image-removed");
});

test("image cleanup refuses a pre-inspect retarget without the exact owner", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
    printf foreign-image-id
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    printf '%s' "$IMAGE_OWNER"
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then
    touch "$HARNESS_ROOT/image-removed"
    return 0
  fi
  return 1
}
IMAGE_BUILD_ATTEMPTED=true
IMAGE_ID=
IMAGE_OWNER=foreign-owner
if remove_product_image; then
  exit 9
fi
[ ! -e "$HARNESS_ROOT/image-removed" ]
IMAGE_OWNER=
if remove_product_image; then
  exit 9
fi
[ ! -e "$HARNESS_ROOT/image-removed" ]
printf foreign-owner-refused
`);
  assert.equal(result.stdout, "foreign-owner-refused");
  assert.match(result.stderr, /without the exact ownership label/u);
});

test("image cleanup refuses a tag retargeted away from the recorded image", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
    printf foreign-image-id
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "rm" ]; then
    touch "$HARNESS_ROOT/image-removed"
    return 0
  fi
  return 0
}
IMAGE_BUILD_ATTEMPTED=true
IMAGE_ID=recorded-image-id
if remove_product_image; then
  exit 9
fi
[ ! -e "$HARNESS_ROOT/image-removed" ]
printf tag-hijack-refused
`);
  assert.equal(result.stdout, "tag-hijack-refused");
  assert.match(result.stderr, /image identity changed/u);
});

test("cleanup preserves evidence when the Compose absence query fails", async () => {
  const result = await runHarness(`
docker() {
  if [ "$1" = "ps" ]; then
    return 1
  fi
  return 0
}
product_compose() { return 0; }
COMPOSE_STARTED=true
if remove_compose_project; then
  exit 9
fi
printf compose-query-failed
`);
  assert.equal(result.stdout, "compose-query-failed");
  assert.match(result.stderr, /inspect the owned Compose project/u);
});

test("sandbox sentinel proof rejects a protected host-mount mutation", async () => {
  const result = await runHarness(`
SESSION_ROOT="$HARNESS_ROOT/session.sentinels"
mkdir -p "$SESSION_ROOT/data" "$SESSION_ROOT/workspaces"
DATA_SANDBOX_SENTINEL="$SESSION_ROOT/data/.production-gate-sandbox-sentinel"
WORKSPACE_SANDBOX_SENTINEL="$SESSION_ROOT/workspaces/.production-gate-sandbox-sentinel"
DATA_SANDBOX_SENTINEL_CONTENT=protected-data-test
WORKSPACE_SANDBOX_SENTINEL_CONTENT=protected-workspaces-test
printf '%s\\n' "$DATA_SANDBOX_SENTINEL_CONTENT" > "$DATA_SANDBOX_SENTINEL"
printf '%s\\n' "$WORKSPACE_SANDBOX_SENTINEL_CONTENT" > "$WORKSPACE_SANDBOX_SENTINEL"
assert_sandbox_sentinels
printf escaped > "$DATA_SANDBOX_SENTINEL"
if assert_sandbox_sentinels >/dev/null 2>&1; then
  exit 9
fi
printf sentinel-rejected
`);
  assert.equal(result.stdout, "sentinel-rejected");
});
