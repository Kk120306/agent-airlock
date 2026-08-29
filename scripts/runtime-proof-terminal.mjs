const MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES = 65_536;
const MAXIMUM_PROGRESS_BYTES = 2_048;
const MAXIMUM_SUBPROCESS_WAIT_MS = 900_000;

const PROGRESS_MESSAGES = Object.freeze({
  "container-readiness": "Checking local container readiness.",
  "application-build": "Preparing the production application.",
  "runtime-image": "Preparing the pinned Codex Runtime.",
  "runtime-launch": "Starting the isolated real Runtime proof.",
  "browser-proof": "Driving the fresh three-Run browser safety loop.",
  cleanup: "Cleaning up runner-owned proof processes.",
  publication: "Publishing the owner-only safe proof capsule.",
});

function boundedPositiveInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

export function createBoundedRuntimeProofTranscript({
  maximumBytes = MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES,
} = {}) {
  const byteLimit = boundedPositiveInteger(
    maximumBytes,
    MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES,
    MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES,
  );
  let tail = Buffer.alloc(0);

  return {
    append(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (next.length >= byteLimit) {
        tail = Buffer.from(next.subarray(next.length - byteLimit));
        return;
      }
      const combined = Buffer.concat([tail, next]);
      tail =
        combined.length > byteLimit
          ? Buffer.from(combined.subarray(combined.length - byteLimit))
          : combined;
    },
    byteLength() {
      return tail.length;
    },
    text() {
      return tail.toString("utf8");
    },
  };
}

export function attachBoundedRuntimeProofCapture(
  child,
  { maximumBytes = MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES } = {},
) {
  const transcript = createBoundedRuntimeProofTranscript({ maximumBytes });
  const listeners = [];
  const capture = (chunk) => {
    transcript.append(chunk);
  };

  for (const stream of [child?.stdout, child?.stderr]) {
    if (!stream || typeof stream.on !== "function") continue;
    stream.on("data", capture);
    listeners.push([stream, capture]);
  }

  return {
    ...transcript,
    detach() {
      for (const [stream, listener] of listeners) {
        stream.off("data", listener);
      }
    },
  };
}

