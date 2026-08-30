import { lstat, mkdir, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(label + " must be a positive integer");
  }
}

export function ephemeralContainerDemoStateRoot({
  repoRoot,
  controlPort,
  fixturePort,
  launcherPid,
}) {
  assertPositiveInteger(controlPort, "controlPort");
  assertPositiveInteger(fixturePort, "fixturePort");
  assertPositiveInteger(launcherPid, "launcherPid");
  return path.join(
    path.resolve(repoRoot),
    ".e2e-container-demo",
    `control-${controlPort}-fixture-${fixturePort}-launcher-${launcherPid}`,
  );
}

export async function assertSafeEphemeralContainerDemoStateRoot({
  repoRoot,
  stateRoot,
}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedStateRoot = path.resolve(stateRoot);
  const managedParent = path.join(resolvedRepoRoot, ".e2e-container-demo");
  if (path.dirname(resolvedStateRoot) !== managedParent) {
    throw new Error(
      "The ephemeral container demo state root must be a direct child of its managed parent",
    );
  }

  try {
    await mkdir(managedParent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const parentStatus = await lstat(managedParent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error(
      "The ephemeral container demo parent must be a real in-repository directory",
    );
  }
  const [physicalRepoRoot, physicalManagedParent] = await Promise.all([
    realpath(resolvedRepoRoot),
    realpath(managedParent),
  ]);
  if (
    path.dirname(physicalManagedParent) !== physicalRepoRoot ||
    path.basename(physicalManagedParent) !== ".e2e-container-demo"
  ) {
    throw new Error(
      "The ephemeral container demo parent must remain inside the repository",
    );
  }

  let stateStatus;
  try {
    stateStatus = await lstat(resolvedStateRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stateStatus.isDirectory() || stateStatus.isSymbolicLink()) {
    throw new Error(
      "The ephemeral container demo state root must be a real directory",
    );
  }
  const physicalStateRoot = await realpath(resolvedStateRoot);
  if (
    path.dirname(physicalStateRoot) !== physicalManagedParent ||
    path.basename(physicalStateRoot) !== path.basename(resolvedStateRoot)
  ) {
    throw new Error(
      "The ephemeral container demo state root must remain a direct managed child",
    );
  }
}

async function assertPortAvailable({ host, port, label }) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (error) => {
      const reason =
        error && typeof error === "object" && "code" in error
          ? ` (${error.code})`
          : "";
      reject(
        new Error(
          `${label} port ${host}:${port} is unavailable${reason}. No managed state was changed.`,
        ),
      );
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) {
          reject(
            new Error(
              `${label} port ${host}:${port} could not complete its startup preflight. No managed state was changed.`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  });
}

export async function assertContainerFixturePortsAvailable({
  controlPort,
  fixturePort,
}) {
  await assertPortAvailable({
    host: "127.0.0.1",
    port: controlPort,
    label: "Agent Airlock control-plane",
  });
  await assertPortAvailable({
    host: "127.0.0.1",
    port: fixturePort,
    label: "Responses fixture",
  });
  await assertPortAvailable({
    host: "0.0.0.0",
    port: fixturePort,
    label: "Responses fixture",
  });
}
