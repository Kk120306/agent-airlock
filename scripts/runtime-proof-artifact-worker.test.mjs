import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(
  new URL("./runtime-proof-artifact-worker.mjs", import.meta.url),
);

async function runWorker(directory, request) {
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const anchor = await directoryHandle.stat();
    const child = spawn(process.execPath, [workerPath], {
      cwd: directory,
      env: {},
      stdio: ["pipe", "pipe", "ignore", directoryHandle.fd],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stdin.end(
      JSON.stringify({
        ...request,
        anchorDev: String(anchor.dev),
        anchorIno: String(anchor.ino),
      }),
    );
    const outcome = await new Promise((resolve) => {
      child.once("error", () => resolve({ code: null, signal: "error" }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat(chunks).toString("utf8");
    return {
      ...outcome,
      response: output.length > 0 ? JSON.parse(output) : null,
    };
  } finally {
    await directoryHandle.close();
  }
}

async function runWorkerPausedAfterCommitLink(directory, request) {
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  let child = null;
  try {
    const anchor = await directoryHandle.stat();
    child = spawn(process.execPath, [workerPath], {
      cwd: directory,
      env: { AGENT_AIRLOCK_TEST_PAUSE_AFTER_COMMIT_LINK: "1" },
      stdio: ["pipe", "pipe", "ignore", directoryHandle.fd, "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    let gateOutput = "";
    const linked = new Promise((resolve) => {
      child.stdio[4].on("data", (chunk) => {
        gateOutput += chunk.toString("utf8");
        if (gateOutput.includes("linked\n")) resolve(true);
      });
    });
    const outcomePromise = new Promise((resolve) => {
      child.once("error", () => resolve({ code: null, signal: "error" }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(
      JSON.stringify({
        ...request,
        testPauseAfterLink: true,
        anchorDev: String(anchor.dev),
        anchorIno: String(anchor.ino),
      }),
    );
    const gate = await Promise.race([
      linked.then(() => "linked"),
      outcomePromise.then(() => "closed"),
      new Promise((resolve) => {
        const gateTimeout = setTimeout(() => resolve("timed-out"), 5_000);
        gateTimeout.unref();
      }),
    ]);
    if (gate !== "linked") {
      throw new Error(`commit worker did not reach the link gate: ${gate}`);
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, request.recordingDeadlineAt - Date.now() + 50),
      ),
    );
    const resumedAt = Date.now();
    child.kill("SIGCONT");
    const outcome = await outcomePromise;
    const output = Buffer.concat(chunks).toString("utf8");
    return {
      ...outcome,
      linked: true,
      resumedAt,
      response: output.length > 0 ? JSON.parse(output) : null,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
    await directoryHandle.close();
  }
}

function encoded(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

test("commit-replace preserves the validated prepared inode", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-commit-"),
  );
  await chmod(directory, 0o700);
  const content = "validated capsule\n";
  try {
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: "latest.json",
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    });
    assert.equal(prepared.code, 0);
    assert.equal(prepared.response?.ok, true);
    const token = prepared.response.token;
    const preparedStatus = await stat(
      path.join(directory, token.temporaryName),
      { bigint: true },
    );

    const committed = await runWorker(directory, {
      operation: "commit-replace",
      name: "latest.json",
      token,
      recordingDeadlineAt: Date.now() + 10_000,
    });
    assert.equal(committed.code, 0);
    assert.deepEqual(committed.response, { ok: true, committed: true });
    const destinationStatus = await stat(path.join(directory, "latest.json"), {
      bigint: true,
    });
    assert.equal(destinationStatus.dev, preparedStatus.dev);
    assert.equal(destinationStatus.ino, preparedStatus.ino);
    assert.equal(destinationStatus.nlink, 1n);
    assert.equal(destinationStatus.mode & 0o7777n, 0o600n);
    assert.equal(
      await readFile(path.join(directory, "latest.json"), "utf8"),
      content,
    );
    await assert.rejects(lstat(path.join(directory, token.temporaryName)), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit-replace rejects prepared mode drift", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-mode-drift-"),
  );
  await chmod(directory, 0o700);
  const content = "mode-pinned capsule\n";
  try {
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: "latest.json",
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    });
    assert.equal(prepared.code, 0);
    const token = prepared.response.token;
    await chmod(path.join(directory, token.temporaryName), 0o400);

    const rejected = await runWorker(directory, {
      operation: "commit-replace",
      name: "latest.json",
      token,
      recordingDeadlineAt: Date.now() + 10_000,
    });
    assert.equal(rejected.code, 1);
    assert.deepEqual(rejected.response, { ok: false });
    await assert.rejects(lstat(path.join(directory, "latest.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit-replace requires an absolute recording deadline", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-missing-deadline-"),
  );
  await chmod(directory, 0o700);
  const content = "deadline-bound capsule\n";
  try {
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: "latest.json",
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    });
    assert.equal(prepared.code, 0);

    const rejected = await runWorker(directory, {
      operation: "commit-replace",
      name: "latest.json",
      token: prepared.response.token,
    });
    assert.equal(rejected.code, 1);
    assert.deepEqual(rejected.response, { ok: false });
    await assert.rejects(lstat(path.join(directory, "latest.json")), {
      code: "ENOENT",
    });

    const discarded = await runWorker(directory, {
      operation: "discard-prepared",
      token: prepared.response.token,
    });
    assert.equal(discarded.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit-replace cannot publish after pausing past its recording deadline", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-late-commit-"),
  );
  await chmod(directory, 0o700);
  const prior = "prior capsule\n";
  const replacement = "late replacement capsule\n";
  const destinationPath = path.join(directory, "latest.json");
  try {
    await writeFile(destinationPath, prior, { mode: 0o600, flag: "wx" });
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: path.basename(destinationPath),
      content: encoded(replacement),
      maximumBytes: Buffer.byteLength(replacement),
    });
    assert.equal(prepared.code, 0);
    const token = prepared.response.token;
    const recordingDeadlineAt = Date.now() + 750;

    const rejected = await runWorkerPausedAfterCommitLink(directory, {
      operation: "commit-replace",
      name: path.basename(destinationPath),
      token,
      recordingDeadlineAt,
    });
    assert.equal(rejected.linked, true);
    assert.ok(rejected.resumedAt >= recordingDeadlineAt);
    assert.equal(rejected.code, 1);
    assert.deepEqual(rejected.response, { ok: false });
    assert.equal(await readFile(destinationPath, "utf8"), prior);
    assert.deepEqual(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".runtime-proof-tmp-"),
      ),
      [token.temporaryName],
    );

    const discarded = await runWorker(directory, {
      operation: "discard-prepared",
      token,
    });
    assert.equal(discarded.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile-replace preserves the prior pointer when no rename occurred", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-pre-rename-loss-"),
  );
  await chmod(directory, 0o700);
  const prior = "prior capsule\n";
  const replacement = "replacement capsule\n";
  const destinationPath = path.join(directory, "latest.json");
  try {
    await writeFile(destinationPath, prior, { mode: 0o600, flag: "wx" });
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: path.basename(destinationPath),
      content: encoded(replacement),
      maximumBytes: Buffer.byteLength(replacement),
    });
    assert.equal(prepared.code, 0);

    const reconciled = await runWorker(directory, {
      operation: "reconcile-replace",
      name: path.basename(destinationPath),
      token: prepared.response.token,
    });
    assert.equal(reconciled.code, 0);
    assert.deepEqual(reconciled.response, {
      ok: true,
      committed: false,
    });
    assert.equal(await readFile(destinationPath, "utf8"), prior);

    const discarded = await runWorker(directory, {
      operation: "discard-prepared",
      token: prepared.response.token,
    });
    assert.equal(discarded.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile-replace makes a renamed pointer durable after response loss", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-post-rename-loss-"),
  );
  await chmod(directory, 0o700);
  const replacement = "renamed capsule\n";
  const destinationPath = path.join(directory, "latest.json");
  try {
    const prepared = await runWorker(directory, {
      operation: "prepare-replace",
      name: path.basename(destinationPath),
      content: encoded(replacement),
      maximumBytes: Buffer.byteLength(replacement),
    });
    assert.equal(prepared.code, 0);
    const token = prepared.response.token;
    const attemptName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
    await link(
      path.join(directory, token.temporaryName),
      path.join(directory, attemptName),
    );
    await rename(path.join(directory, attemptName), destinationPath);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 2n);

    const reconciled = await runWorker(directory, {
      operation: "reconcile-replace",
      name: path.basename(destinationPath),
      token,
    });
    assert.equal(reconciled.code, 0);
    assert.deepEqual(reconciled.response, {
      ok: true,
      committed: true,
    });
    assert.equal(await readFile(destinationPath, "utf8"), replacement);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 1n);
    await assert.rejects(lstat(path.join(directory, token.temporaryName)), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install-immutable recovers one interrupted temporary hard link", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-recover-"),
  );
  await chmod(directory, 0o700);
  const content = "immutable authority\n";
  const temporaryName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
  const temporaryPath = path.join(directory, temporaryName);
  const destinationPath = path.join(directory, "sha256-authority.json");
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await link(temporaryPath, destinationPath);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 2n);

    const recovered = await runWorker(directory, {
      operation: "install-immutable",
      name: path.basename(destinationPath),
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    });
    assert.equal(recovered.code, 0);
    assert.deepEqual(recovered.response, { ok: true, installed: false });
    assert.equal(await readFile(destinationPath, "utf8"), content);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 1n);
    await assert.rejects(lstat(temporaryPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent recovery of one interrupted hard link is idempotent", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-concurrent-recover-"),
  );
  await chmod(directory, 0o700);
  const content = "concurrent immutable authority\n";
  const temporaryName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
  const temporaryPath = path.join(directory, temporaryName);
  const destinationPath = path.join(directory, "sha256-authority.json");
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await link(temporaryPath, destinationPath);

    const request = {
      operation: "install-immutable",
      name: path.basename(destinationPath),
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    };
    const recoveries = await Promise.all([
      runWorker(directory, request),
      runWorker(directory, request),
      runWorker(directory, request),
    ]);
    for (const recovered of recoveries) {
      assert.equal(recovered.code, 0);
      assert.deepEqual(recovered.response, { ok: true, installed: false });
    }
    assert.equal(await readFile(destinationPath, "utf8"), content);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 1n);
    await assert.rejects(lstat(temporaryPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install-immutable rejects an ambiguous interrupted hard-link set", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "airlock-artifact-worker-ambiguous-"),
  );
  await chmod(directory, 0o700);
  const content = "ambiguous authority\n";
  const firstTemporaryName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
  const secondTemporaryName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
  const firstTemporaryPath = path.join(directory, firstTemporaryName);
  const secondTemporaryPath = path.join(directory, secondTemporaryName);
  const destinationPath = path.join(directory, "sha256-authority.json");
  try {
    await writeFile(firstTemporaryPath, content, { mode: 0o600, flag: "wx" });
    await link(firstTemporaryPath, secondTemporaryPath);
    await link(firstTemporaryPath, destinationPath);
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 3n);

    const rejected = await runWorker(directory, {
      operation: "install-immutable",
      name: path.basename(destinationPath),
      content: encoded(content),
      maximumBytes: Buffer.byteLength(content),
    });
    assert.equal(rejected.code, 1);
    assert.deepEqual(rejected.response, { ok: false });
    assert.equal((await stat(destinationPath, { bigint: true })).nlink, 3n);
    assert.equal(await readFile(destinationPath, "utf8"), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