export function createRuntimeProofProgress({
  jsonOutput = false,
  stdout = process.stdout,
  stderr = process.stderr,
  maximumBytes = MAXIMUM_PROGRESS_BYTES,
} = {}) {
  const byteLimit = boundedPositiveInteger(
    maximumBytes,
    MAXIMUM_PROGRESS_BYTES,
    MAXIMUM_PROGRESS_BYTES,
  );
  const emitted = new Set();
  let emittedBytes = 0;
  const target = jsonOutput ? stderr : stdout;

  return {
    emit(stage) {
      const message = PROGRESS_MESSAGES[stage];
      if (!message) throw new TypeError("Unknown real Runtime proof progress stage");
      if (emitted.has(stage)) return false;
      const line = `[Agent Airlock] ${message}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (emittedBytes + lineBytes > byteLimit) return false;
      target.write(line);
      emitted.add(stage);
      emittedBytes += lineBytes;
      return true;
    },
    byteLength() {
      return emittedBytes;
    },
  };
}

export function runtimeProofChildHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function runtimeProofChildExitSucceeded(outcome) {
  return (
    outcome?.code === 0 &&
    (outcome?.signalName === null || outcome?.signalName === undefined) &&
    outcome?.error === undefined
  );
}

function validRuntimeProofProcessId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function unixRuntimeProofProcessGroupExists(processGroupId, killProcess) {
  try {
    killProcess(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function createOwnedRuntimeProofProcessTree(
  child,
  {
    platform = process.platform,
    killProcess = process.kill.bind(process),
  } = {},
) {
  if (!child || !validRuntimeProofProcessId(child.pid)) {
    throw new Error("The owned Runtime proof process tree has no valid leader");
  }
  const processGroupId = platform === "win32" ? null : child.pid;
  return Object.freeze({
    child,
    processGroupId,
    isRunning() {
      if (platform !== "win32") {
        return unixRuntimeProofProcessGroupExists(processGroupId, killProcess);
      }
      return !runtimeProofChildHasExited(child);
    },
    signal(signalName) {
      try {
        if (platform !== "win32") {
          killProcess(-processGroupId, signalName);
        } else {
          if (runtimeProofChildHasExited(child)) return false;
          child.kill(signalName);
        }
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    },
  });
}

async function waitForRuntimeProofProcessTreeToStop(
  ownedTree,
  timeoutMs,
  pollIntervalMs,
) {
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

export async function stopOwnedRuntimeProofProcessTree(
  ownedTree,
  {
    initialSignal = "SIGTERM",
    gracefulTimeoutMs = 12_000,
    forcedTimeoutMs = 5_000,
    pollIntervalMs = 25,
  } = {},
) {
  if (
    !ownedTree ||
    typeof ownedTree.isRunning !== "function" ||
    typeof ownedTree.signal !== "function"
  ) {
    throw new TypeError("An owned Runtime proof process tree is required");
  }
  for (const value of [gracefulTimeoutMs, forcedTimeoutMs, pollIntervalMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 30_000) {
      throw new TypeError(
        "Runtime proof process-tree timeouts must be bounded positive integers",
      );
    }
  }
  if (!ownedTree.isRunning()) return { forced: false };
  ownedTree.signal(initialSignal);
  if (
    await waitForRuntimeProofProcessTreeToStop(
      ownedTree,
      gracefulTimeoutMs,
      pollIntervalMs,
    )
  ) {
    return { forced: false };
  }
  ownedTree.signal("SIGKILL");
  if (
    !(await waitForRuntimeProofProcessTreeToStop(
      ownedTree,
      forcedTimeoutMs,
      pollIntervalMs,
    ))
  ) {
    throw new Error("The owned Runtime proof process group survived SIGKILL");
  }
  return { forced: true };
}

export function waitForRuntimeProofChildOutcome(
  child,
  {
    timeoutMs,
    signal,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.off !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAXIMUM_SUBPROCESS_WAIT_MS
  ) {
    throw new TypeError("Child wait timeout must be a bounded positive integer");
  }
  if (signal?.aborted) return Promise.resolve({ status: "aborted" });
  if (runtimeProofChildHasExited(child)) {
    return Promise.resolve({
      status: "exited",
      code: child.exitCode,
      signalName: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) clearTimeoutImpl(timeout);
      resolve(outcome);
    };
    const onExit = (code, signalName) =>
      finish({ status: "exited", code, signalName });
    const onError = () => finish({ status: "error" });
    const onAbort = () => finish({ status: "aborted" });
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (runtimeProofChildHasExited(child)) {
      finish({
        status: "exited",
        code: child.exitCode,
        signalName: child.signalCode,
      });
      return;
    }
    timeout = setTimeoutImpl(
      () => finish({ status: "timed-out" }),
      timeoutMs,
    );
  });
}

function waitForChildExit(child, timeoutMs) {
  if (runtimeProofChildHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("error", onError);
      clearTimeout(timeout);
      resolve(stopped);
    };
    const onExit = () => finish(true);
    const onError = () => {
      if (runtimeProofChildHasExited(child)) finish(true);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (runtimeProofChildHasExited(child)) {
      finish(true);
      return;
    }
    timeout = setTimeout(
      () => finish(runtimeProofChildHasExited(child)),
      timeoutMs,
    );
  });
}

export async function stopRuntimeProofChild(
  child,
  {
    gracefulTimeoutMs = 10_000,
    forcedTimeoutMs = 5_000,
  } = {},
) {
  if (!child || runtimeProofChildHasExited(child)) return;
  if (
    !Number.isInteger(gracefulTimeoutMs) ||
    gracefulTimeoutMs < 1 ||
    gracefulTimeoutMs > 30_000 ||
    !Number.isInteger(forcedTimeoutMs) ||
    forcedTimeoutMs < 1 ||
    forcedTimeoutMs > 30_000
  ) {
    throw new TypeError("Child shutdown timeouts must be bounded positive integers");
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, gracefulTimeoutMs)) return;
  child.kill("SIGKILL");
  if (await waitForChildExit(child, forcedTimeoutMs)) return;
  throw new Error("Owned child did not exit after forced termination");
}

export const runtimeProofTerminalLimits = Object.freeze({
  progressBytes: MAXIMUM_PROGRESS_BYTES,
  subprocessTranscriptBytes: MAXIMUM_SUBPROCESS_TRANSCRIPT_BYTES,
  subprocessWaitMs: MAXIMUM_SUBPROCESS_WAIT_MS,
});
