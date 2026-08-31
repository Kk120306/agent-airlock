#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  execFile as execFileCallback,
  spawn as spawnChild,
} from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import {
  assertRuntimeSourceProvenance,
  inspectRuntimeSourceProvenance,
} from "./runtime-source-provenance.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const schema = "agent-airlock-production-image-provenance/v1";
const pinnedBaseImage =
  "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const pinnedCodexVersion = "codex-cli 0.111.0";
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const maximumProofBytes = 1024 * 1024;
const execFile = promisify(execFileCallback);
const expectedArchiveName = "agent-airlock-production-image.tar";
const sourceRevisionLabel = "org.opencontainers.image.revision";
const sourceTreeLabel = "io.agent-airlock.source-tree";
const ociIndexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const ociManifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const ociConfigMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const gzipLayerMediaTypes = new Set([
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
]);
const attestationLayerMediaTypes = new Set(["application/vnd.in-toto+json"]);

export const productionImageInputPaths = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "Dockerfile.runtime",
  "docker-compose.yml",
  "docker/codex-runtime/package.json",
  "docker/codex-runtime/package-lock.json",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
]);

export const productionImageProofClosurePaths = Object.freeze([
  ".github/workflows/release-proof.yml",
  "Dockerfile",
  "Dockerfile.runtime",
  "apps/server/src/agent-service.ts",
  "apps/server/src/airlock-runner.ts",
  "apps/server/src/codex-runner.ts",
  "apps/server/src/container-codex-runner.ts",
  "apps/server/src/external-actions.ts",
  "apps/server/src/outcome-validator.ts",
  "apps/server/src/sensitive-literals.ts",
  "apps/server/src/sqlite-resource.ts",
  "apps/web/src/App.tsx",
  "docker-compose.yml",
  "docker/codex-runtime/package.json",
  "docker/codex-runtime/package-lock.json",
  "package.json",
  "package-lock.json",
  "playwright.container-browser.config.ts",
  "scripts/check-container-transaction.mjs",
  "scripts/check-phase-eleven-docker.sh",
  "scripts/check-phase-thirteen.mjs",
  "scripts/check-production-image-browser.mjs",
  "scripts/check-production-image-browser.test.mjs",
  "scripts/check-production-image-transaction.mjs",
  "scripts/check-production-image-transaction.test.mjs",
  "scripts/container-browser-fixture-startup.mjs",
  "scripts/container-browser-fixture-startup.test.mjs",
  "scripts/demo-outcome-contract.mjs",
  "scripts/judge-readiness.mjs",
  "scripts/modelark-demo-profile.mjs",
  "scripts/production-build-context.mjs",
  "scripts/production-build-context.test.mjs",
  "scripts/production-gate-cleanup.test.mjs",
  "scripts/production-image-persistence-verifier.mjs",
  "scripts/production-image-persistence-verifier.test.mjs",
  "scripts/production-image-provenance.mjs",
  "scripts/production-image-provenance.test.mjs",
  "scripts/production-image-verifier.mjs",
  "scripts/production-image-verifier.test.mjs",
  "scripts/release-audit.mjs",
  "scripts/release-compose-policy.mjs",
  "scripts/release-compose-policy.test.mjs",
  "scripts/release-execution-policy.mjs",
  "scripts/release-execution-policy.test.mjs",
  "scripts/release-lockfile-policy.mjs",
  "scripts/release-lockfile-policy.test.mjs",
  "scripts/release-quality-policy.mjs",
  "scripts/release-quality-policy.test.mjs",
  "scripts/run-container-browser-fixture.mjs",
  "scripts/runtime-demo-profile.mjs",
  "scripts/runtime-proof-terminal.mjs",
  "scripts/runtime-source-provenance.mjs",
  "scripts/runtime-source-provenance.test.mjs",
  "scripts/trusted-git-exec.mjs",
  "tests/container-browser/global-teardown.ts",
  "tests/container-browser/real-container.spec.ts",
  "tests/fixtures/responses-protocol-server.mjs",
]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

async function regularFileMetadata(filePath, maximumBytes = Infinity) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error("Release artifact is not a bounded regular file");
  }
  return metadata;
}

async function sha256File(filePath) {
  await regularFileMetadata(filePath);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return "sha256:" + hash.digest("hex");
}

