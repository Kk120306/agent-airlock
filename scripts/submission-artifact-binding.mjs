import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { runTrustedGit } from "./trusted-git-exec.mjs";

const gitObjectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export const requiredSubmissionArtifacts = Object.freeze([
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  ".env.example",
  ".github/workflows/release-proof.yml",
  "Dockerfile",
  "Dockerfile.runtime",
  "docker-compose.yml",
  "docker/codex-runtime/package.json",
  "docker/codex-runtime/package-lock.json",
  "playwright.container-browser.config.ts",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/http-object-resource/package.json",
  "packages/portable-promotion-receipt/package.json",
  "packages/transactional-resource-sdk/package.json",
  "README.md",
  "docs/demo/DEVPOST_SUBMISSION.md",
  "docs/demo/SUBMISSION_BRIEF.md",
  "docs/demo/JUDGE_CHECKLIST.md",
  "docs/product/PRD.md",
  "docs/product/OUTCOME_ROADMAP.md",
  "docs/DEPLOYMENT.md",
  "deploy/volcengine/main.tf",
  "docs/demo/three-minute-demo.md",
  "docs/demo/architecture-one-page.md",
  "docs/demo/agent-airlock-one-page.mmd",
  "docs/demo/agent-airlock-one-page.png",
  "docs/demo/submission-assets.json",
  "docs/assets/agent-airlock-live-01-overview.jpg",
  "docs/assets/agent-airlock-live-02-quarantine.jpg",
  "docs/assets/agent-airlock-live-03-verified-recovery.jpg",
  "docs/assets/agent-airlock-live-04-zero-upload-verifier.jpg",
  "scripts/modelark-claim-policy.mjs",
  "scripts/modelark-demo-profile.mjs",
  "scripts/release-audit.mjs",
  "scripts/release-compose-policy.mjs",
  "scripts/release-compose-policy.test.mjs",
  "scripts/release-execution-policy.mjs",
  "scripts/release-execution-policy.test.mjs",
  "scripts/release-image-policy.mjs",
  "scripts/release-index-policy.mjs",
  "scripts/release-lockfile-policy.mjs",
  "scripts/release-lockfile-policy.test.mjs",
  "scripts/release-quality-policy.mjs",
  "scripts/release-quality-policy.test.mjs",
  "scripts/release-secret-policy.mjs",
  "scripts/runtime-proof-capsule-binding.mjs",
  "scripts/runtime-proof-runner.mjs",
  "scripts/runtime-proof-runner.test.mjs",
  "scripts/prove-runtime.mjs",
  "scripts/bootstrap-local.sh",
  "scripts/start-local-poc.sh",
  "scripts/deploy-existing-ecs.sh",
  "scripts/check-phase-eleven-docker.sh",
  "scripts/check-phase-thirteen.mjs",
  "scripts/production-build-context.mjs",
  "scripts/production-build-context.test.mjs",
  "scripts/check-container-transaction.mjs",
  "scripts/check-production-image-browser.mjs",
  "scripts/check-production-image-browser.test.mjs",
  "scripts/check-production-image-transaction.mjs",
  "scripts/check-production-image-transaction.test.mjs",
  "scripts/container-browser-fixture-startup.mjs",
  "scripts/container-browser-fixture-startup.test.mjs",
  "scripts/demo-outcome-contract.mjs",
  "scripts/judge-readiness.mjs",
  "scripts/production-image-verifier.mjs",
  "scripts/production-image-verifier.test.mjs",
  "scripts/production-image-persistence-verifier.mjs",
  "scripts/production-image-persistence-verifier.test.mjs",
  "scripts/production-image-provenance.mjs",
  "scripts/production-image-provenance.test.mjs",
  "scripts/production-gate-cleanup.test.mjs",
  "scripts/submission-artifact-binding.mjs",
  "scripts/submission-audit.mjs",
  "scripts/trusted-git-exec.mjs",
  "scripts/run-container-browser-fixture.mjs",
  "scripts/runtime-demo-profile.mjs",
  "scripts/runtime-proof-terminal.mjs",
  "scripts/runtime-source-provenance.mjs",
  "scripts/runtime-source-provenance.test.mjs",
  "tests/container-browser/global-teardown.ts",
  "tests/container-browser/real-container.spec.ts",
  "tests/fixtures/responses-protocol-server.mjs",
]);

