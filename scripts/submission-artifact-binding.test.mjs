import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectCommittedSubmissionArtifacts,
  requiredSubmissionArtifacts,
} from "./submission-artifact-binding.mjs";
import {
  runTrustedGit,
  trustedGitExecutable,
} from "./trusted-git-exec.mjs";

const objectId = "a".repeat(40);
const execFile = promisify(execFileCallback);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-artifacts-"));
  const committed = new Map();
  for (const artifactPath of requiredSubmissionArtifacts) {
    const bytes = Buffer.from(`committed:${artifactPath}\n`);
    committed.set(artifactPath, bytes);
    const fullPath = path.join(root, ...artifactPath.split("/"));
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
  }
  return { root, committed };
}

function gitStub(
  committed,
  {
    missing,
    mode = {},
    type = {},
    malformedTree = false,
    revisions = [objectId, objectId],
  } = {},
) {
  let revisionCall = 0;
  return async (command, argumentsList, options) => {
    assert.equal(command, trustedGitExecutable);
    assert.equal(options.env.PATH, "/usr/bin:/bin");
    assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_CONFIG_COUNT, "3");
    assert.equal(options.env.GIT_CONFIG_KEY_2, "core.hooksPath");
    assert.equal(options.env.GIT_CONFIG_VALUE_2, "/dev/null");
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal("GIT_DIR" in options.env, false);
    assert.equal("GIT_WORK_TREE" in options.env, false);
    if (argumentsList[0] === "rev-parse") {
      const revision = revisions[Math.min(revisionCall, revisions.length - 1)];
      revisionCall += 1;
      return { stdout: Buffer.from(`${revision}\n`) };
    }
    if (argumentsList[0] === "ls-tree") {
      if (malformedTree) return { stdout: Buffer.from("not-a-tree-entry\0") };
      const records = requiredSubmissionArtifacts
        .filter((artifactPath) => artifactPath !== missing)
        .map(
          (artifactPath) =>
            `${mode[artifactPath] ?? "100644"} ${type[artifactPath] ?? "blob"} ${objectId}\t${artifactPath}\0`,
        )
        .join("");
      return { stdout: Buffer.from(records) };
    }
    if (argumentsList[0] === "cat-file") {
      const spec = argumentsList[2];
      assert.match(spec, new RegExp(`^${objectId}:`));
      return { stdout: committed.get(spec.slice(objectId.length + 1)) };
    }
    throw new Error(`Unexpected Git command: ${argumentsList.join(" ")}`);
  };
}

async function withEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, overrides);
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function systemGit(root, argumentsList, { replacements = false } = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && typeof value === "string") {
      environment[name] = value;
    }
  }
  environment.PATH = "/usr/bin:/bin";
  if (!replacements) environment.GIT_NO_REPLACE_OBJECTS = "1";
  return execFile(trustedGitExecutable, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("binds every required regular file to its exact committed HEAD blob", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const inspected = await inspectCommittedSubmissionArtifacts({
    root,
    exec: gitStub(committed),
  });

  assert.equal(inspected.valid, true);
  assert.equal(inspected.reason, "committed-artifacts-match");
  assert.equal(inspected.revision, objectId);
  assert.match(inspected.artifactSetDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(inspected.artifacts.length, requiredSubmissionArtifacts.length);
  assert.deepEqual(
    inspected.artifacts.map((artifact) => artifact.path),
    requiredSubmissionArtifacts,
  );
});

test("ignores fake PATH and inherited Git repository selectors", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const inspected = await withEnvironment(
    {
      PATH: "/attacker/fake-bin",
      GIT_DIR: "/attacker/repository.git",
      GIT_WORK_TREE: "/attacker/worktree",
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_OPTIONAL_LOCKS: "1",
    },
    () =>
      inspectCommittedSubmissionArtifacts({
        root,
        exec: gitStub(committed),
      }),
  );

  assert.equal(inspected.valid, true);
  assert.equal(inspected.revision, objectId);
});