async function sha256ArchiveMember(archivePath, member) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let settled = false;
    const child = spawnChild("tar", ["-xOf", archivePath, "--", member], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finishError = (message) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    const timeout = setTimeout(
      () => finishError("Production image archive member inspection timed out"),
      300_000,
    );
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      finishError("Production image archive member could not be inspected");
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0 || bytes < 1) {
        reject(new Error("Production image archive member is invalid"));
        return;
      }
      resolve({ bytes, sha256: "sha256:" + hash.digest("hex") });
    });
  });
}

async function readArchiveMember(
  archivePath,
  member,
  maximumBytes = 32 * 1024 * 1024,
) {
  try {
    const { stdout } = await execFile(
      "tar",
      ["-xOf", archivePath, "--", member],
      {
        encoding: "buffer",
        maxBuffer: maximumBytes,
        timeout: 10_000,
      },
    );
    if (!Buffer.isBuffer(stdout) || stdout.length < 1) {
      throw new Error("empty member");
    }
    return stdout;
  } catch {
    throw new Error("Production image archive member could not be read");
  }
}

function parseJsonBytes(bytes, message) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(message);
  }
}

function assertDescriptor(descriptor, mediaTypes) {
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    !mediaTypes.has(descriptor.mediaType) ||
    !sha256Pattern.test(descriptor.digest ?? "") ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1
  ) {
    throw new Error(
      "Production image archive contains an invalid OCI descriptor",
    );
  }
}

async function readDescriptorBlob(archivePath, descriptor, mediaTypes) {
  assertDescriptor(descriptor, mediaTypes);
  const member = `blobs/sha256/${descriptor.digest.slice("sha256:".length)}`;
  const bytes = await readArchiveMember(archivePath, member);
  const observed = {
    bytes: bytes.length,
    sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  };
  if (
    observed.sha256 !== descriptor.digest ||
    observed.bytes !== descriptor.size
  ) {
    throw new Error("Production image OCI descriptor contradicts its blob");
  }
  return { bytes, member };
}

async function sha256GzipTarMember(archivePath, member) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let extractorCode = null;
    let validatorCode = null;
    let decompressorEnded = false;
    let settled = false;
    const extractor = spawnChild("tar", ["-xOf", archivePath, "--", member], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const decompressor = createGunzip();
    const validator = spawnChild("tar", ["-tf", "-"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const rejectInspection = (message) => {
      if (settled) return;
      settled = true;
      extractor.kill("SIGKILL");
      decompressor.destroy();
      validator.kill("SIGKILL");
      reject(new Error(message));
    };
    const finish = () => {
      if (
        settled ||
        extractorCode === null ||
        validatorCode === null ||
        !decompressorEnded
      ) {
        return;
      }
      if (extractorCode !== 0 || validatorCode !== 0 || bytes < 1) {
        rejectInspection("Production image archive contains an invalid layer");
        return;
      }
      settled = true;
      resolve("sha256:" + hash.digest("hex"));
    };
    const timeout = setTimeout(() => {
      rejectInspection("Production image layer inspection timed out");
    }, 300_000);
    extractor.stdout.pipe(decompressor);
    decompressor.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024 * 1024) {
        rejectInspection("Production image layer exceeds the inspection bound");
        return;
      }
      hash.update(chunk);
    });
    decompressor.pipe(validator.stdin);
    for (const stream of [extractor.stdout, decompressor, validator.stdin]) {
      stream.once("error", () => {
        rejectInspection("Production image layer could not be inspected");
      });
    }
    extractor.once("error", () => {
      rejectInspection("Production image layer could not be inspected");
    });
    validator.once("error", () => {
      rejectInspection("Production image layer could not be validated");
    });
    extractor.once("close", (code) => {
      extractorCode = code;
      finish();
    });
    decompressor.once("end", () => {
      decompressorEnded = true;
      finish();
    });
    validator.once("close", (code) => {
      validatorCode = code;
      finish();
    });
    Promise.all([
      new Promise((resolveClose) => extractor.once("close", resolveClose)),
      new Promise((resolveClose) => validator.once("close", resolveClose)),
    ]).finally(() => clearTimeout(timeout));
  });
}

