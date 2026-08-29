#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import {
  assertSafeRuntimeProofResult,
  resolveRuntimeProofArtifactPaths,
} from "./runtime-proof-runner.mjs";
import { assertRuntimeProofCapsuleChainBinding } from "./runtime-proof-capsule-binding.mjs";
import { verifyRecordedLiveModelArkEvidence } from "./modelark-recorded-evidence.mjs";
import { approvedModelArkBoundaryDocuments } from "./modelark-claim-policy.mjs";
import { inspectCommittedSubmissionArtifacts } from "./submission-artifact-binding.mjs";
import { assertGitSourceMatchesHead } from "./runtime-source-provenance.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const execFile = promisify(execFileCallback);
const reportSchema = "agent-airlock/submission-readiness-report";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedRepositoryUrl = "https://github.com/Kk120306/agent-airlock";
const canonicalArchitectureSource =
  "docs/demo/agent-airlock-one-page.mmd";
const canonicalArchitectureImage =
  "docs/demo/agent-airlock-one-page.png";
const canonicalArchitectureWidth = 1904;
const canonicalArchitectureHeight = 858;
const approvedArchitectureRender = Object.freeze({
  sourceDigest:
    "sha256:fbabea34da31ad942ef3af11d3301e35bc0d0ae6be4649294ed2305c21e3623c",
  imageDigest:
    "sha256:c5c42260c84a2d975e97d870575e031a588b9586c3df384720bb25e1fc90f384",
});
const exactPublicRepositoryLine =
  "- Public code repository: [github.com/Kk120306/agent-airlock](https://github.com/Kk120306/agent-airlock)";
const gitObjectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const requiredArchitectureMarkers = [
  "TRACK 1",
  "AgentRunner seam",
  "Run-owned Candidate",
  "OUTCOME CONTRACT",
  "Quarantine",
  "Bounded Repair child",
  "optional ModelArk",
  "evidence only, never Promotion authority",
];
function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function check(id, label, scope, status, detail) {
  return { id, label, scope, status, detail };
}

function digestReport(report) {
  return sha256(
    JSON.stringify({
      schema: report.schema,
      schemaVersion: report.schemaVersion,
      networkRequests: report.networkRequests,
      sourceRevision: report.sourceRevision,
      checks: report.checks,
    }),
  );
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

export async function assertTrustedToolFile(
  file,
  label,
  {
    optional = false,
    containedBy = null,
    allowSystemSymlink = false,
    systemRoots = ["/bin", "/usr/bin"],
  } = {},
) {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return false;
    throw new Error(`${label} is unavailable for release verification`);
  }
  if (!stats.isFile() && !(allowSystemSymlink && stats.isSymbolicLink())) {
    throw new Error(`${label} is not a trusted regular file`);
  }

  const resolvedFile = await realpath(file);
  const resolvedStats = await lstat(resolvedFile);
  if (!resolvedStats.isFile() || resolvedStats.isSymbolicLink()) {
    throw new Error(`${label} is not a trusted regular file`);
  }
  if (stats.isSymbolicLink()) {
    const resolvedSystemRoots = await Promise.all(
      systemRoots.map((systemRoot) => realpath(systemRoot)),
    );
    const insideSystemRoot = resolvedSystemRoots.some((systemRoot) => {
      const relative = path.relative(systemRoot, resolvedFile);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
      );
    });
    if (!insideSystemRoot) {
      throw new Error(`${label} escaped the trusted system directories`);
    }
  }
  if (containedBy !== null) {
    const resolvedContainmentRoot = await realpath(containedBy);
    const relative = path.relative(resolvedContainmentRoot, resolvedFile);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`${label} escaped the clean verification source`);
    }
  }
  return resolvedFile;
}