test("ignores global templates and prevents checkout hooks", async () => {
  const ownerRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-hostile-git-home-"),
  );
  const source = path.join(ownerRoot, "source");
  const hostileHome = path.join(ownerRoot, "home");
  const template = path.join(ownerRoot, "template");
  const vulnerableClone = path.join(ownerRoot, "vulnerable");
  const trustedClone = path.join(ownerRoot, "trusted");
  try {
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(hostileHome, { recursive: true }),
      mkdir(path.join(template, "hooks"), { recursive: true }),
    ]);
    await systemGit(source, ["init", "--quiet"]);
    await systemGit(source, ["config", "user.name", "Agent Airlock Test"]);
    await systemGit(source, [
      "config",
      "user.email",
      "airlock-test@example.invalid",
    ]);
    await writeFile(path.join(source, "tracked.txt"), "accepted\n");
    await systemGit(source, ["add", "tracked.txt"]);
    await systemGit(source, ["commit", "--quiet", "-m", "accepted source"]);
    await writeFile(
      path.join(hostileHome, ".gitconfig"),
      `[init]\n\ttemplateDir = ${template}\n`,
    );
    await writeFile(
      path.join(template, "hooks", "post-checkout"),
      "#!/bin/sh\nprintf 'hooked\\n' > tracked.txt\n",
      { mode: 0o700 },
    );
    const hostileEnvironment = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith("GIT_") && typeof value === "string") {
        hostileEnvironment[name] = value;
      }
    }
    hostileEnvironment.HOME = hostileHome;
    hostileEnvironment.PATH = "/usr/bin:/bin";

    await execFile(
      trustedGitExecutable,
      ["clone", "--quiet", "--no-checkout", source, vulnerableClone],
      { cwd: ownerRoot, env: hostileEnvironment },
    );
    await execFile(trustedGitExecutable, ["checkout", "--quiet", "HEAD"], {
      cwd: vulnerableClone,
      env: hostileEnvironment,
    });
    assert.equal(await readFile(path.join(vulnerableClone, "tracked.txt"), "utf8"), "hooked\n");

    await runTrustedGit(
      ["clone", "--quiet", "--no-checkout", source, trustedClone],
      { cwd: ownerRoot, encoding: "utf8", env: hostileEnvironment },
    );
    await runTrustedGit(["checkout", "--quiet", "HEAD"], {
      cwd: trustedClone,
      encoding: "utf8",
      env: hostileEnvironment,
    });
    assert.equal(
      await readFile(path.join(trustedClone, "tracked.txt"), "utf8"),
      "accepted\n",
    );
    await assert.rejects(
      readFile(path.join(trustedClone, ".git", "hooks", "post-checkout")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(ownerRoot, { recursive: true, force: true });
  }
});

test("rejects working bytes that only match a Git replacement commit", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await systemGit(root, ["init", "--quiet"]);
  await systemGit(root, ["config", "user.name", "Agent Airlock Test"]);
  await systemGit(root, ["config", "user.email", "airlock-test@example.invalid"]);
  await systemGit(root, ["add", "--all"]);
  await systemGit(root, ["commit", "--quiet", "-m", "source A"]);
  const { stdout: revisionAOutput } = await systemGit(root, [
    "rev-parse",
    "HEAD",
  ]);
  const revisionA = revisionAOutput.trim();
  const { stdout: treeAOutput } = await systemGit(root, [
    "rev-parse",
    "HEAD^{tree}",
  ]);

  for (const artifactPath of requiredSubmissionArtifacts) {
    await writeFile(
      path.join(root, ...artifactPath.split("/")),
      `replacement:${artifactPath}\n`,
    );
  }
  await systemGit(root, ["add", "--all"]);
  await systemGit(root, ["commit", "--quiet", "-m", "source B"]);
  const { stdout: revisionBOutput } = await systemGit(root, [
    "rev-parse",
    "HEAD",
  ]);
  const revisionB = revisionBOutput.trim();
  await systemGit(root, ["replace", revisionA, revisionB]);
  await systemGit(root, ["reset", "--hard", revisionA], {
    replacements: true,
  });

  const { stdout: vulnerableStatus } = await systemGit(
    root,
    ["status", "--porcelain=v1"],
    { replacements: true },
  );
  const { stdout: replacedTree } = await systemGit(
    root,
    ["rev-parse", "HEAD^{tree}"],
    { replacements: true },
  );
  assert.equal(vulnerableStatus, "");
  assert.notEqual(replacedTree.trim(), treeAOutput.trim());

  const inspected = await inspectCommittedSubmissionArtifacts({ root });
  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "artifact-bytes-mismatch");
});

test("rejects a working artifact whose bytes drift from HEAD", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "uncommitted drift\n");

  const inspected = await inspectCommittedSubmissionArtifacts({
    root,
    exec: gitStub(committed),
  });

  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "artifact-bytes-mismatch");
  assert.match(inspected.detail, /README\.md/);
});