async function sha256TarMember(archivePath, member) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let settled = false;
    let extractorCode = null;
    let validatorCode = null;
    const extractor = spawnChild("tar", ["-xOf", archivePath, "--", member], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const validator = spawnChild("tar", ["-tf", "-"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const rejectInspection = (message) => {
      if (settled) return;
      settled = true;
      extractor.kill("SIGKILL");
      validator.kill("SIGKILL");
      reject(new Error(message));
    };
    const finish = () => {
      if (settled || extractorCode === null || validatorCode === null) return;
      if (extractorCode !== 0 || validatorCode !== 0 || bytes < 1) {
        rejectInspection("Production image archive contains an invalid layer");
        return;
      }
      settled = true;
      resolve("sha256:" + hash.digest("hex"));
    };
    const timeout = setTimeout(() => {
      rejectInspection("Production image layer inspection timed out");
    }, 300_000);
    extractor.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    extractor.stdout.pipe(validator.stdin);
    validator.stdin.once("error", () => {
      rejectInspection("Production image archive contains an invalid layer");
    });
    extractor.once("error", () => {
      clearTimeout(timeout);
      rejectInspection("Production image layer could not be inspected");
    });
    validator.once("error", () => {
      clearTimeout(timeout);
      rejectInspection("Production image layer could not be validated");
    });
    extractor.once("close", (code) => {
      extractorCode = code;
      finish();
    });
    validator.once("close", (code) => {
      validatorCode = code;
      finish();
    });
    Promise.all([
      new Promise((resolveClose) => extractor.once("close", resolveClose)),
      new Promise((resolveClose) => validator.once("close", resolveClose)),
    ]).finally(() => clearTimeout(timeout));
  });
}

function sourceIdentityFromConfig(config) {
  const labels = config?.config?.Labels ?? config?.Config?.Labels;
  const source = {
    commitOid: labels?.[sourceRevisionLabel],
    treeOid: labels?.[sourceTreeLabel],
  };
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitOid ?? "") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.treeOid ?? "") ||
    source.commitOid.length !== source.treeOid.length
  ) {
    throw new Error("Production image config has no exact source identity");
  }
  return source;
}

async function inspectAttestationManifest(
  archivePath,
  descriptor,
  runnableManifestDigest,
) {
  if (
    descriptor?.platform?.os !== "unknown" ||
    descriptor?.platform?.architecture !== "unknown" ||
    descriptor?.annotations?.["vnd.docker.reference.type"] !==
      "attestation-manifest" ||
    descriptor?.annotations?.["vnd.docker.reference.digest"] !==
      runnableManifestDigest
  ) {
    throw new Error("Production image OCI index has an unrecognized child");
  }
  const { bytes } = await readDescriptorBlob(
    archivePath,
    descriptor,
    ociManifestMediaTypes,
  );
  const manifest = parseJsonBytes(
    bytes,
    "Production image attestation manifest is not valid JSON",
  );
  if (
    manifest?.schemaVersion !== 2 ||
    !ociManifestMediaTypes.has(manifest?.mediaType) ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length < 1
  ) {
    throw new Error("Production image attestation manifest is malformed");
  }
  await readDescriptorBlob(archivePath, manifest.config, ociConfigMediaTypes);
  for (const layer of manifest.layers) {
    await readDescriptorBlob(archivePath, layer, attestationLayerMediaTypes);
  }
}

