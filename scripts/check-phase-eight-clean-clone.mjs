import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertGitSourceMatchesHead } from "./runtime-source-provenance.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const phase = process.env.AIRLOCK_CLEAN_CLONE_PHASE ?? "phase8";
if (
  phase !== "phase8" &&
  phase !== "phase9" &&
  phase !== "phase10" &&
  phase !== "phase11"
) {
  process.stderr.write("Unsupported clean-clone phase: " + phase + "\n");
  process.exit(1);
}
const phaseLabel =
  phase === "phase8"
    ? "Phase 8"
    : phase === "phase9"
      ? "Phase 9"
      : phase === "phase10"
        ? "Phase 10"
        : "Phase 11";
const sourceSnapshot = await inspectCleanSource(projectRoot).catch((error) => {
  process.stderr.write(
    phaseLabel + " clean-clone verification requires exact clean committed source: " +
      error.message +
      "\n",
  );
  process.exit(1);
});
const sourceRevision = sourceSnapshot.revision;
const temporaryParent = path.join(projectRoot, ".local", "clean-clones");
await mkdir(temporaryParent, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(temporaryParent, "airlock-phase-eight-clone-"));
const cloneRoot = path.join(temporaryRoot, "repository");

try {
  await runTrustedGit(
    ["clone", "--local", "--no-hardlinks", projectRoot, cloneRoot],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const cloneRevision = (
    await runTrustedGit(["rev-parse", "HEAD"], {
      cwd: cloneRoot,
      encoding: "utf8",
    })
  ).stdout.trim();
  if (cloneRevision !== sourceRevision) {
    throw new Error("Clean clone did not resolve the source revision");
  }
  await run("npm", ["ci", "--ignore-scripts"], { cwd: cloneRoot });
  for (let pass = 1; pass <= 2; pass += 1) {
    await assertPortsAvailable(phasePorts(phase));
    await run("npm", ["run", "check:" + phase + ":core"], { cwd: cloneRoot });
    await assertPortsAvailable(phasePorts(phase));
    const leaked = await processesContaining(cloneRoot);
    if (leaked.length > 0) {
      throw new Error(
        phaseLabel + " gate left child processes after pass " +
          pass +
          ": " +
          leaked.join(" | "),
      );
    }
  }
  const closingSnapshot = await inspectCleanSource(projectRoot);
  if (
    closingSnapshot.revision !== sourceSnapshot.revision ||
    closingSnapshot.treeDigest !== sourceSnapshot.treeDigest ||
    closingSnapshot.objectFormat !== sourceSnapshot.objectFormat
  ) {
    throw new Error("Clean-clone source changed while the release gate ran");
  }
  process.stdout.write(
    phaseLabel + " clean clone passed twice at " + sourceRevision.slice(0, 12) + ".\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function inspectCleanSource(root) {
  const textOptions = {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
  const [revisionResult, treeResult, formatResult, statusResult] =
    await Promise.all([
      runTrustedGit(["rev-parse", "HEAD"], textOptions),
      runTrustedGit(["rev-parse", "HEAD^{tree}"], textOptions),
      runTrustedGit(["rev-parse", "--show-object-format"], textOptions),
      runTrustedGit(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        { ...textOptions, encoding: "buffer" },
      ),
    ]);
  if (statusResult.stdout.length !== 0) {
    throw new Error("the worktree is not clean");
  }
  const objectFormat = formatResult.stdout.trim();
  await assertGitSourceMatchesHead({ root, objectFormat });
  return {
    revision: revisionResult.stdout.trim(),
    treeDigest: treeResult.stdout.trim(),
    objectFormat,
  };
}

function phasePorts(selectedPhase) {
  const ports = [3199, 3200, 3208];
  if (selectedPhase === "phase10" || selectedPhase === "phase11") ports.push(3210);
  if (selectedPhase === "phase11") ports.push(3211);
  return ports;
}

function run(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      ...options,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          command +
            " exited with " +
            (signal ? "signal " + signal : "status " + String(code)),
        ),
      );
    });
  });
}

function capture(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8_192);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(command + " failed: " + stderr.trim()));
    });
  });
}

async function assertPortsAvailable(ports) {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.unref();
      probe.once("error", (error) => {
        reject(new Error("Loopback port " + port + " is unavailable: " + error.message));
      });
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        probe.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }
}

async function processesContaining(fragment) {
  const output = await capture("ps", ["-ax", "-o", "pid=,command="]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment));
}
