#!/usr/bin/env node

import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertMatchingRuntimeSourceProvenance,
  inspectRuntimeSourceProvenance,
} from "./runtime-source-provenance.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const maximumArchiveBytes = 512 * 1024 * 1024;
const maximumTreeBytes = 64 * 1024 * 1024;
const tarBlockBytes = 512;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function outputBytes(result) {
  const output = result?.stdout ?? result;
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === "string") return Buffer.from(output, "utf8");
  throw new Error("Production build context Git output is invalid");
}

function nulRecords(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) {
    throw new Error("Production build context tree is unterminated");
  }
  return records;
}

function decodeUtf8(bytes, description) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`Production build context ${description} is not UTF-8`);
  }
}

function safeRepositoryPath(value, { directory = false } = {}) {
  const normalized =
    directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    normalized.length === 0 ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Production build context contains an unsafe path");
  }
  return normalized;
}

function expectedArchiveTree(source, result) {
  const objectIdLength = source.objectFormat === "sha1" ? 40 : 64;
  const entries = new Map();
  const directories = new Set();
  for (const record of nulRecords(outputBytes(result))) {
    const separator = record.indexOf(0x09);
    if (separator < 1) {
      throw new Error("Production build context HEAD tree is malformed");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = header.match(/^(100644|100755|120000) blob ([a-f0-9]+)$/u);
    if (!match || match[2].length !== objectIdLength) {
      throw new Error(
        "Production build context requires regular tracked blobs",
      );
    }
    const repositoryPath = safeRepositoryPath(
      decodeUtf8(record.subarray(separator + 1), "tree path"),
    );
    if (entries.has(repositoryPath)) {
      throw new Error(
        "Production build context tree contains a duplicate path",
      );
    }
    entries.set(repositoryPath, {
      archiveMode:
        match[1] === "100644" ? 0o664 : match[1] === "100755" ? 0o775 : 0o777,
      kind: match[1] === "120000" ? "symlink" : "file",
      objectId: match[2],
    });
    const segments = repositoryPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  if (entries.size === 0) {
    throw new Error("Production build context HEAD tree is empty");
  }
  return { directories, entries };
}

function nulTerminatedBytes(bytes) {
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.subarray(0, nul);
}

function tarText(bytes, description) {
  return decodeUtf8(nulTerminatedBytes(bytes), description);
}

function tarNumber(bytes, description) {
  if ((bytes[0] & 0x80) !== 0) {
    throw new Error(`Production build context ${description} is not octal`);
  }
  const value = nulTerminatedBytes(bytes).toString("ascii").trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Production build context ${description} is malformed`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Production build context ${description} is out of range`);
  }
  return parsed;
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function parsePaxAttributes(payload) {
  const attributes = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const separator = payload.indexOf(0x20, offset);
    if (separator <= offset) {
      throw new Error("Production build context PAX record is malformed");
    }
    const lengthText = payload.subarray(offset, separator).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new Error("Production build context PAX length is malformed");
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > payload.length ||
      payload[end - 1] !== 0x0a
    ) {
      throw new Error("Production build context PAX record is truncated");
    }
    const record = payload.subarray(separator + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) {
      throw new Error("Production build context PAX attribute is malformed");
    }
    const key = record.subarray(0, equals).toString("ascii");
    if (!/^[A-Za-z0-9_.-]+$/u.test(key) || attributes.has(key)) {
      throw new Error("Production build context PAX attribute is invalid");
    }
    attributes.set(
      key,
      decodeUtf8(record.subarray(equals + 1), "PAX attribute"),
    );
    offset = end;
  }
  return attributes;
}