async function inspectModernDockerArchive(
  archivePath,
  imageId,
  dockerManifest,
) {
  const layout = parseJsonBytes(
    await readArchiveMember(archivePath, "oci-layout", maximumProofBytes),
    "Production image OCI layout is not valid JSON",
  );
  const archiveIndex = parseJsonBytes(
    await readArchiveMember(archivePath, "index.json", maximumProofBytes),
    "Production image OCI index is not valid JSON",
  );
  if (
    !exactKeys(layout, ["imageLayoutVersion"]) ||
    layout.imageLayoutVersion !== "1.0.0" ||
    archiveIndex?.schemaVersion !== 2 ||
    !ociIndexMediaTypes.has(archiveIndex?.mediaType) ||
    !Array.isArray(archiveIndex.manifests) ||
    archiveIndex.manifests.length !== 1 ||
    archiveIndex.manifests[0]?.digest !== imageId
  ) {
    throw new Error("Production image OCI root does not bind its image ID");
  }
  const rootDescriptor = archiveIndex.manifests[0];
  const rootMediaTypes = new Set([
    ...ociIndexMediaTypes,
    ...ociManifestMediaTypes,
  ]);
  const { bytes: rootBytes } = await readDescriptorBlob(
    archivePath,
    rootDescriptor,
    rootMediaTypes,
  );
  let runnableDescriptor = rootDescriptor;
  let ancillaryDescriptors = [];
  if (ociIndexMediaTypes.has(rootDescriptor.mediaType)) {
    const rootIndex = parseJsonBytes(
      rootBytes,
      "Production image platform index is not valid JSON",
    );
    if (
      rootIndex?.schemaVersion !== 2 ||
      !ociIndexMediaTypes.has(rootIndex?.mediaType) ||
      !Array.isArray(rootIndex.manifests) ||
      rootIndex.manifests.length < 1
    ) {
      throw new Error("Production image platform index is malformed");
    }
    const runnableDescriptors = rootIndex.manifests.filter(
      (descriptor) =>
        descriptor?.platform?.os === "linux" &&
        ["amd64", "arm64"].includes(descriptor?.platform?.architecture),
    );
    if (runnableDescriptors.length !== 1) {
      throw new Error("Production image OCI index is not single-platform");
    }
    runnableDescriptor = runnableDescriptors[0];
    ancillaryDescriptors = rootIndex.manifests.filter(
      (descriptor) => descriptor !== runnableDescriptor,
    );
  }
  const { bytes: runnableManifestBytes } = await readDescriptorBlob(
    archivePath,
    runnableDescriptor,
    ociManifestMediaTypes,
  );
  const runnableManifest = parseJsonBytes(
    runnableManifestBytes,
    "Production image platform manifest is not valid JSON",
  );
  if (
    runnableManifest?.schemaVersion !== 2 ||
    !ociManifestMediaTypes.has(runnableManifest?.mediaType) ||
    !Array.isArray(runnableManifest.layers) ||
    runnableManifest.layers.length < 1 ||
    runnableManifest.layers.some(
      (descriptor) => !gzipLayerMediaTypes.has(descriptor?.mediaType),
    )
  ) {
    throw new Error("Production image platform manifest is malformed");
  }
  const { bytes: configBytes, member: configName } = await readDescriptorBlob(
    archivePath,
    runnableManifest.config,
    ociConfigMediaTypes,
  );
  const layerNames = runnableManifest.layers.map(
    (descriptor) => `blobs/sha256/${descriptor.digest.slice("sha256:".length)}`,
  );
  if (
    dockerManifest.Config !== configName ||
    JSON.stringify(dockerManifest.Layers) !== JSON.stringify(layerNames)
  ) {
    throw new Error("Production image Docker and OCI manifests disagree");
  }
  const config = parseJsonBytes(
    configBytes,
    "Production image archive config is not valid JSON",
  );
  if (
    config?.os !== "linux" ||
    !["amd64", "arm64"].includes(config?.architecture) ||
    config?.rootfs?.type !== "layers" ||
    !Array.isArray(config.rootfs.diff_ids) ||
    config.rootfs.diff_ids.length !== runnableManifest.layers.length ||
    config.rootfs.diff_ids.some((digest) => !sha256Pattern.test(digest)) ||
    (runnableDescriptor.platform !== undefined &&
      (runnableDescriptor.platform.os !== config.os ||
        runnableDescriptor.platform.architecture !== config.architecture))
  ) {
    throw new Error("Production image archive platform is unsupported");
  }
  for (let index = 0; index < runnableManifest.layers.length; index += 1) {
    const descriptor = runnableManifest.layers[index];
    const member = layerNames[index];
    const observed = await sha256ArchiveMember(archivePath, member);
    if (
      observed.sha256 !== descriptor.digest ||
      observed.bytes !== descriptor.size
    ) {
      throw new Error("Production image layer contradicts its descriptor");
    }
    if (
      (await sha256GzipTarMember(archivePath, member)) !==
      config.rootfs.diff_ids[index]
    ) {
      throw new Error("Production image layer contradicts its config");
    }
  }
  for (const descriptor of ancillaryDescriptors) {
    await inspectAttestationManifest(
      archivePath,
      descriptor,
      runnableDescriptor.digest,
    );
  }
  return {
    identity: {
      configDigest: runnableManifest.config.digest,
      kind: ociIndexMediaTypes.has(rootDescriptor.mediaType)
        ? "oci-index"
        : "oci-manifest",
      manifestDigest: runnableDescriptor.digest,
      rootDigest: rootDescriptor.digest,
    },
    platform: { architecture: config.architecture, os: config.os },
    rootfs: config.rootfs.diff_ids,
    source: sourceIdentityFromConfig(config),
  };
}

