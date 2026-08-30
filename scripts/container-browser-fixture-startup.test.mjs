import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertContainerFixturePortsAvailable,
  assertSafeEphemeralContainerDemoStateRoot,
  ephemeralContainerDemoStateRoot,
} from "./container-browser-fixture-startup.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function listen(host = "127.0.0.1") {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function unusedPort() {
  const server = await listen();
  const { port } = server;
  await server.close();
  return port;
}

test("ephemeral demo roots isolate concurrent launchers and port pairs", () => {
  const first = ephemeralContainerDemoStateRoot({
    repoRoot: "/workspace/agent-airlock",
    controlPort: 3210,
    fixturePort: 44010,
    launcherPid: 101,
  });
  const secondLauncher = ephemeralContainerDemoStateRoot({
    repoRoot: "/workspace/agent-airlock",
    controlPort: 3210,
    fixturePort: 44010,
    launcherPid: 202,
  });
  const secondPortPair = ephemeralContainerDemoStateRoot({
    repoRoot: "/workspace/agent-airlock",
    controlPort: 3211,
    fixturePort: 44011,
    launcherPid: 101,
  });

  assert.notEqual(first, secondLauncher);
  assert.notEqual(first, secondPortPair);
  assert.equal(
    path.dirname(first),
    path.join("/workspace/agent-airlock", ".e2e-container-demo"),
  );
  assert.match(first, /control-3210-fixture-44010-launcher-101$/);
});

test("a symlinked ephemeral parent cannot redirect reset outside the repository", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-container-parent-symlink-"),
  );
  const repoRoot = path.join(temporaryRoot, "repo");
  const outsideRoot = path.join(temporaryRoot, "outside");
  const stateRoot = ephemeralContainerDemoStateRoot({
    repoRoot,
    controlPort: 3210,
    fixturePort: 44010,
    launcherPid: 101,
  });
  const outsideStateRoot = path.join(outsideRoot, path.basename(stateRoot));
  const sentinelPath = path.join(outsideStateRoot, "must-survive.txt");
  try {
    await mkdir(repoRoot);
    await mkdir(outsideStateRoot, { recursive: true });
    await writeFile(sentinelPath, "must survive\n");
    await symlink(outsideRoot, path.join(repoRoot, ".e2e-container-demo"), "dir");

    await assert.rejects(
      assertSafeEphemeralContainerDemoStateRoot({ repoRoot, stateRoot }),
      /parent must be a real in-repository directory/,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "must survive\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a symlinked ephemeral state root cannot redirect reset", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-container-state-symlink-"),
  );
  const repoRoot = path.join(temporaryRoot, "repo");
  const managedParent = path.join(repoRoot, ".e2e-container-demo");
  const outsideStateRoot = path.join(temporaryRoot, "outside-state");
  const stateRoot = ephemeralContainerDemoStateRoot({
    repoRoot,
    controlPort: 3210,
    fixturePort: 44010,
    launcherPid: 101,
  });
  const sentinelPath = path.join(outsideStateRoot, "must-survive.txt");
  try {
    await mkdir(managedParent, { recursive: true });
    await mkdir(outsideStateRoot);
    await writeFile(sentinelPath, "must survive\n");
    await symlink(outsideStateRoot, stateRoot, "dir");

    await assert.rejects(
      assertSafeEphemeralContainerDemoStateRoot({ repoRoot, stateRoot }),
      /state root must be a real directory/,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "must survive\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an occupied control-plane port fails the preflight", async () => {
  const occupied = await listen();
  try {
    await assert.rejects(
      assertContainerFixturePortsAvailable({
        controlPort: occupied.port,
        fixturePort: await unusedPort(),
      }),
      /Agent Airlock control-plane port .* is unavailable \(EADDRINUSE\).*No managed state was changed/,
    );
  } finally {
    await occupied.close();
  }
});

test("an occupied Responses fixture port fails the preflight", async () => {
  const occupied = await listen();
  try {
    await assert.rejects(
      assertContainerFixturePortsAvailable({
        controlPort: await unusedPort(),
        fixturePort: occupied.port,
      }),
      /Responses fixture port .* is unavailable \(EADDRINUSE\).*No managed state was changed/,
    );
  } finally {
    await occupied.close();
  }
});

test("the launcher checks ports before resetting its managed state", async () => {
  const stateRoot = path.join(projectRoot, ".e2e-container-browser");
  const sentinelPath = path.join(
    stateRoot,
    `port-preflight-sentinel-${process.pid}.txt`,
  );
  const occupied = await listen();
  const launcherEnvironment = { ...process.env };
  for (const name of [
    "AIRLOCK_RUNTIME_PROOF_ROOT",
    "AIRLOCK_RUNTIME_PROOF_SESSION_ROOT",
    "AIRLOCK_RUNTIME_PROOF_SESSION_NONCE",
    "AIRLOCK_RUNTIME_PROOF_OWNER_PID",
  ]) {
    delete launcherEnvironment[name];
  }
  await mkdir(stateRoot, { recursive: true });
  await writeFile(sentinelPath, "must survive\n");
  try {
    let failure;
    try {
      await execFile(process.execPath, ["scripts/run-container-browser-fixture.mjs"], {
        cwd: projectRoot,
        env: {
          ...launcherEnvironment,
          AIRLOCK_CONTAINER_BROWSER_PORT: String(occupied.port),
          AIRLOCK_CONTAINER_BROWSER_FIXTURE_PORT: String(await unusedPort()),
        },
        timeout: 10_000,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(
      failure.stderr,
      /Agent Airlock control-plane port .* is unavailable .*No managed state was changed/,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "must survive\n");
  } finally {
    await occupied.close();
    await unlink(sentinelPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await rmdir(stateRoot).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    });
  }
});