function safeRelativeFile(root, value) {
  if (typeof value !== "string" || value.length < 1) return null;
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (
    relative !== value.split("/").join(path.sep) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return resolved;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 57 ||
    !bytes.subarray(0, signature.length).equals(signature)
  ) {
    throw new Error("Architecture export is not a canonical PNG");
  }

  let offset = signature.length;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  let sawImageData = false;
  let imageDataClosed = false;
  let sawEnd = false;
  const imageDataChunks = [];
  let chunkIndex = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("Architecture export contains a truncated PNG chunk");
    }
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      throw new Error("Architecture export contains a truncated PNG payload");
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length);
    const recordedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (pngCrc32(crcInput) !== recordedCrc) {
      throw new Error("Architecture export contains an invalid PNG checksum");
    }
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("Architecture export does not begin with PNG IHDR");
      }
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const compression = bytes[offset + 18];
      const filter = bytes[offset + 19];
      interlace = bytes[offset + 20];
      if (
        width < 1 ||
        height < 1 ||
        bitDepth !== 8 ||
        colorType !== 2 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("Architecture export has an invalid PNG header");
      }
    } else if (type === "IHDR") {
      throw new Error("Architecture export contains duplicate PNG IHDR");
    }
    if (type === "IDAT") {
      if (imageDataClosed) {
        throw new Error("Architecture export contains non-contiguous PNG image data");
      }
      sawImageData = true;
      imageDataChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (sawImageData && type !== "IEND") {
      imageDataClosed = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) {
        throw new Error("Architecture export has an invalid PNG terminator");
      }
      sawEnd = true;
    }
    if (sawEnd && chunkEnd !== bytes.length) {
      throw new Error("Architecture export contains data after PNG IEND");
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!sawEnd || width === null || height === null) {
    throw new Error("Architecture export is missing required PNG chunks");
  }
  const bytesPerPixel = 3;
  const rowBytes = width * bytesPerPixel;
  const expectedInflatedBytes = (rowBytes + 1) * height;
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(imageDataChunks), {
      maxOutputLength: expectedInflatedBytes,
    });
  } catch {
    throw new Error("Architecture export contains invalid PNG image data");
  }
  if (pixels.length !== expectedInflatedBytes) {
    throw new Error("Architecture export contains incomplete PNG image data");
  }
  const decoded = Buffer.alloc(rowBytes * height);
  const paeth = (left, up, upperLeft) => {
    const estimate = left + up - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
      return left;
    }
    return upDistance <= upperLeftDistance ? up : upperLeft;
  };
  for (let row = 0; row < height; row += 1) {
    const encodedRow = row * (rowBytes + 1);
    const decodedRow = row * rowBytes;
    const filterType = pixels[encodedRow];
    if (filterType > 4) {
      throw new Error("Architecture export contains an invalid PNG scanline filter");
    }
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = pixels[encodedRow + 1 + column];
      const left =
        column >= bytesPerPixel
          ? decoded[decodedRow + column - bytesPerPixel]
          : 0;
      const up = row > 0 ? decoded[decodedRow - rowBytes + column] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? decoded[decodedRow - rowBytes + column - bytesPerPixel]
          : 0;
      const predictor = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upperLeft),
      ][filterType];
      decoded[decodedRow + column] = (raw + predictor) & 0xff;
    }
  }
  const colors = new Set();
  for (let offset = 0; offset < decoded.length && colors.size < 16; offset += 3) {
    colors.add(
      (decoded[offset] << 16) |
        (decoded[offset + 1] << 8) |
        decoded[offset + 2],
    );
  }
  if (colors.size < 16) {
    throw new Error("Architecture export does not contain visible diagram detail");
  }
  return { width, height };
}

function configuredValue(environment, name) {
  const value = environment[name]?.trim();
  return Boolean(
    value &&
      !/^replace-/i.test(value) &&
      !/^your-/i.test(value) &&
      !/^\*+$/.test(value),
  );
}