async function inspectDockerArchive(archivePath, imageId) {
  let manifest;
  try {
    manifest = parseJsonBytes(
      await readArchiveMember(archivePath, "manifest.json", maximumProofBytes),
      "Production image archive has no valid Docker manifest",
    );
  } catch {
    throw new Error("Production image archive has no valid Docker manifest");
  }
  const imageHex = imageId.slice("sha256:".length);
  const legacyConfigName = imageHex + ".json";
  const configName = manifest?.[0]?.Config;
  const modernArchive = /^blobs\/sha256\/[a-f0-9]{64}$/.test(configName ?? "");
  const legacyArchive = configName === legacyConfigName;
  const repoTags = manifest?.[0]?.RepoTags;
  const repoTagsValid =
    repoTags === null ||
    (Array.isArray(repoTags) && repoTags.length === 0);
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    !exactKeys(manifest[0], ["Config", "RepoTags", "Layers"]) ||
    (!modernArchive && !legacyArchive) ||
    !repoTagsValid ||
    !Array.isArray(manifest[0].Layers) ||
    manifest[0].Layers.length < 1 ||
    new Set(manifest[0].Layers).size !== manifest[0].Layers.length ||
    manifest[0].Layers.some(
      (layer) =>
        typeof layer !== "string" ||
        layer.startsWith("-") ||
        layer.includes("\\") ||
        path.isAbsolute(layer) ||
        (modernArchive ? false : !layer.endsWith("/layer.tar")) ||
        layer
          .split("/")
          .some(
            (segment) => segment === "" || segment === "." || segment === "..",
          ),
    )
  ) {
    throw new Error("Production image archive does not bind one exact image");
  }
  if (modernArchive) {
    return inspectModernDockerArchive(archivePath, imageId, manifest[0]);
  }
  const configBytes = await readArchiveMember(archivePath, configName);
  const actualImageId =
    "sha256:" + createHash("sha256").update(configBytes).digest("hex");
  if (actualImageId !== imageId) {
    throw new Error("Production image archive config contradicts its image ID");
  }
  const config = parseJsonBytes(
    configBytes,
    "Production image archive config is not valid JSON",
  );
  if (
    config?.os !== "linux" ||
    !["amd64", "arm64"].includes(config?.architecture) ||
    config?.rootfs?.type !== "layers" ||
    !Array.isArray(config.rootfs.diff_ids) ||
    config.rootfs.diff_ids.length !== manifest[0].Layers.length ||
    config.rootfs.diff_ids.some((digest) => !sha256Pattern.test(digest))
  ) {
    throw new Error("Production image archive platform is unsupported");
  }
  for (let index = 0; index < manifest[0].Layers.length; index += 1) {
    const layer = manifest[0].Layers[index];
    if (
      (await sha256TarMember(archivePath, layer)) !==
      config.rootfs.diff_ids[index]
    ) {
      throw new Error("Production image archive layer contradicts its config");
    }
  }
  return {
    identity: {
      configDigest: imageId,
      kind: "legacy-config",
      manifestDigest: null,
      rootDigest: imageId,
    },
    platform: { architecture: config.architecture, os: config.os },
    rootfs: config.rootfs.diff_ids,
    source: sourceIdentityFromConfig(config),
  };
}

async function inspectRunnableImage(imageId) {
  let image;
  try {
    const { stdout } = await execFile("docker", ["image", "inspect", imageId], {
      encoding: "utf8",
      maxBuffer: maximumProofBytes,
      timeout: 10_000,
    });
    const decoded = JSON.parse(stdout);
    if (!Array.isArray(decoded) || decoded.length !== 1) {
      throw new Error("unexpected image count");
    }
    image = decoded[0];
  } catch {
    throw new Error("Production image identity could not be inspected");
  }
  if (
    image?.Id !== imageId ||
    image?.Os !== "linux" ||
    !["amd64", "arm64"].includes(image?.Architecture) ||
    image?.RootFS?.Type !== "layers" ||
    !Array.isArray(image.RootFS.Layers) ||
    image.RootFS.Layers.length < 1 ||
    image.RootFS.Layers.some((digest) => !sha256Pattern.test(digest)) ||
    (image.Descriptor !== undefined &&
      (image.Descriptor?.digest !== imageId ||
        ![...ociIndexMediaTypes, ...ociManifestMediaTypes].includes(
          image.Descriptor?.mediaType,
        ) ||
        !Number.isSafeInteger(image.Descriptor?.size) ||
        image.Descriptor.size < 1))
  ) {
    throw new Error("Production image inspection contradicts its identity");
  }
  let codexVersion;
  try {
    const { stdout } = await execFile(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev",
        "--entrypoint",
        "codex",
        imageId,
        "--version",
      ],
      { encoding: "utf8", maxBuffer: maximumProofBytes, timeout: 30_000 },
    );
    codexVersion = stdout.trim();
  } catch {
    throw new Error("Production image Codex version could not be inspected");
  }
  if (codexVersion !== pinnedCodexVersion) {
    throw new Error("Production image does not contain the pinned Codex CLI");
  }
  return {
    codexVersion,
    id: image.Id,
    platform: { architecture: image.Architecture, os: image.Os },
    rootfs: image.RootFS.Layers,
    source: sourceIdentityFromConfig(image),
  };
}

