import { createHash } from "node:crypto";
import {
  lstat as lstatDefault,
  lstatSync as lstatSyncDefault,
  readFile as readFileDefault,
  readFileSync as readFileSyncDefault,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  runTrustedGit,
  runTrustedGitSync,
} from "./trusted-git-exec.mjs";

const gitObjectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const sourceClaim = "runner-observed-clean-git-state-not-signed";
const sourceRepository = "github:Kk120306/agent-airlock";
const maxGitInspectionBytes = 16 * 1024 * 1024;
const regularGitModes = new Set(["100644", "100755"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const lstat = promisify(lstatDefault);
const readFile = promisify(readFileDefault);

function outputBytes(result) {
  const output = result?.stdout ?? result;
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === "string") return Buffer.from(output, "utf8");
  throw new Error("Git source inspection returned an invalid result");
}

function nulRecords(value) {
  const records = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    records.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) {
    throw new Error("Git source inspection returned an unterminated record");
  }
  return records;
}

function repositoryPath(root, value) {
  let relative;
  try {
    relative = utf8Decoder.decode(value);
  } catch {
    throw new Error("Git source inspection returned a non-UTF-8 path");
  }
  if (
    relative.length === 0 ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Git source inspection returned an unsafe path");
  }
  const resolved = path.resolve(root, ...relative.split("/"));
  const normalized = path.relative(root, resolved).split(path.sep).join("/");
  if (normalized !== relative || path.isAbsolute(normalized)) {
    throw new Error("Git source inspection returned an unsafe path");
  }
  return { relative, resolved };
}

export function parseDefaultGitIndexPaths(root, result) {
  const paths = new Set();
  for (const record of nulRecords(outputBytes(result))) {
    if (record.length < 3 || record[1] !== 0x20 || record[0] !== 0x48) {
      throw new Error("Git source inspection requires default index flags");
    }
    const { relative } = repositoryPath(root, record.subarray(2));
    if (paths.has(relative)) {
      throw new Error("Git source inspection found a duplicate index path");
    }
    paths.add(relative);
  }
  return paths;
}

function trackedRegularFiles(root, objectFormat, result, indexPaths) {
  const objectIdLength = objectFormat === "sha1" ? 40 : 64;
  const entries = [];
  const paths = new Set();
  for (const record of nulRecords(outputBytes(result))) {
    const separator = record.indexOf(0x09);
    if (separator < 1) {
      throw new Error("Git source inspection returned a malformed HEAD tree");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = header.match(/^(\d{6}) (blob|commit) ([a-f0-9]+)$/);
    if (!match || match[3].length !== objectIdLength) {
      throw new Error("Git source inspection returned a malformed HEAD tree");
    }
    const { relative, resolved } = repositoryPath(
      root,
      record.subarray(separator + 1),
    );
    if (paths.has(relative)) {
      throw new Error("Git source inspection found a duplicate HEAD path");
    }
    paths.add(relative);
    if (!indexPaths.has(relative)) {
      throw new Error("Git source inspection found HEAD and index drift");
    }
    if (match[2] === "blob" && regularGitModes.has(match[1])) {
      entries.push({ relative, resolved, objectId: match[3] });
    }
  }
  return entries;
}

function gitBlobObjectId(bytes, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

async function assertRegularFilesMatchHead(entries, objectFormat, inspect, read) {
  for (const entry of entries) {
    const before = await inspect(entry.resolved);
    if (!before.isFile()) {
      throw new Error(
        `Git source inspection requires a regular tracked file: ${entry.relative}`,
      );
    }
    const bytes = await read(entry.resolved);
    const after = await inspect(entry.resolved);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      gitBlobObjectId(bytes, objectFormat) !== entry.objectId
    ) {
      throw new Error(
        `Git source inspection found tracked bytes that do not match HEAD: ${entry.relative}`,
      );
    }
  }
}

function assertRegularFilesMatchHeadSync(entries, objectFormat, inspect, read) {
  for (const entry of entries) {
    const before = inspect(entry.resolved);
    if (!before.isFile()) {
      throw new Error(
        `Git source inspection requires a regular tracked file: ${entry.relative}`,
      );
    }
    const bytes = read(entry.resolved);
    const after = inspect(entry.resolved);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      gitBlobObjectId(bytes, objectFormat) !== entry.objectId
    ) {
      throw new Error(
        `Git source inspection found tracked bytes that do not match HEAD: ${entry.relative}`,
      );
    }
  }
}