function modelArkConfigurationReady(environment) {
  if (
    !configuredValue(environment, "ARK_API_KEY") ||
    !configuredValue(environment, "ARK_MODEL")
  ) {
    return false;
  }
  const rawBaseUrl =
    environment.ARK_BASE_URL?.trim() ||
    "https://ark.ap-southeast.bytepluses.com/api/v3";
  try {
    const url = new URL(rawBaseUrl);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "::1", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function extractYouTubeUrl(content) {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.includes("Public three-minute demo video:"));
  if (!line) return null;
  const match = line.match(/https:\/\/[^\s)`>]+/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const valid =
      (host === "youtube.com" &&
        ((url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
          url.pathname.startsWith("/shorts/"))) ||
      (host === "youtu.be" && url.pathname.length > 1);
    return valid ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeGitHubRemote(value) {
  const trimmed = value.trim().replace(/\.git$/, "");
  if (trimmed === expectedRepositoryUrl) return expectedRepositoryUrl;
  if (trimmed === "git@github.com:Kk120306/agent-airlock") {
    return expectedRepositoryUrl;
  }
  return null;
}

export async function inspectGit(root, execute) {
  const options = { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 };
  const { stdout: revision } = await runTrustedGit(
    ["rev-parse", "HEAD"],
    options,
    execute,
  );
  const { stdout: treeDigest } = await runTrustedGit(
    ["rev-parse", "HEAD^{tree}"],
    options,
    execute,
  );
  const { stdout: objectFormat } = await runTrustedGit(
    ["rev-parse", "--show-object-format"],
    options,
    execute,
  );
  const { stdout: status } = await runTrustedGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { ...options, encoding: "buffer" },
    execute,
  );
  await assertGitSourceMatchesHead({
    root,
    objectFormat: objectFormat.trim(),
    exec: execute,
  });
  const { stdout: remote } = await runTrustedGit(
    ["config", "--get", "remote.origin.url"],
    options,
    execute,
  );
  const originMainResult = await runTrustedGit(
    ["rev-parse", "refs/remotes/origin/main"],
    options,
    execute,
  ).catch(() => null);
  const { stdout: closingRevision } = await runTrustedGit(
    ["rev-parse", "HEAD"],
    options,
    execute,
  );
  const { stdout: closingTreeDigest } = await runTrustedGit(
    ["rev-parse", "HEAD^{tree}"],
    options,
    execute,
  );
  const { stdout: closingStatus } = await runTrustedGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { ...options, encoding: "buffer" },
    execute,
  );
  await assertGitSourceMatchesHead({
    root,
    objectFormat: objectFormat.trim(),
    exec: execute,
  });
  if (
    revision.trim() !== closingRevision.trim() ||
    treeDigest.trim() !== closingTreeDigest.trim() ||
    !status.equals(closingStatus)
  ) {
    throw new Error("Git state changed during source inspection");
  }
  const normalizedRevision = revision.trim();
  const originMainRevision = originMainResult?.stdout?.trim() ?? null;
  return {
    revision: normalizedRevision,
    treeDigest: treeDigest.trim(),
    objectFormat: objectFormat.trim(),
    clean: status.length === 0,
    repositoryMatches: normalizeGitHubRemote(remote) !== null,
    originMainRevision,
    originMainMatches: originMainRevision === normalizedRevision,
  };
}

export async function inspectArchitecture(root, read = readFile) {
  const manifestPath = path.join(root, "docs/demo/submission-assets.json");
  const manifestSource = await read(manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource);
  if (
    !exactKeys(manifest, ["architecture", "schema", "schemaVersion"]) ||
    manifest.schema !== "agent-airlock/submission-assets" ||
    manifest.schemaVersion !== 1 ||
    !exactKeys(manifest.architecture, ["image", "source"]) ||
    !exactKeys(manifest.architecture.source, ["bytes", "file", "sha256"]) ||
    !exactKeys(manifest.architecture.image, [
      "bytes",
      "file",
      "height",
      "sha256",
      "width",
    ])
  ) {
    throw new Error("Submission asset manifest is malformed");
  }
  const sourcePath = safeRelativeFile(root, manifest.architecture.source.file);
  const imagePath = safeRelativeFile(root, manifest.architecture.image.file);
  if (
    !sourcePath ||
    !imagePath ||
    manifest.architecture.source.file !== canonicalArchitectureSource ||
    manifest.architecture.image.file !== canonicalArchitectureImage ||
    manifest.architecture.image.width !== canonicalArchitectureWidth ||
    manifest.architecture.image.height !== canonicalArchitectureHeight
  ) {
    throw new Error("Submission asset manifest contains an unsafe path");
  }
  const [sourceBytes, imageBytes, architectureNotes] = await Promise.all([
    read(sourcePath),
    read(imagePath),
    read(path.join(root, "docs/demo/architecture-one-page.md"), "utf8"),
  ]);
  const dimensions = pngDimensions(imageBytes);
  const source = sourceBytes.toString("utf8");
  const sourceDigest = sha256(sourceBytes);
  const imageDigest = sha256(imageBytes);
  const valid =
    sourceBytes.length === manifest.architecture.source.bytes &&
    imageBytes.length === manifest.architecture.image.bytes &&
    sourceDigest === manifest.architecture.source.sha256 &&
    imageDigest === manifest.architecture.image.sha256 &&
    sourceDigest === approvedArchitectureRender.sourceDigest &&
    imageDigest === approvedArchitectureRender.imageDigest &&
    dimensions.width === manifest.architecture.image.width &&
    dimensions.height === manifest.architecture.image.height &&
    requiredArchitectureMarkers.every((marker) => source.includes(marker)) &&
    architectureNotes.includes("agent-airlock-one-page.png") &&
    architectureNotes.includes("agent-airlock-one-page.mmd");
  return {
    valid,
    width: dimensions.width,
    height: dimensions.height,
    sourceDigest,
    imageDigest,
    manifestDigest: sha256(Buffer.from(manifestSource, "utf8")),
  };
}

export async function inspectLocalVerification(root, execute = execFile) {
  const resolvedRoot = path.resolve(root);
  const projectNpmConfigPaths = [
    ".npmrc",
    "apps/server/.npmrc",
    "apps/web/.npmrc",
    "packages/http-object-resource/.npmrc",
    "packages/portable-promotion-receipt/.npmrc",
    "packages/transactional-resource-sdk/.npmrc",
  ];
  const assertNoProjectNpmConfig = async (candidateRoot) => {
    for (const relativePath of projectNpmConfigPaths) {
      try {
        await lstat(path.join(candidateRoot, relativePath));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(
        `Project npm configuration is forbidden during release verification: ${relativePath}`,
      );
    }
  };
  const inspectExactSource = async () => {
    const textOptions = {
      cwd: resolvedRoot,
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
    const objectFormat = formatResult.stdout.trim();
    const revision = revisionResult.stdout.trim();
    const treeDigest = treeResult.stdout.trim();
    if (
      !["sha1", "sha256"].includes(objectFormat) ||
      !gitObjectIdPattern.test(revision) ||
      !gitObjectIdPattern.test(treeDigest) ||
      revision.length !== (objectFormat === "sha1" ? 40 : 64) ||
      treeDigest.length !== revision.length ||
      statusResult.stdout.length !== 0
    ) {
      throw new Error(
        "Release verification requires exact clean committed source",
      );
    }
    await assertGitSourceMatchesHead({
      root: resolvedRoot,
      objectFormat,
    });
    return { revision, treeDigest, objectFormat };
  };
  await assertNoProjectNpmConfig(resolvedRoot);
  const sourceSnapshot = await inspectExactSource();
  const npmCli = path.resolve(
    path.dirname(process.execPath),
    "../lib/node_modules/npm/bin/npm-cli.js",
  );
  const configRoot = await mkdtemp(
    path.join(os.tmpdir(), "agent-airlock-release-audit-"),
  );
  const userConfig = path.join(configRoot, "user.npmrc");
  const globalConfig = path.join(configRoot, "global.npmrc");
  const trustedBin = path.join(configRoot, "trusted-bin");
  const scriptShell = path.join(configRoot, "trusted-script-shell");
  const verificationRoot = path.join(configRoot, "source");
  const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const writeExecutable = (file, source) =>
    writeFile(file, source, { flag: "wx", mode: 0o700 });
  try {
    const trustedPath = [trustedBin, "/usr/bin", "/bin"].join(
      path.delimiter,
    );
    const [, , bashExecutable, posixShellExecutable] = await Promise.all([
      assertTrustedToolFile(process.execPath, "Node.js executable"),
      assertTrustedToolFile(npmCli, "npm CLI"),
      assertTrustedToolFile("/bin/bash", "Bash executable", {
        allowSystemSymlink: true,
      }),
      assertTrustedToolFile("/bin/sh", "POSIX shell executable", {
        allowSystemSymlink: true,
      }),
      mkdir(trustedBin, { mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(userConfig, "", { flag: "wx", mode: 0o600 }),
      writeFile(globalConfig, "", { flag: "wx", mode: 0o600 }),
      writeExecutable(
        path.join(trustedBin, "node"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
      ),
      writeExecutable(
        path.join(trustedBin, "npm"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(npmCli)} "$@"\n`,
      ),
      writeExecutable(
        path.join(trustedBin, "bash"),
        `#!${posixShellExecutable}\nexec ${shellQuote(bashExecutable)} "$@"\n`,
      ),
      writeExecutable(
        scriptShell,
        `#!${posixShellExecutable}\nPATH=${shellQuote(trustedPath)}\nexport PATH\nexec ${shellQuote(posixShellExecutable)} "$@"\n`,
      ),
    ]);
    const sharedEnvironment = {
      CI: "1",
      PATH: trustedPath,
      npm_config_audit: "false",
      npm_config_cache: path.join(os.homedir(), ".npm"),
      npm_config_fund: "false",
      npm_config_globalconfig: globalConfig,
      npm_config_node_options: "--no-warnings",
      npm_config_offline: "true",
      npm_config_script_shell: scriptShell,
      npm_config_update_notifier: "false",
      npm_config_userconfig: userConfig,
    };
    await runTrustedGit(
      [
        "clone",
        "--local",
        "--no-hardlinks",
        "--no-checkout",
        "--no-tags",
        "--",
        resolvedRoot,
        verificationRoot,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    await runTrustedGit(
      ["checkout", "--detach", sourceSnapshot.revision],
      {
        cwd: verificationRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const [cloneRevisionResult, cloneTreeResult, cloneStatusResult] = await Promise.all([
      runTrustedGit(["rev-parse", "HEAD"], {
        cwd: verificationRoot,
        encoding: "utf8",
      }),
      runTrustedGit(["rev-parse", "HEAD^{tree}"], {
        cwd: verificationRoot,
        encoding: "utf8",
      }),
      runTrustedGit(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        {
          cwd: verificationRoot,
          encoding: "buffer",
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    ]);
    if (
      cloneRevisionResult.stdout.trim() !== sourceSnapshot.revision ||
      cloneTreeResult.stdout.trim() !== sourceSnapshot.treeDigest ||
      cloneStatusResult.stdout.length !== 0
    ) {
      throw new Error("Clean verification source does not match exact HEAD");
    }
    await assertGitSourceMatchesHead({
      root: verificationRoot,
      objectFormat: sourceSnapshot.objectFormat,
    });
    await assertNoProjectNpmConfig(verificationRoot);
    await execute(
      process.execPath,
      [npmCli, "ci", "--ignore-scripts", "--offline"],
      {
        cwd: verificationRoot,
        encoding: "utf8",
        env: {
          ...sharedEnvironment,
          npm_config_ignore_scripts: "true",
        },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
      },
    );
    await Promise.all([
      assertNoProjectNpmConfig(resolvedRoot),
      assertNoProjectNpmConfig(verificationRoot),
    ]);
    const dependencyTools = [
      ["tsc", path.join(verificationRoot, "node_modules/typescript/bin/tsc")],
      ["vitest", path.join(verificationRoot, "node_modules/vitest/vitest.mjs")],
      ["vite", path.join(verificationRoot, "node_modules/vite/bin/vite.js")],
    ];
    for (const [name, target] of dependencyTools) {
      const resolvedTarget = await assertTrustedToolFile(
        target,
        `${name} executable`,
        { optional: true, containedBy: verificationRoot },
      );
      if (!resolvedTarget) continue;
      await writeExecutable(
        path.join(trustedBin, name),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolvedTarget)} "$@"\n`,
      );
    }
    const options = {
      cwd: verificationRoot,
      encoding: "utf8",
      env: {
        ...sharedEnvironment,
        npm_config_ignore_scripts: "false",
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    };
    await execute(process.execPath, [npmCli, "run", "check"], options);
    await Promise.all([
      assertNoProjectNpmConfig(resolvedRoot),
      assertNoProjectNpmConfig(verificationRoot),
    ]);
    await execute(
      process.execPath,
      [path.join(resolvedRoot, "scripts/release-audit.mjs")],
      { ...options, cwd: resolvedRoot },
    );
    await assertNoProjectNpmConfig(resolvedRoot);
    const closingSnapshot = await inspectExactSource();
    if (
      closingSnapshot.revision !== sourceSnapshot.revision ||
      closingSnapshot.treeDigest !== sourceSnapshot.treeDigest ||
      closingSnapshot.objectFormat !== sourceSnapshot.objectFormat
    ) {
      throw new Error("Release verification source changed while checks ran");
    }
    return {
      valid: true,
      revision: sourceSnapshot.revision,
      treeDigest: sourceSnapshot.treeDigest,
      dependencyInstall: "clean-exact-head-offline-npm-ci",
    };
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
}

async function inspectRuntimeProof(root, read = readFile) {
  const artifactRoot = path.join(root, ".local", "airlock-runtime-proof");
  const { resultPath, chainPath } = await resolveRuntimeProofArtifactPaths({
    artifactRoot,
  });
  const [resultSource, chainSource] = await Promise.all([
    read(resultPath, "utf8"),
    read(chainPath, "utf8"),
  ]);
  const result = JSON.parse(resultSource);
  assertSafeRuntimeProofResult(result);
  if (sha256(Buffer.from(chainSource, "utf8")) !== result.chainDigest) {
    throw new Error("Runtime proof chain digest does not match its capsule");
  }
  const { verifyPortableDecisionChainJson } = await import(
    "@agent-airlock/portable-promotion-receipt"
  );
  const verification = verifyPortableDecisionChainJson(chainSource);
  if (
    verification?.valid !== true ||
    verification?.leafReceiptDigest !== result.leafReceiptDigest ||
    !Array.isArray(verification?.packets) ||
    verification.packets.length !== 2 ||
    !["chain-links", "chain-state-continuity"].every((name) =>
      verification.checks?.some(
        (candidate) => candidate?.name === name && candidate?.valid === true,
      ),
    )
  ) {
    throw new Error("Runtime proof chain failed independent verification");
  }
  const binding = assertRuntimeProofCapsuleChainBinding({
    result,
    chainDocument: JSON.parse(chainSource),
  });
  return {
    valid: true,
    schemaVersion: result.schemaVersion,
    source: result.source ?? null,
    capsuleDigest: sha256(Buffer.from(resultSource, "utf8")),
    chainDigest: result.chainDigest,
    leafReceiptDigest: result.leafReceiptDigest,
    ...binding,
  };
}

async function inspectModelArkEvidence(root, environment) {
  const stateRoot = path.resolve(
    environment.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
      path.join(root, ".local", "airlock-modelark-demo"),
  );
  const verification = await verifyRecordedLiveModelArkEvidence({ stateRoot });
  return { valid: verification.valid === true };
}

function completeReport(sourceRevision, checks) {
  const coreChecks = checks.filter((item) => item.scope === "core");
  const submissionChecks = checks.filter((item) => item.scope === "submission");
  const localIntegrityReady = checks.every((item) => item.status !== "fail");
  const coreDemoReady = coreChecks.every((item) => item.status === "pass");
  const submissionReady =
    coreDemoReady &&
    submissionChecks.every((item) =>
      ["pass", "owner-confirmed"].includes(item.status),
    );
  const report = {
    schema: reportSchema,
    schemaVersion: 1,
    networkRequests: 0,
    sourceRevision,
    localIntegrityReady,
    coreDemoReady,
    submissionReady,
    checks,
  };
  return { ...report, evidenceDigest: digestReport(report) };
}

function sameGitSnapshot(left, right) {
  return [
    "revision",
    "treeDigest",
    "objectFormat",
    "clean",
    "repositoryMatches",
    "originMainRevision",
    "originMainMatches",
  ].every((field) => left?.[field] === right?.[field]);
}

function runtimeProofMatchesGit(runtimeProof, git) {
  return (
    runtimeProof?.valid === true &&
    runtimeProof.schemaVersion === 2 &&
    runtimeProof.source?.commitOid === git.revision &&
    runtimeProof.source?.treeOid === git.treeDigest &&
    runtimeProof.source?.objectFormat === git.objectFormat &&
    runtimeProof.source?.repository === "github:Kk120306/agent-airlock" &&
    runtimeProof.source?.worktreeState === "clean" &&
    git.clean &&
    git.repositoryMatches
  );
}

function runtimeProofHasExpectedChainBoundary(runtimeProof) {
  return (
    JSON.stringify(runtimeProof?.chainBackedRuns) ===
      JSON.stringify(["quarantine", "repair"]) &&
    runtimeProof?.promotionClaim === "runner-observed-capsule-not-signed"
  );
}

function runtimeProofFingerprint(runtimeProof) {
  if (runtimeProof === null) return null;
  return sha256(
    Buffer.from(
      JSON.stringify({
        valid: runtimeProof.valid,
        schemaVersion: runtimeProof.schemaVersion,
        source: runtimeProof.source,
        capsuleDigest: runtimeProof.capsuleDigest ?? null,
        chainDigest: runtimeProof.chainDigest ?? null,
        leafReceiptDigest: runtimeProof.leafReceiptDigest ?? null,
        chainBackedRuns: runtimeProof.chainBackedRuns,
        promotionClaim: runtimeProof.promotionClaim,
      }),
    ),
  );
}

function artifactDigest(inspection, artifactPath) {
  return inspection?.artifacts?.find(
    (artifact) => artifact.path === artifactPath,
  )?.sha256 ?? null;
}

function artifactSnapshotsMatch(left, right) {
  return (
    typeof left?.artifactSetDigest === "string" &&
    left.artifactSetDigest === right?.artifactSetDigest &&
    left.revision === right?.revision
  );
}

export async function inspectSubmissionReadiness({
  root = projectRoot,
  environment = process.env,
  confirmPublicRevision = null,
  confirmVideoPublic = false,
  gitInspector = inspectGit,
  architectureInspector = inspectArchitecture,
  runtimeProofInspector = inspectRuntimeProof,
  modelArkEvidenceInspector = inspectModelArkEvidence,
  modelArkCopyInspector = approvedModelArkBoundaryDocuments,
  artifactInspector = inspectCommittedSubmissionArtifacts,
  verificationInspector = inspectLocalVerification,
  read = readFile,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const checks = [];
  const unavailableGit = () => ({
    revision: "unavailable",
    treeDigest: "unavailable",
    objectFormat: "unavailable",
    clean: false,
    repositoryMatches: false,
    originMainRevision: null,
    originMainMatches: false,
  });
  let git = unavailableGit();
  let preVerificationGit = null;
  let gitInspectionFailed = false;
  try {
    preVerificationGit = await gitInspector(resolvedRoot);
  } catch {
    gitInspectionFailed = true;
  }
  let verificationValid = false;
  try {
    const verification = await verificationInspector(resolvedRoot);
    verificationValid = verification.valid === true;
  } catch {
    verificationValid = false;
  }
  try {
    git = await gitInspector(resolvedRoot);
  } catch {
    gitInspectionFailed = true;
  }
  const verificationSourceStable =
    !gitInspectionFailed &&
    preVerificationGit !== null &&
    sameGitSnapshot(preVerificationGit, git);
  checks.push(
    check(
      "release-verification",
      "Full quality and release gates",
      "core",
      verificationValid && verificationSourceStable ? "pass" : "fail",
      verificationValid && verificationSourceStable
        ? "The full quality and zero-network release gates ran between matching exact Git snapshots."
        : "The quality gate failed or its exact Git revision, tree, origin, or clean state changed while verification ran.",
    ),
  );
  let initialArtifacts = null;
  let initialRuntimeProof = null;
  let inspectedArchitecture = null;
  if (gitInspectionFailed) {
    checks.push(
      check(
        "source-control",
        "Source control state",
        "submission",
        "fail",
        "The exact Git revision, worktree state, and origin could not be inspected locally.",
      ),
    );
  }
  if (!checks.some((item) => item.id === "source-control")) {
    checks.push(
      check(
        "source-control",
        "Source control state",
        "submission",
        git.clean && git.repositoryMatches && git.originMainMatches
          ? "pass"
          : "owner-action",
        git.clean && git.repositoryMatches && git.originMainMatches
          ? "The clean worktree's exact HEAD matches the local origin/main reference in the documented submission repository."
          : "Commit the final tree, merge and push that exact HEAD to origin/main, and confirm that origin is the documented submission repository.",
      ),
    );
  }

  try {
    const artifacts = await artifactInspector({ root: resolvedRoot });
    if (artifacts.valid === true) initialArtifacts = artifacts;
    checks.push(
      check(
        "submission-files",
        "Committed submission artifacts",
        "core",
        artifacts.valid === true ? "pass" : "fail",
        artifacts.valid === true
          ? "Every required submission document and architecture asset is a regular file whose exact bytes match its HEAD blob."
          : "A required submission artifact is missing, substituted, uncommitted, or does not match HEAD.",
      ),
    );
  } catch {
    checks.push(
      check(
        "submission-files",
        "Committed submission artifacts",
        "core",
        "fail",
        "The required submission documents and architecture assets could not be bound to regular HEAD blobs.",
      ),
    );
  }

  let devpost = "";
  let submissionBrief = "";
  let readme = "";
  let judgeChecklist = "";
  let prd = "";
  let roadmap = "";
  let threeMinuteDemo = "";
  let architectureNotes = "";
  try {
    [
      devpost,
      submissionBrief,
      readme,
      judgeChecklist,
      prd,
      roadmap,
      threeMinuteDemo,
      architectureNotes,
    ] =
      await Promise.all([
        read(path.join(resolvedRoot, "docs/demo/DEVPOST_SUBMISSION.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/demo/SUBMISSION_BRIEF.md"), "utf8"),
        read(path.join(resolvedRoot, "README.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/demo/JUDGE_CHECKLIST.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/product/PRD.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/product/OUTCOME_ROADMAP.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/demo/three-minute-demo.md"), "utf8"),
        read(path.join(resolvedRoot, "docs/demo/architecture-one-page.md"), "utf8"),
      ]);
    const trackCopyReady =
      devpost.includes(
        "Track 1 - Agent Launchpad: Design and Build Lightweight Agent Middleware",
      ) &&
      devpost.includes("https://github.com/RrankPyramid/CodeJam") &&
      devpost
        .split(/\r?\n/)
        .filter((line) => line === exactPublicRepositoryLine).length === 1 &&
      submissionBrief.includes("shared `AgentRunner` boundary") &&
      readme.includes("TikTok TechJam 2026 selected track");
    checks.push(
      check(
        "track-one-copy",
        "Track 1 submission story",
        "core",
        trackCopyReady ? "pass" : "fail",
        trackCopyReady
          ? "The submission names Track 1, the CodeJam starter kit, and the shared AgentRunner middleware seam."
          : "The Track 1, starter-kit, or shared middleware positioning has drifted.",
      ),
    );
  } catch {
    checks.push(
      check(
        "track-one-copy",
        "Track 1 submission story",
        "core",
        "fail",
        "One or more required submission documents could not be read.",
      ),
    );
  }

  try {
    const architecture = await architectureInspector(resolvedRoot, read);
    inspectedArchitecture = architecture;
    checks.push(
      check(
        "architecture-asset",
        "One-page architecture asset",
        "core",
        architecture.valid ? "pass" : "fail",
        architecture.valid
          ? `The committed Mermaid source and ${architecture.width} by ${architecture.height} PNG match the reviewed source-to-render digest pair.`
          : "The architecture source, export, semantic markers, or integrity manifest has drifted.",
      ),
    );
  } catch {
    checks.push(
      check(
        "architecture-asset",
        "One-page architecture asset",
        "core",
        "fail",
        "The architecture source, export, or integrity manifest could not be verified.",
      ),
    );
  }

  try {
    const runtimeProof = await runtimeProofInspector(resolvedRoot, read);
    initialRuntimeProof = runtimeProof;
    const sourceBound = runtimeProofMatchesGit(runtimeProof, git);
    const chainBoundaryReady =
      runtimeProofHasExpectedChainBoundary(runtimeProof);
    checks.push(
      check(
        "runtime-proof",
        "Canonical Runtime proof pair",
        "core",
        sourceBound && chainBoundaryReady ? "pass" : "owner-action",
        sourceBound && chainBoundaryReady
          ? "The immutable schema-v2 capsule matches this clean Git commit and tree. Signed receipts bind Quarantine and Repair; Promotion remains an explicitly unsigned runner-observed capsule claim."
          : "Run npm run prove:runtime -- --reset --json from this exact clean revision. Schema-v1, dirty-tree, stale, or source-unbound proof cannot make the core ready.",
      ),
    );
  } catch {
    checks.push(
      check(
        "runtime-proof",
        "Canonical Runtime proof pair",
        "core",
        "fail",
        "No complete locally verifiable Runtime proof pair is available. Run npm run prove:runtime -- --reset --json.",
      ),
    );
  }

  const modelArkDocuments = [
    ["README.md", readme],
    ["docs/demo/DEVPOST_SUBMISSION.md", devpost],
    ["docs/demo/SUBMISSION_BRIEF.md", submissionBrief],
    ["docs/demo/JUDGE_CHECKLIST.md", judgeChecklist],
    ["docs/product/PRD.md", prd],
    ["docs/product/OUTCOME_ROADMAP.md", roadmap],
    ["docs/demo/three-minute-demo.md", threeMinuteDemo],
    ["docs/demo/architecture-one-page.md", architectureNotes],
  ];
  const semanticDocumentDigests = new Map(
    modelArkDocuments.map(([file, content]) => [
      file,
      sha256(Buffer.from(content, "utf8")),
    ]),
  );
  const modelArkHonest =
    modelArkCopyInspector(modelArkDocuments) &&
    devpost.includes("separate optional conformance") &&
    devpost.includes("No ModelArk request") &&
    submissionBrief.includes("Live ModelArk is a separate optional conformance encore") &&
    judgeChecklist.includes(
      "The single unchecked item is the optional provider-backed ModelArk conformance rerun",
    );
  checks.push(
    check(
      "modelark-honesty",
      "ModelArk proof boundary",
      "core",
      modelArkHonest ? "pass" : "fail",
      modelArkHonest
        ? "The canonical fixture proof and optional live ModelArk conformance proof remain explicitly separate."
        : "Submission copy contains a stale live-provider claim or lost the fixture and optional-live disclosure.",
    ),
  );

  const youtubeUrl = extractYouTubeUrl(devpost);
  checks.push(
    check(
      "demo-video-link",
      "Public demo video link",
      "submission",
      youtubeUrl ? "pass" : "owner-action",
      youtubeUrl
        ? "The Devpost copy contains a structurally valid YouTube URL."
        : "Record the final three-minute demo and replace the YouTube placeholder in DEVPOST_SUBMISSION.md.",
    ),
  );
  checks.push(
    check(
      "demo-video-public",
      "Video visibility and duration",
      "submission",
      youtubeUrl && confirmVideoPublic ? "owner-confirmed" : "owner-action",
      youtubeUrl && confirmVideoPublic
        ? "The operator confirmed that the linked video is public or unlisted and no longer than three minutes."
        : "After upload, confirm the video is public or unlisted, opens signed out, and is no longer than three minutes, then rerun with --confirm-video-public.",
    ),
  );
  checks.push(
    check(
      "repository-public",
      "Exact revision public visibility",
      "submission",
      git.clean &&
        git.repositoryMatches &&
        git.originMainMatches &&
        confirmPublicRevision === git.revision
        ? "owner-confirmed"
        : "owner-action",
      git.clean &&
        git.repositoryMatches &&
        git.originMainMatches &&
        confirmPublicRevision === git.revision
        ? `The operator confirmed that exact revision ${git.revision} is pushed and opens in the public repository without authentication.`
        : "Push the exact reported revision, make it public, verify that SHA signed out, then rerun with --confirm-public-revision=<exact SHA>.",
    ),
  );

  checks.push(
    check(
      "modelark-config",
      "Live ModelArk configuration",
      "optional",
      modelArkConfigurationReady(environment) ? "pass" : "optional-pending",
      modelArkConfigurationReady(environment)
        ? "Credential and model fields are configured without exposing their values. No provider request was made."
        : "Optional live conformance remains unconfigured. The canonical Track 1 proof is unaffected.",
    ),
  );
  try {
    const modelArk = await modelArkEvidenceInspector(resolvedRoot, environment);
    checks.push(
      check(
        "modelark-live-evidence",
        "Live ModelArk signed evidence",
        "optional",
        modelArk.valid ? "pass" : "optional-pending",
        modelArk.valid
          ? "A historical provider-backed Promotion packet verifies offline. This does not prove current provider availability."
          : "No valid historical live packet is available. No provider-backed success is claimed.",
      ),
    );
  } catch {
    checks.push(
      check(
        "modelark-live-evidence",
        "Live ModelArk signed evidence",
        "optional",
        "optional-pending",
        "No valid historical live packet is available. No provider request was made and no provider-backed success is claimed.",
      ),
    );
  }

  let finalArtifacts = null;
  let finalRuntimeProof = null;
  let finalGit = {
    revision: "unavailable",
    treeDigest: "unavailable",
    objectFormat: "unavailable",
    clean: false,
    repositoryMatches: false,
    originMainRevision: null,
    originMainMatches: false,
  };
  try {
    const artifacts = await artifactInspector({ root: resolvedRoot });
    if (artifacts.valid === true) finalArtifacts = artifacts;
  } catch {
    finalArtifacts = null;
  }
  try {
    finalRuntimeProof = await runtimeProofInspector(resolvedRoot, read);
  } catch {
    finalRuntimeProof = null;
  }
  try {
    finalGit = await gitInspector(resolvedRoot);
  } catch {
    finalGit.clean = false;
  }
  const handoffStable =
    initialArtifacts !== null &&
    finalArtifacts !== null &&
    artifactSnapshotsMatch(initialArtifacts, finalArtifacts) &&
    initialArtifacts.revision === git.revision &&
    finalArtifacts.revision === finalGit.revision &&
    modelArkDocuments.every(
      ([file]) =>
        artifactDigest(initialArtifacts, file) ===
          semanticDocumentDigests.get(file) &&
        artifactDigest(finalArtifacts, file) ===
          semanticDocumentDigests.get(file),
    ) &&
    artifactDigest(initialArtifacts, canonicalArchitectureSource) ===
      inspectedArchitecture?.sourceDigest &&
    artifactDigest(finalArtifacts, canonicalArchitectureSource) ===
      inspectedArchitecture?.sourceDigest &&
    artifactDigest(initialArtifacts, canonicalArchitectureImage) ===
      inspectedArchitecture?.imageDigest &&
    artifactDigest(finalArtifacts, canonicalArchitectureImage) ===
      inspectedArchitecture?.imageDigest &&
    artifactDigest(initialArtifacts, "docs/demo/submission-assets.json") ===
      inspectedArchitecture?.manifestDigest &&
    artifactDigest(finalArtifacts, "docs/demo/submission-assets.json") ===
      inspectedArchitecture?.manifestDigest &&
    sameGitSnapshot(git, finalGit) &&
    runtimeProofFingerprint(initialRuntimeProof) ===
      runtimeProofFingerprint(finalRuntimeProof) &&
    runtimeProofMatchesGit(finalRuntimeProof, finalGit) &&
    runtimeProofHasExpectedChainBoundary(finalRuntimeProof);
  checks.push(
    check(
      "handoff-stability",
      "Final source and evidence stability",
      "core",
      handoffStable ? "pass" : "fail",
      handoffStable
        ? "A final committed-artifact, Runtime proof, and Git reinspection matched the exact source snapshot used by every core claim."
        : "Source, required artifacts, or Runtime proof changed during the audit. Stop editing, regenerate the proof from the exact clean revision, and rerun.",
    ),
  );

  return completeReport(finalGit.revision, checks);
}

export function renderSubmissionReadiness(report) {
  const labels = {
    pass: "PASS",
    fail: "FAIL",
    "owner-action": "OWNER ACTION",
    "owner-confirmed": "OWNER CONFIRMED",
    "optional-pending": "OPTIONAL PENDING",
  };
  for (const item of report.checks) {
    console.log(`[${labels[item.status]}] ${item.label}: ${item.detail}`);
  }
  console.log("Network requests: 0");
  console.log("Submission evidence: " + report.evidenceDigest);
  console.log(
    report.coreDemoReady
      ? "[CORE READY] The reproducible Track 1 demo is locally ready."
      : "[CORE NOT READY] Fix deterministic product or evidence failures.",
  );
  console.log(
    report.submissionReady
      ? "[SUBMISSION READY] Local gates passed and external owner checks were explicitly confirmed."
      : "[SUBMISSION NOT READY] Complete every owner action before Devpost submission.",
  );
}

function parseArguments(argv) {
  const publicRevisionArguments = argv.filter((argument) =>
    argument.startsWith("--confirm-public-revision="),
  );
  const unknown = argv.filter(
    (argument) =>
      !["--json", "--confirm-video-public"].includes(argument) &&
      !argument.startsWith("--confirm-public-revision="),
  );
  if (unknown.length > 0) {
    throw new Error("Unknown submission audit option: " + unknown.join(", "));
  }
  if (publicRevisionArguments.length > 1) {
    throw new Error("The public revision may be confirmed only once");
  }
  const confirmPublicRevision =
    publicRevisionArguments[0]?.slice(
      "--confirm-public-revision=".length,
    ) ?? null;
  if (
    confirmPublicRevision !== null &&
    !gitObjectIdPattern.test(confirmPublicRevision)
  ) {
    throw new Error("The confirmed public revision must be an exact Git object ID");
  }
  return {
    json: argv.includes("--json"),
    confirmPublicRevision,
    confirmVideoPublic: argv.includes("--confirm-video-public"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await inspectSubmissionReadiness(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else renderSubmissionReadiness(report);
  if (!report.localIntegrityReady) process.exitCode = 1;
  else if (!report.submissionReady) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