function dockerExecOptions(timeout) {
  return {
    encoding: "utf8",
    maxBuffer: maximumProofBytes,
    timeout,
  };
}

function decodeInspectedImage(stdout, imageId) {
  let decoded;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error("Production image inspection returned invalid JSON");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 1 ||
    decoded[0]?.Id !== imageId
  ) {
    throw new Error("Production image inspection contradicts its identity");
  }
  return decoded[0];
}

function hasNoRepositoryTags(image) {
  return (
    image?.RepoTags === null ||
    (Array.isArray(image?.RepoTags) && image.RepoTags.length === 0)
  );
}

async function inspectLoadedDockerImage(imageId, executeDocker) {
  const { stdout } = await executeDocker(
    "docker",
    ["image", "inspect", imageId],
    dockerExecOptions(10_000),
  );
  return decodeInspectedImage(stdout, imageId);
}

async function assertDockerImageAbsent(imageId, executeDocker) {
  try {
    await inspectLoadedDockerImage(imageId, executeDocker);
  } catch (error) {
    const exitCode = error?.code;
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (
      (exitCode === 1 || exitCode === "1") &&
      /(?:No such image|No such object)/.test(stderr)
    ) {
      return;
    }
    throw new Error(
      "Production image replay could not prove the target image is absent",
    );
  }
  throw new Error("Production image replay target already exists");
}

async function removeOwnedDockerImage(imageId, executeDocker) {
  let image;
  try {
    image = await inspectLoadedDockerImage(imageId, executeDocker);
  } catch {
    return;
  }
  if (!hasNoRepositoryTags(image)) {
    throw new Error(
      "Production image replay target acquired an unrelated repository tag",
    );
  }
  await executeDocker(
    "docker",
    ["image", "rm", imageId],
    dockerExecOptions(30_000),
  );
}

export async function validateDockerArchiveLoad(
  archivePath,
  imageId,
  { executeDocker = execFile, requireAbsent = false } = {},
) {
  let loadStarted = false;
  try {
    if (requireAbsent) {
      await assertDockerImageAbsent(imageId, executeDocker);
    }
    loadStarted = true;
    await executeDocker(
      "docker",
      ["image", "load", "--input", archivePath],
      dockerExecOptions(300_000),
    );
    const image = await inspectLoadedDockerImage(imageId, executeDocker);
    if (requireAbsent && !hasNoRepositoryTags(image)) {
      throw new Error("loaded image acquired a repository tag");
    }
    return {
      loadedFresh: requireAbsent,
      rollback: requireAbsent
        ? async () => removeOwnedDockerImage(imageId, executeDocker)
        : null,
    };
  } catch (error) {
    if (requireAbsent && loadStarted) {
      try {
        await removeOwnedDockerImage(imageId, executeDocker);
      } catch {
        // Preserve any image that another actor tagged during the replay race.
      }
    }
    if (
      error instanceof Error &&
      [
        "Production image replay could not prove the target image is absent",
        "Production image replay target already exists",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error(
      "Production image archive is not loadable as its exact image ID",
    );
  }
}

async function sourceBindings(projectRoot, paths) {
  return Promise.all(
    [...paths].sort().map(async (relativePath) => ({
      path: relativePath,
      sha256: await sha256File(path.join(projectRoot, relativePath)),
    })),
  );
}

function assertArtifactName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== path.basename(value) ||
    value.includes("\0")
  ) {
    throw new Error("Release artifact path must be a basename");
  }
}

function assertBindingArray(actual, expectedPaths) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expectedPaths.length ||
    actual.some(
      (entry, index) =>
        !exactKeys(entry, ["path", "sha256"]) ||
        entry.path !== [...expectedPaths].sort()[index] ||
        !sha256Pattern.test(entry.sha256),
    )
  ) {
    throw new Error("Production image source binding is malformed");
  }
}

function assertImageSourceIdentity(source) {
  if (
    !exactKeys(source, ["commitOid", "treeOid"]) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitOid ?? "") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.treeOid ?? "") ||
    source.commitOid.length !== source.treeOid.length
  ) {
    throw new Error("Production image source identity is malformed");
  }
}

