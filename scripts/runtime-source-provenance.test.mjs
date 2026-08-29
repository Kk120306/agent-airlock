import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertMatchingRuntimeSourceProvenance,
  assertRuntimeSourceProvenance,
  inspectRuntimeSourceProvenance,
  inspectRuntimeSourceProvenanceSync,
  parseDefaultGitIndexPaths,
} from "./runtime-source-provenance.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const execFile = promisify(execFileCallback);

const revision = "a".repeat(40);
const treeDigest = "b".repeat(40);

function gitStub({ status = "", observedRevision = revision } = {}) {
  return async (_command, argumentsList) => {
    const argument = argumentsList.join(" ");
    if (argument === "rev-parse HEAD") return { stdout: observedRevision + "\n" };
    if (argument === "rev-parse HEAD^{tree}") {
      return { stdout: treeDigest + "\n" };
    }
    if (
      argument ===
      "status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none"
    ) {
      return { stdout: status };
    }
    if (
      argument === "ls-files --cached --full-name -v -z" ||
      argument === "ls-tree -r -z --full-tree HEAD"
    ) {
      return { stdout: "" };
    }
    if (argument === "rev-parse --show-object-format") {
      return { stdout: "sha1\n" };
    }
    if (argument === "config --get remote.origin.url") {
      return { stdout: "git@github.com:Kk120306/agent-airlock.git\n" };
    }
    throw new Error("unexpected Git command");
  };
}

const provenance = {
  claim: "runner-observed-clean-git-state-not-signed",
  repository: "github:Kk120306/agent-airlock",
  objectFormat: "sha1",
  commitOid: revision,
  treeOid: treeDigest,
  worktreeState: "clean",
};

test("captures the exact revision and tree only from a clean worktree", async () => {
  assert.deepEqual(
    await inspectRuntimeSourceProvenance({ root: "/project", exec: gitStub() }),
    provenance,
  );
  await assert.rejects(
    inspectRuntimeSourceProvenance({
      root: "/project",
      exec: gitStub({ status: " M README.md\n" }),
    }),
    /clean source tree/,
  );
});

test("rejects malformed and drifted source provenance", () => {
  assert.throws(
    () =>
      assertRuntimeSourceProvenance({
        ...provenance,
        commitOid: "HEAD",
      }),
    /provenance is invalid/,
  );
  assert.throws(
    () =>
      assertMatchingRuntimeSourceProvenance(
        provenance,
        { ...provenance, commitOid: "c".repeat(40) },
      ),
    /source changed/,
  );
});

test("synchronously rechecks the same exact clean source at commit time", () => {
  const execSync = (_command, argumentsList) => {
    const argument = argumentsList.join(" ");
    if (argument === "rev-parse HEAD") return revision + "\n";
    if (argument === "rev-parse HEAD^{tree}") return treeDigest + "\n";
    if (argument === "rev-parse --show-object-format") return "sha1\n";
    if (argument === "config --get remote.origin.url") {
      return "https://github.com/Kk120306/agent-airlock.git\n";
    }
    if (
      argument ===
        "status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none" ||
      argument === "ls-files --cached --full-name -v -z" ||
      argument === "ls-tree -r -z --full-tree HEAD"
    ) {
      return "";
    }
    throw new Error("unexpected Git command");
  };
  assert.deepEqual(
    inspectRuntimeSourceProvenanceSync({ root: "/project", execSync }),
    provenance,
  );
});

async function createGitRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-source-git-"));
  const git = (argumentsList, environment = process.env) =>
    execFile("/usr/bin/git", argumentsList, {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "airlock@example.test"]);
  await git(["config", "user.name", "Agent Airlock Test"]);
  await git([
    "remote",
    "add",
    "origin",
    "https://github.com/Kk120306/agent-airlock.git",
  ]);
  await writeFile(path.join(root, "tracked.txt"), "accepted\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-m", "accepted source"]);
  return { root, git };
}

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`rejects a real Git worktree hidden by ${flag}`, async () => {
    const { root, git } = await createGitRepository();
    try {
      await git(["update-index", flag, "tracked.txt"]);
      await writeFile(path.join(root, "tracked.txt"), "hidden mutation\n");
      const { stdout: status } = await git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      assert.equal(status, "", "the fixture must reproduce Git's false clean state");
      await assert.rejects(
        inspectRuntimeSourceProvenance({ root }),
        /default index flags/,
      );
      assert.throws(
        () => inspectRuntimeSourceProvenanceSync({ root }),
        /default index flags/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("uses the physical HEAD instead of a local replacement object", async () => {
  const { root, git } = await createGitRepository();
  try {
    const originalCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const originalTree = (
      await runTrustedGit(["rev-parse", "HEAD^{tree}"], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout.trim();
    await writeFile(path.join(root, "tracked.txt"), "replacement\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "replacement source"]);
    const replacementCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const replacementTree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await git(["checkout", "--detach", originalCommit]);
    await git(["replace", originalCommit, replacementCommit]);
    assert.equal((await readFile(path.join(root, "tracked.txt"), "utf8")), "accepted\n");
    assert.equal((await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(), replacementTree);

    const observed = await inspectRuntimeSourceProvenance({ root });
    assert.equal(observed.commitOid, originalCommit);
    assert.equal(observed.treeOid, originalTree);
    assert.notEqual(observed.treeOid, replacementTree);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses raw NUL-delimited index paths without line splitting", () => {
  const paths = parseDefaultGitIndexPaths(
    "/project",
    Buffer.from("H ordinary.txt\0H weird\nname\tpart.txt\0", "utf8"),
  );
  assert.deepEqual([...paths], ["ordinary.txt", "weird\nname\tpart.txt"]);
  assert.throws(
    () => parseDefaultGitIndexPaths("/project", Buffer.from("H missing-nul")),
    /unterminated record/,
  );
  assert.throws(
    () =>
      parseDefaultGitIndexPaths(
        "/project",
        Buffer.from([0x48, 0x20, 0xff, 0x00]),
      ),
    /non-UTF-8 path/,
  );
});
