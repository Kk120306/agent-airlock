function validProcessId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function unixProcessGroupExists(processGroupId, killProcess) {
  try {
    killProcess(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function createOwnedModelArkProcessTree(
  child,
  {
    platform = process.platform,
    killProcess = process.kill.bind(process),
  } = {},
) {
  if (!child || !validProcessId(child.pid)) {
    throw new Error("The owned ModelArk process tree has no valid leader");
  }

  const processGroupId = platform === "win32" ? null : child.pid;
  return Object.freeze({
    child,
    processGroupId,
    isRunning() {
      if (platform !== "win32") {
        return unixProcessGroupExists(processGroupId, killProcess);
      }
      return child.exitCode === null && child.signalCode === null;
    },
    signal(signal) {
      try {
        if (platform !== "win32") {
          killProcess(-processGroupId, signal);
        } else {
          if (child.exitCode !== null || child.signalCode !== null)
            return false;
          child.kill(signal);
        }
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    },
  });
}

export function signalOwnedModelArkProcessTree(child, signal, options = {}) {
  if (!child || !validProcessId(child.pid)) return false;
  return createOwnedModelArkProcessTree(child, options).signal(signal);
}

async function waitForOwnedTreeToStop(ownedTree, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (ownedTree.isRunning()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)),
    );
  }
  return true;
}

export async function terminateOwnedModelArkProcessTree(
  ownedTree,
  {
    initialSignal = "SIGTERM",
    gracefulTimeoutMs = 15_000,
    forcedTimeoutMs = 5_000,
    pollIntervalMs = 25,
  } = {},
) {
  for (const [name, value] of Object.entries({
    gracefulTimeoutMs,
    forcedTimeoutMs,
    pollIntervalMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  if (!ownedTree.isRunning()) return { forced: false };
  ownedTree.signal(initialSignal);
  if (
    await waitForOwnedTreeToStop(ownedTree, gracefulTimeoutMs, pollIntervalMs)
  ) {
    return { forced: false };
  }

  ownedTree.signal("SIGKILL");
  if (
    !(await waitForOwnedTreeToStop(ownedTree, forcedTimeoutMs, pollIntervalMs))
  ) {
    throw new Error("The owned ModelArk process group survived SIGKILL");
  }
  return { forced: true };
}