function exactAttributeKeys(attributes, expected) {
  return (
    JSON.stringify([...attributes.keys()].sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function blobObjectId(bytes, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function allZero(bytes) {
  return bytes.every((byte) => byte === 0);
}

export function assertExactProductionBuildContextArchive({
  archiveBytes,
  source,
  tree,
} = {}) {
  if (
    !Buffer.isBuffer(archiveBytes) ||
    archiveBytes.length < tarBlockBytes * 2 ||
    archiveBytes.length % tarBlockBytes !== 0 ||
    archiveBytes.length > maximumArchiveBytes ||
    !tree?.entries ||
    !tree?.directories
  ) {
    throw new Error("Production build context archive is malformed");
  }
  const observedEntries = new Set();
  const observedDirectories = new Set();
  let globalAttributes = null;
  let nextAttributes = null;
  let offset = 0;
  let reachedEnd = false;
  while (offset < archiveBytes.length) {
    const header = archiveBytes.subarray(offset, offset + tarBlockBytes);
    if (allZero(header)) {
      const second = archiveBytes.subarray(
        offset + tarBlockBytes,
        offset + tarBlockBytes * 2,
      );
      if (
        second.length !== tarBlockBytes ||
        !allZero(second) ||
        !allZero(archiveBytes.subarray(offset + tarBlockBytes * 2))
      ) {
        throw new Error(
          "Production build context archive terminator is invalid",
        );
      }
      reachedEnd = true;
      break;
    }
    if (
      tarText(header.subarray(257, 263), "tar magic") !== "ustar" ||
      tarNumber(header.subarray(148, 156), "tar checksum") !==
        tarChecksum(header)
    ) {
      throw new Error("Production build context tar header is invalid");
    }
    const size = tarNumber(header.subarray(124, 136), "tar size");
    const contentStart = offset + tarBlockBytes;
    const contentEnd = contentStart + size;
    const paddedEnd =
      contentStart + Math.ceil(size / tarBlockBytes) * tarBlockBytes;
    if (contentEnd > archiveBytes.length || paddedEnd > archiveBytes.length) {
      throw new Error("Production build context tar entry is truncated");
    }
    const content = archiveBytes.subarray(contentStart, contentEnd);
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (type === "g" || type === "x") {
      const attributes = parsePaxAttributes(content);
      if (type === "g") {
        if (
          globalAttributes !== null ||
          nextAttributes !== null ||
          !exactAttributeKeys(attributes, ["comment"]) ||
          attributes.get("comment") !== source.commitOid
        ) {
          throw new Error(
            "Production build context global PAX record is invalid",
          );
        }
        globalAttributes = attributes;
      } else {
        if (
          nextAttributes !== null ||
          !["path", "linkpath"].every(
            (key) =>
              !attributes.has(key) || typeof attributes.get(key) === "string",
          ) ||
          [...attributes.keys()].some(
            (key) => key !== "path" && key !== "linkpath",
          )
        ) {
          throw new Error(
            "Production build context extended PAX record is invalid",
          );
        }
        nextAttributes = attributes;
      }
      offset = paddedEnd;
      continue;
    }
    const headerName = tarText(header.subarray(0, 100), "tar path");
    const prefix = tarText(header.subarray(345, 500), "tar prefix");
    const joinedName =
      prefix.length > 0 ? `${prefix}/${headerName}` : headerName;
    const entryName = nextAttributes?.get("path") ?? joinedName;
    const directory = type === "5";
    const repositoryPath = safeRepositoryPath(entryName, { directory });
    const mode = tarNumber(header.subarray(100, 108), "tar mode");
    if (directory) {
      if (
        size !== 0 ||
        mode !== 0o775 ||
        nextAttributes?.has("linkpath") ||
        !tree.directories.has(repositoryPath) ||
        observedDirectories.has(repositoryPath)
      ) {
        throw new Error("Production build context directory entry is invalid");
      }
      observedDirectories.add(repositoryPath);
    } else {
      const expected = tree.entries.get(repositoryPath);
      if (
        !expected ||
        observedEntries.has(repositoryPath) ||
        mode !== expected.archiveMode
      ) {
        throw new Error("Production build context file entry is invalid");
      }
      if (expected.kind === "file") {
        if (
          type !== "0" ||
          nextAttributes?.has("linkpath") ||
          blobObjectId(content, source.objectFormat) !== expected.objectId
        ) {
          throw new Error(
            "Production build context file bytes do not match HEAD",
          );
        }
      } else {
        const headerLink = nulTerminatedBytes(header.subarray(157, 257));
        const linkBytes = nextAttributes?.has("linkpath")
          ? Buffer.from(nextAttributes.get("linkpath"), "utf8")
          : headerLink;
        if (
          type !== "2" ||
          size !== 0 ||
          blobObjectId(linkBytes, source.objectFormat) !== expected.objectId
        ) {
          throw new Error(
            "Production build context symlink does not match HEAD",
          );
        }
      }
      observedEntries.add(repositoryPath);
    }
    nextAttributes = null;
    offset = paddedEnd;
  }
  if (
    !reachedEnd ||
    globalAttributes === null ||
    nextAttributes !== null ||
    observedEntries.size !== tree.entries.size ||
    observedDirectories.size !== tree.directories.size
  ) {
    throw new Error(
      "Production build context archive does not match the HEAD tree",
    );
  }
  return {
    directoryCount: observedDirectories.size,
    fileCount: observedEntries.size,
  };
}

function sameFile(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function requireAbsent(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Production build context output already exists");
}

export async function materializeProductionBuildContext({
  archivePath,
  exec,
  inspectSource = inspectRuntimeSourceProvenance,
  projectRoot,
} = {}) {
  if (
    typeof projectRoot !== "string" ||
    typeof archivePath !== "string" ||
    !path.isAbsolute(projectRoot) ||
    !path.isAbsolute(archivePath) ||
    archivePath === path.parse(archivePath).root
  ) {
    throw new Error("Production build context paths must be absolute");
  }
  const parent = path.dirname(archivePath);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Production build context output parent is unsafe");
  }
  const physicalParent = await realpath(parent);
  await requireAbsent(archivePath);

  const openingSource = await inspectSource({ root: projectRoot, exec });
  const treeResult = await runTrustedGit(
    ["ls-tree", "-r", "-z", "--full-tree", openingSource.commitOid],
    {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer: maximumTreeBytes,
    },
    exec,
  );
  const tree = expectedArchiveTree(openingSource, treeResult);
  await runTrustedGit(
    [
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      openingSource.commitOid,
    ],
    { cwd: projectRoot, encoding: "buffer", maxBuffer: 1024 * 1024 },
    exec,
  );
  await chmod(archivePath, 0o600);
  const before = await lstat(archivePath);
  const physicalArchive = await realpath(archivePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < tarBlockBytes * 2 ||
    before.size > maximumArchiveBytes ||
    path.dirname(physicalArchive) !== physicalParent
  ) {
    throw new Error("Production build context archive output is unsafe");
  }
  const archiveBytes = await readFile(archivePath);
  const afterRead = await lstat(archivePath);
  if (!sameFile(before, afterRead)) {
    throw new Error("Production build context archive changed while reading");
  }
  assertExactProductionBuildContextArchive({
    archiveBytes,
    source: openingSource,
    tree,
  });
  const handle = await open(archivePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const closingSource = await inspectSource({ root: projectRoot, exec });
  assertMatchingRuntimeSourceProvenance(openingSource, closingSource);
  const closingArchive = await lstat(archivePath);
  if (!sameFile(afterRead, closingArchive)) {
    throw new Error(
      "Production build context archive changed after validation",
    );
  }
  return {
    archiveBytes: closingArchive.size,
    archiveSha256:
      "sha256:" + createHash("sha256").update(archiveBytes).digest("hex"),
    commitOid: openingSource.commitOid,
    fileCount: tree.entries.size,
    treeOid: openingSource.treeOid,
  };
}

export async function streamProductionBuildContext({
  archivePath,
  expectedSha256,
  output = process.stdout,
} = {}) {
  if (
    typeof archivePath !== "string" ||
    !path.isAbsolute(archivePath) ||
    !/^sha256:[a-f0-9]{64}$/u.test(expectedSha256 ?? "") ||
    typeof output?.write !== "function"
  ) {
    throw new Error("Production build context stream arguments are invalid");
  }
  const pathMetadata = await lstat(archivePath);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size < tarBlockBytes * 2 ||
    pathMetadata.size > maximumArchiveBytes
  ) {
    throw new Error("Production build context stream source is unsafe");
  }
  const handle = await open(archivePath, "r");
  const hash = createHash("sha256");
  let position = 0;
  try {
    const opened = await handle.stat();
    if (!sameFile(pathMetadata, opened)) {
      throw new Error("Production build context changed before streaming");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (position < opened.size) {
      const length = Math.min(buffer.length, opened.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) {
        throw new Error("Production build context ended while streaming");
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, "drain");
      position += bytesRead;
    }
    const closed = await handle.stat();
    if (
      position !== opened.size ||
      !sameFile(opened, closed) ||
      `sha256:${hash.digest("hex")}` !== expectedSha256
    ) {
      throw new Error("Production build context changed while streaming");
    }
  } finally {
    await handle.close();
  }
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || options.has(name)) {
      throw new Error("Production build context arguments are malformed");
    }
    options.set(name, value);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.has("--stream")) {
    if (options.size !== 2 || !options.has("--sha256")) {
      throw new Error(
        "Production build context stream arguments are incomplete",
      );
    }
    await streamProductionBuildContext({
      archivePath: path.resolve(options.get("--stream")),
      expectedSha256: options.get("--sha256"),
    });
    return;
  }
  if (
    options.size !== 2 ||
    !options.has("--root") ||
    !options.has("--output")
  ) {
    throw new Error("Production build context arguments are incomplete");
  }
  const result = await materializeProductionBuildContext({
    archivePath: path.resolve(options.get("--output")),
    projectRoot: path.resolve(options.get("--root")),
  });
  process.stdout.write(
    `${result.commitOid}:${result.treeOid}:${result.archiveSha256}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