export async function assertGitSourceMatchesHead({
  root,
  objectFormat,
  exec,
  inspect = lstat,
  read = readFile,
} = {}) {
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw new Error("Git source inspection received an invalid object format");
  }
  const options = {
    cwd: root,
    encoding: "buffer",
    maxBuffer: maxGitInspectionBytes,
  };
  const [indexResult, treeResult] = await Promise.all([
    runTrustedGit(
      ["ls-files", "--cached", "--full-name", "-v", "-z"],
      options,
      exec,
    ),
    runTrustedGit(
      ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
      options,
      exec,
    ),
  ]);
  const indexPaths = parseDefaultGitIndexPaths(root, indexResult);
  const entries = trackedRegularFiles(
    root,
    objectFormat,
    treeResult,
    indexPaths,
  );
  await assertRegularFilesMatchHead(entries, objectFormat, inspect, read);
  return { trackedRegularFileCount: entries.length };
}

export function assertGitSourceMatchesHeadSync({
  root,
  objectFormat,
  execSync,
  inspect = lstatSyncDefault,
  read = readFileSyncDefault,
} = {}) {
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw new Error("Git source inspection received an invalid object format");
  }
  const run = (argumentsList) =>
    runTrustedGitSync(
      argumentsList,
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: maxGitInspectionBytes,
      },
      execSync,
    );
  const indexPaths = parseDefaultGitIndexPaths(
    root,
    run(["ls-files", "--cached", "--full-name", "-v", "-z"]),
  );
  const entries = trackedRegularFiles(
    root,
    objectFormat,
    run(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]),
    indexPaths,
  );
  assertRegularFilesMatchHeadSync(entries, objectFormat, inspect, read);
  return { trackedRegularFileCount: entries.length };
}

