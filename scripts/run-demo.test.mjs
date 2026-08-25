import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(".");
const launcher = path.join(projectRoot, "scripts", "run-demo.mjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("No port"))));
    });
  });
}

function startDemo(root, port, reset = false) {
  const child = spawn(
    process.execPath,
    [launcher, ...(reset ? ["--reset"] : [])],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        AIRLOCK_DEMO_DATA_ROOT: root,
        AIRLOCK_DEMO_PORT: String(port),
        LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {
    child,
    output: () => ({ stdout, stderr }),
    exit: new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
  };
}

async function waitUntilReady(instance, port) {
  const marker = "Agent Airlock deterministic demo is ready";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (instance.output().stdout.includes(marker)) return;
    const outcome = await Promise.race([
      instance.exit.then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    if (outcome === "exited") {
      throw new Error("Demo exited before readiness: " + instance.output().stderr);
    }
  }
  throw new Error("Demo did not become ready on port " + port);
}

async function stopDemo(instance) {
  instance.child.kill("SIGTERM");
  const outcome = await instance.exit;
  assert.equal(outcome.code, 0, instance.output().stderr);
}

test("the no-cost demo handles conflicts, seeding, reset, and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-demo-launcher-"));
  const demoStateRoot = path.join(root, "managed");
  const port = await freePort();
  try {
    const unmanagedRoot = path.join(root, "unmanaged");
    const sentinel = path.join(unmanagedRoot, "do-not-delete.txt");
    await mkdir(unmanagedRoot);
    await writeFile(sentinel, "unrelated host data\n", "utf8");
    const unmanaged = startDemo(unmanagedRoot, await freePort(), true);
    const unmanagedExit = await unmanaged.exit;
    assert.equal(unmanagedExit.code, 1);
    assert.match(unmanaged.output().stderr, /non-Airlock demo data root/);
    await access(sentinel);

    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port }, resolve);
    });
    const blocked = startDemo(demoStateRoot, port);
    const blockedExit = await blocked.exit;
    assert.equal(blockedExit.code, 1);
    assert.match(blocked.output().stderr, /already in use/);
    await new Promise((resolve) => blocker.close(resolve));

    const first = startDemo(demoStateRoot, port, true);
    await waitUntilReady(first, port);
    assert.match(first.output().stdout, /No ModelArk request or paid inference/);
    const system = await fetch("http://127.0.0.1:" + port + "/api/system").then(
      (response) => response.json(),
    );
    assert.equal(system.demoMode, true);
    assert.equal(system.inferenceMode, "deterministic-local-fixture");
    const initialAgents = await fetch(
      "http://127.0.0.1:" + port + "/api/agents",
    ).then((response) => response.json());
    assert.equal(initialAgents.agents.length, 1);
    assert.equal(initialAgents.agents[0].name, "Airlock Demo");
    const initialId = initialAgents.agents[0].id;
    await stopDemo(first);

    const restarted = startDemo(demoStateRoot, port);
    await waitUntilReady(restarted, port);
    const restartedAgents = await fetch(
      "http://127.0.0.1:" + port + "/api/agents",
    ).then((response) => response.json());
    assert.equal(restartedAgents.agents[0].id, initialId);
    await stopDemo(restarted);

    const reset = startDemo(demoStateRoot, port, true);
    await waitUntilReady(reset, port);
    const resetAgents = await fetch(
      "http://127.0.0.1:" + port + "/api/agents",
    ).then((response) => response.json());
    assert.notEqual(resetAgents.agents[0].id, initialId);
    await stopDemo(reset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
