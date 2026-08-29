import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import {
  createOwnedModelArkProcessTree,
  signalOwnedModelArkProcessTree,
  terminateOwnedModelArkProcessTree,
} from "./modelark-process-tree.mjs";

function runningChild(overrides = {}) {
  return {
    exitCode: null,
    signalCode: null,
    pid: 321,
    kill() {
      throw new Error("The direct child kill path was not expected");
    },
    ...overrides,
  };
}

test("signals the complete detached process group on Unix", () => {
  const calls = [];
  const child = runningChild();
  assert.equal(
    signalOwnedModelArkProcessTree(child, "SIGTERM", {
      platform: "darwin",
      killProcess(pid, signal) {
        calls.push({ pid, signal });
      },
    }),
    true,
  );
  assert.deepEqual(calls, [{ pid: -321, signal: "SIGTERM" }]);
});

test("uses the direct child signal path on Windows", () => {
  const calls = [];
  const child = runningChild({
    kill(signal) {
      calls.push(signal);
    },
  });
  assert.equal(
    signalOwnedModelArkProcessTree(child, "SIGKILL", {
      platform: "win32",
      killProcess() {
        throw new Error("The Unix process-group path was not expected");
      },
    }),
    true,
  );
  assert.deepEqual(calls, ["SIGKILL"]);
});

test("still signals a Unix group after its leader exit is observable", () => {
  const calls = [];
  const signalled = signalOwnedModelArkProcessTree(
    runningChild({ exitCode: 0 }),
    "SIGTERM",
    {
      platform: "linux",
      killProcess(pid, signal) {
        calls.push({ pid, signal });
      },
    },
  );
  assert.equal(signalled, true);
  assert.deepEqual(calls, [{ pid: -321, signal: "SIGTERM" }]);
});

test("does not signal an exited direct child on Windows", () => {
  let calls = 0;
  const signalled = signalOwnedModelArkProcessTree(
    runningChild({
      exitCode: 0,
      kill() {
        calls += 1;
      },
    }),
    "SIGTERM",
    { platform: "win32" },
  );
  assert.equal(signalled, false);
  assert.equal(calls, 0);
});

test("treats a missing process group as already stopped", () => {
  assert.equal(
    signalOwnedModelArkProcessTree(runningChild(), "SIGTERM", {
      platform: "linux",
      killProcess() {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      },
    }),
    false,
  );
});

test("does not suppress unexpected process signalling errors", () => {
  assert.throws(
    () =>
      signalOwnedModelArkProcessTree(runningChild(), "SIGTERM", {
        platform: "linux",
        killProcess() {
          const error = new Error("denied");
          error.code = "EPERM";
          throw error;
        },
      }),
    /denied/,
  );
});

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function assertPortCanBind(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

test(
  "forced escalation removes a three-level owned tree and releases its listener",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const port = await reservePort();
    const listenerSource = `
      import net from "node:net";
      process.on("SIGTERM", () => {});
      const server = net.createServer();
      server.listen({ host: "127.0.0.1", port: Number(process.env.TEST_PORT), exclusive: true }, () => {
        console.log("MODELARK_TEST_LISTENER_READY");
      });
      setInterval(() => {}, 1_000);
    `;
    const middleSource = `
      import { spawn } from "node:child_process";
      process.on("SIGTERM", () => {});
      spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(listenerSource)}], {
        detached: false,
        env: process.env,
        stdio: "inherit",
      });
      setInterval(() => {}, 1_000);
    `;
    const leaderSource = `
      import { spawn } from "node:child_process";
      process.on("SIGTERM", () => {});
      spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(middleSource)}], {
        detached: false,
        env: process.env,
        stdio: "inherit",
      });
      setInterval(() => {}, 1_000);
    `;
    const leader = spawn(
      process.execPath,
      ["--input-type=module", "--eval", leaderSource],
      {
        detached: true,
        env: { ...process.env, TEST_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ownedTree = createOwnedModelArkProcessTree(leader);
    const leaderExit = new Promise((resolve) => leader.once("exit", resolve));

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("The descendant listener did not start")),
          5_000,
        );
        leader.stdout.on("data", (chunk) => {
          if (
            !chunk.toString("utf8").includes("MODELARK_TEST_LISTENER_READY")
          ) {
            return;
          }
          clearTimeout(timeout);
          resolve();
        });
        leader.once("error", reject);
        leader.once("exit", () =>
          reject(new Error("The process-group leader exited before readiness")),
        );
      });

      const result = await terminateOwnedModelArkProcessTree(ownedTree, {
        gracefulTimeoutMs: 100,
        forcedTimeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      await leaderExit;
      assert.equal(result.forced, true);
      assert.equal(ownedTree.isRunning(), false);
      await assertPortCanBind(port);
    } finally {
      try {
        ownedTree.signal("SIGKILL");
      } catch {}
    }
  },
);