export const requiredSubmissionArtifactModes = Object.freeze(
  Object.fromEntries(
    requiredSubmissionArtifacts.map((artifactPath) => [
      artifactPath,
      [
        "scripts/bootstrap-local.sh",
        "scripts/start-local-poc.sh",
        "scripts/deploy-existing-ecs.sh",
        "scripts/check-phase-eleven-docker.sh",
      ].includes(artifactPath)
        ? "100755"
        : "100644",
    ]),
  ),
);

function result(valid, reason, detail, artifacts = [], metadata = {}) {
  return { valid, reason, detail, artifacts, ...metadata };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function stdoutBuffer(commandResult) {
  const stdout = commandResult?.stdout;
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
}

function resolvedArtifactPath(root, artifactPath) {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.length === 0 ||
    artifactPath.includes("\\") ||
    artifactPath.includes("\0") ||
    path.posix.isAbsolute(artifactPath) ||
    path.posix.normalize(artifactPath) !== artifactPath ||
    artifactPath === "." ||
    artifactPath.startsWith("../")
  ) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...artifactPath.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  const contained =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep);
  return contained ? resolved : null;
}

async function verifyAncestorDirectories(root, artifactPath) {
  let current = path.resolve(root);
  const components = artifactPath.split("/").slice(0, -1);
  for (const component of components) {
    current = path.join(current, component);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      return result(
        false,
        "working-parent-unavailable",
        `${artifactPath}: ${errorDetail(error)}`,
      );
    }
    if (stats.isSymbolicLink()) {
      return result(
        false,
        "working-parent-symlink",
        `${artifactPath}: ${path.relative(root, current)} is a symbolic link`,
      );
    }
    if (!stats.isDirectory()) {
      return result(
        false,
        "working-parent-not-directory",
        `${artifactPath}: ${path.relative(root, current)} is not a directory`,
      );
    }
  }
  return null;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readRegularFileWithoutFollowingLinks(root, artifactPath) {
  const fullPath = resolvedArtifactPath(root, artifactPath);
  if (fullPath === null) {
    return result(
      false,
      "invalid-artifact-path",
      `${String(artifactPath)} is not a canonical repository-relative path`,
    );
  }
  const ancestorFailure = await verifyAncestorDirectories(root, artifactPath);
  if (ancestorFailure !== null) return ancestorFailure;

  let pathStats;
  try {
    pathStats = await lstat(fullPath, { bigint: true });
  } catch (error) {
    return result(
      false,
      "working-file-unavailable",
      `${artifactPath}: ${errorDetail(error)}`,
    );
  }
  if (pathStats.isSymbolicLink()) {
    return result(
      false,
      "working-file-symlink",
      `${artifactPath} is a symbolic link`,
    );
  }
  if (!pathStats.isFile()) {
    return result(
      false,
      "working-file-not-regular",
      `${artifactPath} is not a regular file`,
    );
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    return result(
      false,
      "nofollow-unavailable",
      "The current platform cannot safely open submission artifacts without following links",
    );
  }

  let handle;
  try {
    handle = await open(
      fullPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile()) {
      return result(
        false,
        "opened-file-not-regular",
        `${artifactPath} did not open as a regular file`,
      );
    }
    if (!sameInode(pathStats, openedStats)) {
      return result(
        false,
        "working-file-replaced",
        `${artifactPath} changed between path inspection and open`,
      );
    }
    const bytes = await handle.readFile();
    const completedStats = await handle.stat({ bigint: true });
    if (!sameSnapshot(openedStats, completedStats)) {
      return result(
        false,
        "working-file-changed",
        `${artifactPath} changed while it was being read`,
      );
    }
    return { valid: true, bytes };
  } catch (error) {
    return result(
      false,
      "working-file-open-failed",
      `${artifactPath}: ${errorDetail(error)}`,
    );
  } finally {
    await handle?.close();
  }
}

function parseGitTree(bytes) {
  const entries = new Map();
  for (const record of bytes.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 1) {
      throw new Error("Git returned a malformed tree entry");
    }
    const metadata = record.slice(0, separator).split(" ");
    const artifactPath = record.slice(separator + 1);
    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/.test(metadata[0]) ||
      !gitObjectIdPattern.test(metadata[2]) ||
      entries.has(artifactPath)
    ) {
      throw new Error("Git returned a malformed or duplicate tree entry");
    }
    entries.set(artifactPath, {
      mode: metadata[0],
      type: metadata[1],
      objectId: metadata[2],
    });
  }
  return entries;
}