test("rejects symbolic links and non-regular working artifacts", async (t) => {
  const linkedFixture = await fixture();
  t.after(() => rm(linkedFixture.root, { recursive: true, force: true }));
  const linkedPath = path.join(linkedFixture.root, "README.md");
  await unlink(linkedPath);
  await writeFile(path.join(linkedFixture.root, "linked-target.md"), "target\n");
  await symlink("linked-target.md", linkedPath);

  const linked = await inspectCommittedSubmissionArtifacts({
    root: linkedFixture.root,
    exec: gitStub(linkedFixture.committed),
  });
  assert.equal(linked.valid, false);
  assert.equal(linked.reason, "working-file-symlink");

  const directoryFixture = await fixture();
  t.after(() => rm(directoryFixture.root, { recursive: true, force: true }));
  const directoryPath = path.join(directoryFixture.root, "README.md");
  await unlink(directoryPath);
  await mkdir(directoryPath);

  const directory = await inspectCommittedSubmissionArtifacts({
    root: directoryFixture.root,
    exec: gitStub(directoryFixture.committed),
  });
  assert.equal(directory.valid, false);
  assert.equal(directory.reason, "working-file-not-regular");
});

test("rejects a symbolic-link ancestor before reading outside the repository", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = await mkdtemp(path.join(os.tmpdir(), "airlock-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.join(external, "demo"), { recursive: true });
  await writeFile(
    path.join(external, "demo", "DEVPOST_SUBMISSION.md"),
    committed.get("docs/demo/DEVPOST_SUBMISSION.md"),
  );
  await rm(path.join(root, "docs"), { recursive: true });
  await symlink(external, path.join(root, "docs"));

  const inspected = await inspectCommittedSubmissionArtifacts({
    root,
    exec: gitStub(committed),
  });

  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "working-parent-symlink");
  assert.match(inspected.detail, /docs/);
});

test("requires every artifact to be a tracked regular blob with its pinned mode", async (t) => {
  const missingFixture = await fixture();
  t.after(() => rm(missingFixture.root, { recursive: true, force: true }));
  const missing = await inspectCommittedSubmissionArtifacts({
    root: missingFixture.root,
    exec: gitStub(missingFixture.committed, { missing: "README.md" }),
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, "artifact-not-committed");

  const modeFixture = await fixture();
  t.after(() => rm(modeFixture.root, { recursive: true, force: true }));
  const wrongMode = await inspectCommittedSubmissionArtifacts({
    root: modeFixture.root,
    exec: gitStub(modeFixture.committed, {
      mode: { "README.md": "120000" },
    }),
  });
  assert.equal(wrongMode.valid, false);
  assert.equal(wrongMode.reason, "artifact-mode-mismatch");

  const typeFixture = await fixture();
  t.after(() => rm(typeFixture.root, { recursive: true, force: true }));
  const wrongType = await inspectCommittedSubmissionArtifacts({
    root: typeFixture.root,
    exec: gitStub(typeFixture.committed, {
      type: { "README.md": "tree" },
    }),
  });
  assert.equal(wrongType.valid, false);
  assert.equal(wrongType.reason, "artifact-not-blob");
});

test("fails closed when Git returns malformed tree metadata", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const inspected = await inspectCommittedSubmissionArtifacts({
    root,
    exec: gitStub(committed, { malformedTree: true }),
  });

  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "git-tree-inspection-failed");
  assert.match(inspected.detail, /malformed/);
});

test("rejects a required artifact changed after its initial working snapshot", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const delegate = gitStub(committed);
  let mutated = false;
  const exec = async (command, argumentsList, options) => {
    if (argumentsList[0] === "ls-tree" && !mutated) {
      mutated = true;
      await writeFile(path.join(root, "README.md"), "mid-audit drift\n");
    }
    return delegate(command, argumentsList, options);
  };

  const inspected = await inspectCommittedSubmissionArtifacts({ root, exec });

  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "artifact-changed-during-inspection");
  assert.match(inspected.detail, /README\.md/);
});

test("rejects HEAD moving during committed artifact inspection", async (t) => {
  const { root, committed } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const inspected = await inspectCommittedSubmissionArtifacts({
    root,
    exec: gitStub(committed, {
      revisions: [objectId, "b".repeat(40)],
    }),
  });

  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "git-revision-changed-during-inspection");
});