function normalizedRepository(value) {
  const trimmed = value.trim().replace(/\.git$/, "");
  return [
    "https://github.com/Kk120306/agent-airlock",
    "git@github.com:Kk120306/agent-airlock",
  ].includes(trimmed)
    ? sourceRepository
    : null;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export function assertRuntimeSourceProvenance(value) {
  if (
    !exactKeys(value, [
      "claim",
      "commitOid",
      "objectFormat",
      "repository",
      "treeOid",
      "worktreeState",
    ]) ||
    value.claim !== sourceClaim ||
    value.repository !== sourceRepository ||
    !["sha1", "sha256"].includes(value.objectFormat) ||
    !gitObjectIdPattern.test(value.commitOid ?? "") ||
    !gitObjectIdPattern.test(value.treeOid ?? "") ||
    value.commitOid.length !== (value.objectFormat === "sha1" ? 40 : 64) ||
    value.treeOid.length !== value.commitOid.length ||
    value.worktreeState !== "clean"
  ) {
    throw new Error("Runtime proof source provenance is invalid");
  }
  return value;
}

export async function inspectRuntimeSourceProvenance({
  root,
  exec,
} = {}) {
  const options = {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  };
  const binaryOptions = { ...options, encoding: "buffer" };
  const [
    { stdout: revision },
    { stdout: treeDigest },
    { stdout: objectFormat },
    { stdout: remote },
    { stdout: status },
  ] =
    await Promise.all([
      runTrustedGit(["rev-parse", "HEAD"], options, exec),
      runTrustedGit(["rev-parse", "HEAD^{tree}"], options, exec),
      runTrustedGit(["rev-parse", "--show-object-format"], options, exec),
      runTrustedGit(["config", "--get", "remote.origin.url"], options, exec),
      runTrustedGit(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        binaryOptions,
        exec,
      ),
    ]);
  if (outputBytes(status).length !== 0) {
    throw new Error("Runtime proof requires a clean source tree");
  }
  await assertGitSourceMatchesHead({
    root,
    objectFormat: objectFormat.trim(),
    exec,
  });
  const [
    { stdout: closingRevision },
    { stdout: closingTreeDigest },
    { stdout: closingObjectFormat },
    { stdout: closingRemote },
    { stdout: closingStatus },
  ] = await Promise.all([
    runTrustedGit(["rev-parse", "HEAD"], options, exec),
    runTrustedGit(["rev-parse", "HEAD^{tree}"], options, exec),
    runTrustedGit(["rev-parse", "--show-object-format"], options, exec),
    runTrustedGit(["config", "--get", "remote.origin.url"], options, exec),
      runTrustedGit(
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      binaryOptions,
      exec,
    ),
  ]);
  await assertGitSourceMatchesHead({
    root,
    objectFormat: closingObjectFormat.trim(),
    exec,
  });
  if (
    revision !== closingRevision ||
    treeDigest !== closingTreeDigest ||
    objectFormat !== closingObjectFormat ||
    remote !== closingRemote ||
    outputBytes(closingStatus).length !== 0
  ) {
    throw new Error("Runtime proof source changed during inspection");
  }
  const repository = normalizedRepository(remote);
  if (repository === null) {
    throw new Error("Runtime proof source repository is not the submission repository");
  }
  return assertRuntimeSourceProvenance({
    claim: sourceClaim,
    repository,
    objectFormat: objectFormat.trim(),
    commitOid: revision.trim(),
    treeOid: treeDigest.trim(),
    worktreeState: "clean",
  });
}

export function inspectRuntimeSourceProvenanceSync({
  root,
  execSync,
} = {}) {
  const run = (argumentsList) =>
    runTrustedGitSync(
      argumentsList,
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      execSync,
    );
  const runBytes = (argumentsList) =>
    runTrustedGitSync(
      argumentsList,
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
      },
      execSync,
    );
  const revision = run(["rev-parse", "HEAD"]);
  const treeDigest = run(["rev-parse", "HEAD^{tree}"]);
  const objectFormat = run(["rev-parse", "--show-object-format"]);
  const remote = run(["config", "--get", "remote.origin.url"]);
  const status = outputBytes(runBytes([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]));
  if (status.length !== 0) {
    throw new Error("Runtime proof requires a clean source tree");
  }
  assertGitSourceMatchesHeadSync({
    root,
    objectFormat: objectFormat.trim(),
    execSync,
  });
  const closingRevision = run(["rev-parse", "HEAD"]);
  const closingTreeDigest = run(["rev-parse", "HEAD^{tree}"]);
  const closingObjectFormat = run(["rev-parse", "--show-object-format"]);
  const closingRemote = run(["config", "--get", "remote.origin.url"]);
  const closingStatus = outputBytes(runBytes([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]));
  assertGitSourceMatchesHeadSync({
    root,
    objectFormat: closingObjectFormat.trim(),
    execSync,
  });
  if (
    revision !== closingRevision ||
    treeDigest !== closingTreeDigest ||
    objectFormat !== closingObjectFormat ||
    remote !== closingRemote ||
    closingStatus.length !== 0
  ) {
    throw new Error("Runtime proof source changed during inspection");
  }
  const repository = normalizedRepository(remote);
  if (repository === null) {
    throw new Error("Runtime proof source repository is not the submission repository");
  }
  return assertRuntimeSourceProvenance({
    claim: sourceClaim,
    repository,
    objectFormat: objectFormat.trim(),
    commitOid: revision.trim(),
    treeOid: treeDigest.trim(),
    worktreeState: "clean",
  });
}

export function assertMatchingRuntimeSourceProvenance(expected, observed) {
  assertRuntimeSourceProvenance(expected);
  assertRuntimeSourceProvenance(observed);
  if (
    JSON.stringify(expected) !== JSON.stringify(observed)
  ) {
    throw new Error("Runtime proof source changed during execution");
  }
  return observed;
}