export async function inspectCommittedSubmissionArtifacts({ root, exec } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    return result(false, "invalid-root", "A repository root is required");
  }
  if (
    new Set(requiredSubmissionArtifacts).size !==
    requiredSubmissionArtifacts.length
  ) {
    return result(
      false,
      "invalid-artifact-policy",
      "The required submission artifact policy contains duplicate paths",
    );
  }

  const gitOptions = {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  };
  let revision;
  try {
    const revisionResult = await runTrustedGit(
      ["rev-parse", "HEAD"],
      gitOptions,
      exec,
    );
    revision = stdoutBuffer(revisionResult).toString("utf8").trim();
    if (!gitObjectIdPattern.test(revision)) {
      throw new Error("Git returned an invalid HEAD object ID");
    }
  } catch (error) {
    return result(false, "git-revision-inspection-failed", errorDetail(error));
  }

  const workingFiles = new Map();
  for (const artifactPath of requiredSubmissionArtifacts) {
    const inspected = await readRegularFileWithoutFollowingLinks(
      root,
      artifactPath,
    );
    if (!inspected.valid) return inspected;
    workingFiles.set(artifactPath, inspected.bytes);
  }

  let tree;
  try {
    const treeResult = await runTrustedGit(
      ["ls-tree", "-z", revision, "--", ...requiredSubmissionArtifacts],
      gitOptions,
      exec,
    );
    tree = parseGitTree(stdoutBuffer(treeResult));
  } catch (error) {
    return result(false, "git-tree-inspection-failed", errorDetail(error));
  }

  const verified = [];
  const committedFiles = new Map();
  for (const artifactPath of requiredSubmissionArtifacts) {
    const entry = tree.get(artifactPath);
    if (entry === undefined) {
      return result(
        false,
        "artifact-not-committed",
        `${artifactPath} is not a tracked entry in HEAD`,
      );
    }
    if (entry.type !== "blob") {
      return result(
        false,
        "artifact-not-blob",
        `${artifactPath} is a ${entry.type} entry in HEAD instead of a blob`,
      );
    }
    const expectedMode = requiredSubmissionArtifactModes[artifactPath];
    if (entry.mode !== expectedMode) {
      return result(
        false,
        "artifact-mode-mismatch",
        `${artifactPath} has Git mode ${entry.mode}; expected ${expectedMode}`,
      );
    }

    let committedBytes;
    try {
      const blobResult = await runTrustedGit(
        ["cat-file", "blob", `${revision}:${artifactPath}`],
        gitOptions,
        exec,
      );
      committedBytes = stdoutBuffer(blobResult);
    } catch (error) {
      return result(
        false,
        "git-blob-read-failed",
        `${artifactPath}: ${errorDetail(error)}`,
      );
    }
    const workingBytes = workingFiles.get(artifactPath);
    if (!workingBytes.equals(committedBytes)) {
      return result(
        false,
        "artifact-bytes-mismatch",
        `${artifactPath} does not match the blob committed at HEAD`,
      );
    }
    committedFiles.set(artifactPath, committedBytes);
    verified.push({
      path: artifactPath,
      mode: entry.mode,
      objectId: entry.objectId,
      bytes: workingBytes.length,
      sha256: sha256(workingBytes),
    });
  }

  if (tree.size !== requiredSubmissionArtifacts.length) {
    return result(
      false,
      "unexpected-git-tree-result",
      "Git returned an unexpected submission artifact tree entry",
    );
  }

  for (const artifactPath of requiredSubmissionArtifacts) {
    const completed = await readRegularFileWithoutFollowingLinks(
      root,
      artifactPath,
    );
    if (!completed.valid) return completed;
    if (
      !completed.bytes.equals(workingFiles.get(artifactPath)) ||
      !completed.bytes.equals(committedFiles.get(artifactPath))
    ) {
      return result(
        false,
        "artifact-changed-during-inspection",
        `${artifactPath} changed during committed artifact inspection`,
      );
    }
  }
  try {
    const closingRevisionResult = await runTrustedGit(
      ["rev-parse", "HEAD"],
      gitOptions,
      exec,
    );
    const closingRevision = stdoutBuffer(closingRevisionResult)
      .toString("utf8")
      .trim();
    if (closingRevision !== revision) {
      return result(
        false,
        "git-revision-changed-during-inspection",
        "HEAD changed during committed artifact inspection",
      );
    }
  } catch (error) {
    return result(false, "git-revision-recheck-failed", errorDetail(error));
  }
  const artifactSetDigest = sha256(
    Buffer.from(JSON.stringify(verified), "utf8"),
  );
  return result(
    true,
    "committed-artifacts-match",
    `${verified.length} required submission artifacts are regular files and match HEAD byte-for-byte`,
    verified,
    { revision, artifactSetDigest },
  );
}