function assertArchiveIdentity(identity) {
  if (
    !exactKeys(identity, [
      "configDigest",
      "kind",
      "manifestDigest",
      "rootDigest",
    ]) ||
    !["legacy-config", "oci-index", "oci-manifest"].includes(identity.kind) ||
    !sha256Pattern.test(identity.configDigest ?? "") ||
    !sha256Pattern.test(identity.rootDigest ?? "") ||
    (identity.manifestDigest !== null &&
      !sha256Pattern.test(identity.manifestDigest ?? "")) ||
    (identity.kind === "legacy-config" &&
      (identity.manifestDigest !== null ||
        identity.configDigest !== identity.rootDigest)) ||
    (identity.kind !== "legacy-config" && identity.manifestDigest === null)
  ) {
    throw new Error("Production image archive identity is malformed");
  }
}

function assertImageMatchesSource(imageSource, source) {
  assertImageSourceIdentity(imageSource);
  if (
    imageSource.commitOid !== source.commitOid ||
    imageSource.treeOid !== source.treeOid
  ) {
    throw new Error("Production image source identity contradicts Git");
  }
}

export async function createProductionImageProvenance({
  archivePath,
  imageId,
  inspectImage = inspectRunnableImage,
  inspectSource = inspectRuntimeSourceProvenance,
  projectRoot = defaultProjectRoot,
  validateArchive = validateDockerArchiveLoad,
}) {
  if (!sha256Pattern.test(imageId ?? "")) {
    throw new Error("Production image identity is malformed");
  }
  const archive = await regularFileMetadata(archivePath);
  if (path.basename(archivePath) !== expectedArchiveName) {
    throw new Error("Production image artifact names are not canonical");
  }
  const [archiveImage, source, inputs, proofClosure] = await Promise.all([
    inspectDockerArchive(archivePath, imageId),
    inspectSource({ root: projectRoot }),
    sourceBindings(projectRoot, productionImageInputPaths),
    sourceBindings(projectRoot, productionImageProofClosurePaths),
  ]);
  await validateArchive(archivePath, imageId);
  const runnableImage = await inspectImage(imageId);
  assertRuntimeSourceProvenance(source);
  assertImageMatchesSource(archiveImage.source, source);
  assertImageMatchesSource(runnableImage.source, source);
  if (
    runnableImage.id !== imageId ||
    runnableImage.codexVersion !== pinnedCodexVersion ||
    JSON.stringify(runnableImage.platform) !==
      JSON.stringify(archiveImage.platform) ||
    JSON.stringify(runnableImage.rootfs) !== JSON.stringify(archiveImage.rootfs)
  ) {
    throw new Error("Production image observations do not agree");
  }
  return {
    schema,
    source,
    image: runnableImage,
    archive: {
      bytes: archive.size,
      format: "docker-archive",
      identity: archiveImage.identity,
      path: path.basename(archivePath),
      sha256: await sha256File(archivePath),
    },
    inputs: { baseImage: pinnedBaseImage, files: inputs },
    proofClosure,
  };
}

export async function verifyProductionImageProvenance(
  proof,
  {
    artifactDirectory,
    inspectImage = inspectRunnableImage,
    inspectSource = inspectRuntimeSourceProvenance,
    projectRoot = defaultProjectRoot,
    requireFreshReplay = true,
    validateArchive = validateDockerArchiveLoad,
  } = {},
) {
  let replayOwnership;
  let verified = false;
  try {
    if (
      !exactKeys(proof, [
        "schema",
        "source",
        "image",
        "archive",
        "inputs",
        "proofClosure",
      ]) ||
      proof.schema !== schema ||
      !exactKeys(proof.image, [
        "id",
        "platform",
        "codexVersion",
        "rootfs",
        "source",
      ]) ||
      !sha256Pattern.test(proof.image.id) ||
      proof.image.codexVersion !== pinnedCodexVersion ||
      !exactKeys(proof.image.platform, ["architecture", "os"]) ||
      proof.image.platform.os !== "linux" ||
      !["amd64", "arm64"].includes(proof.image.platform.architecture) ||
      !Array.isArray(proof.image.rootfs) ||
      proof.image.rootfs.length < 1 ||
      proof.image.rootfs.some((digest) => !sha256Pattern.test(digest)) ||
      !exactKeys(proof.archive, [
        "bytes",
        "format",
        "identity",
        "path",
        "sha256",
      ]) ||
      proof.archive.format !== "docker-archive" ||
      !Number.isSafeInteger(proof.archive.bytes) ||
      proof.archive.bytes < 1 ||
      !sha256Pattern.test(proof.archive.sha256) ||
      !exactKeys(proof.inputs, ["baseImage", "files"]) ||
      proof.inputs.baseImage !== pinnedBaseImage
    ) {
      return false;
    }
    assertRuntimeSourceProvenance(proof.source);
    assertImageSourceIdentity(proof.image.source);
    assertArchiveIdentity(proof.archive.identity);
    assertImageMatchesSource(proof.image.source, proof.source);
    assertArtifactName(proof.archive.path);
    if (proof.archive.path !== expectedArchiveName) return false;
    assertBindingArray(proof.inputs.files, productionImageInputPaths);
    assertBindingArray(proof.proofClosure, productionImageProofClosurePaths);
    let archivePath;
    if (artifactDirectory) {
      archivePath = path.join(artifactDirectory, proof.archive.path);
      const archive = await regularFileMetadata(archivePath);
      if (
        archive.size !== proof.archive.bytes ||
        (await sha256File(archivePath)) !== proof.archive.sha256
      ) {
        return false;
      }
      const archiveImage = await inspectDockerArchive(
        archivePath,
        proof.image.id,
      );
      if (
        JSON.stringify(archiveImage.identity) !==
          JSON.stringify(proof.archive.identity) ||
        JSON.stringify(archiveImage.platform) !==
          JSON.stringify(proof.image.platform) ||
        JSON.stringify(archiveImage.rootfs) !==
          JSON.stringify(proof.image.rootfs) ||
        JSON.stringify(archiveImage.source) !==
          JSON.stringify(proof.image.source)
      ) {
        return false;
      }
    }
    const [observedSource, expectedInputs, expectedClosure] = await Promise.all([
      inspectSource({ root: projectRoot }),
      sourceBindings(projectRoot, productionImageInputPaths),
      sourceBindings(projectRoot, productionImageProofClosurePaths),
    ]);
    if (
      JSON.stringify(proof.source) !== JSON.stringify(observedSource) ||
      JSON.stringify(proof.inputs.files) !== JSON.stringify(expectedInputs) ||
      JSON.stringify(proof.proofClosure) !== JSON.stringify(expectedClosure)
    ) {
      return false;
    }
    if (archivePath && requireFreshReplay) {
      replayOwnership = await validateArchive(archivePath, proof.image.id, {
        requireAbsent: true,
      });
    }
    const observedImage = await inspectImage(proof.image.id);
    if (JSON.stringify(proof.image) !== JSON.stringify(observedImage)) {
      return false;
    }
    verified = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!verified && typeof replayOwnership?.rollback === "function") {
      try {
        await replayOwnership.rollback();
      } catch {
        // The verifier must not remove an image another actor tagged.
      }
    }
  }
}

async function writeProof(outputPath, proof) {
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(proof) + "\n", "utf8");
    await handle.sync();
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
      throw new Error("Production image provenance arguments are malformed");
    }
    options.set(name, value);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.has("--verify")) {
    const allowExistingImage = options.get("--allow-existing-image");
    const verificationOptionNames = new Set([
      "--allow-existing-image",
      "--artifact-directory",
      "--verify",
    ]);
    if (
      ![2, 3].includes(options.size) ||
      !options.has("--artifact-directory") ||
      [...options.keys()].some((name) => !verificationOptionNames.has(name)) ||
      (options.size === 3 && allowExistingImage !== "true")
    ) {
      throw new Error("Provenance verification arguments are incomplete");
    }
    const proofPath = path.resolve(options.get("--verify"));
    const metadata = await regularFileMetadata(proofPath, maximumProofBytes);
    if (metadata.size > maximumProofBytes)
      throw new Error("Proof is too large");
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    if (
      !(await verifyProductionImageProvenance(proof, {
        artifactDirectory: path.resolve(options.get("--artifact-directory")),
        requireFreshReplay: allowExistingImage !== "true",
      }))
    ) {
      throw new Error("Production image provenance verification failed");
    }
    process.stdout.write("Production image provenance verified\n");
    return;
  }
  const required = ["--archive", "--image-id", "--output"];
  if (
    options.size !== required.length ||
    required.some((key) => !options.has(key))
  ) {
    throw new Error("Provenance creation arguments are incomplete");
  }
  const proof = await createProductionImageProvenance({
    archivePath: path.resolve(options.get("--archive")),
    imageId: options.get("--image-id"),
  });
  if (!(await verifyProductionImageProvenance(proof))) {
    throw new Error(
      "Generated production image provenance did not self-verify",
    );
  }
  await writeProof(path.resolve(options.get("--output")), proof);
  process.stdout.write("Production image provenance recorded\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `[production-image-provenance] ${
        error instanceof Error ? error.message : "Unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  });
}
